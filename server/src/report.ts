import { pool, getConfigValue, setConfigValue } from "./db.js";
import { pullChannelAnalytics } from "../../agents/generator/src/analytics.js";
import { loadInfluencers } from "../../agents/generator/src/influencers.js";
import { notify } from "../../agents/generator/src/notify.js";

/**
 * Daily growth report (docs/ATTRIBUTION.md layer 3a): collect RevenueCat business
 * metrics + Postiz channel metrics into the metrics tables once a day, build a
 * report (deltas + content activity), and post a Discord digest. Runs on the
 * SERVER's clock (config.reportTime, default 08:00) so it works even with all
 * agents off. The Report tab computes live from the same buildReport().
 */
const RC_BASE = "https://api.revenuecat.com/v2";
const today = () => new Date().toISOString().slice(0, 10);

async function secret(name: string): Promise<string> {
  if (process.env[name]) return process.env[name]!;
  const stored = (await getConfigValue<Record<string, string>>("secrets")) ?? {};
  return stored[name] || "";
}

// ---- collectors -----------------------------------------------------------------

/** RevenueCat metrics overview → app_metrics (one row per metric per day). */
export async function collectRevenueCat(): Promise<string> {
  const key = await secret("REVENUECAT_API_KEY");
  const project = await secret("REVENUECAT_PROJECT_ID");
  if (!key || !project) return "RevenueCat not configured (REVENUECAT_API_KEY + REVENUECAT_PROJECT_ID)";
  const res = await fetch(`${RC_BASE}/projects/${project}/metrics/overview`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`RevenueCat → ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const metrics: { id: string; value: number }[] = Array.isArray(data?.metrics)
    ? data.metrics.filter((m: any) => m?.id && typeof m.value === "number")
    : [];
  for (const m of metrics) {
    await pool.query(
      `INSERT INTO app_metrics (label, value, date) VALUES ($1, $2, $3)
       ON CONFLICT (label, date) DO UPDATE SET value = EXCLUDED.value, captured_at = now()`,
      [`rc_${m.id}`, m.value, today()],
    );
  }
  return `${metrics.length} RevenueCat metric(s) stored`;
}

export async function collectAll(): Promise<string[]> {
  const notes: string[] = [];
  try { notes.push(await collectRevenueCat()); }
  catch (e) { notes.push(`RevenueCat failed: ${e instanceof Error ? e.message : String(e)}`); }
  try {
    const influencers = (await loadInfluencers()).filter((i) => i.enabled);
    notes.push(`channels: ${await pullChannelAnalytics(influencers)}`);
  } catch (e) { notes.push(`channel analytics failed: ${e instanceof Error ? e.message : String(e)}`); }
  await setConfigValue("state:lastCollected", new Date().toISOString());
  return notes;
}

// ---- report ----------------------------------------------------------------------

type Metric = { label: string; value: number; d1: number | null; d7: number | null; d30: number | null };

/** value + deltas vs ~1/7/30 days ago (nearest older sample) for one label's series. */
function deltasFor(rows: { value: number; date: string }[]): Omit<Metric, "label"> {
  const samples = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const latest = samples[samples.length - 1];
  const at = (daysBack: number): number | null => {
    const target = new Date(latest.date + "T00:00:00Z");
    target.setUTCDate(target.getUTCDate() - daysBack);
    const t = target.toISOString().slice(0, 10);
    const older = [...samples].reverse().find((s) => s.date <= t);
    return older && older.date !== latest.date ? older.value : null;
  };
  const d = (v: number | null) => (v == null ? null : latest.value - v);
  return { value: latest.value, d1: d(at(1)), d7: d(at(7)), d30: d(at(30)) };
}

function seriesByLabel(rows: { label: string; value: number; date: string }[]): Metric[] {
  const byLabel = new Map<string, { value: number; date: string }[]>();
  for (const r of rows) (byLabel.get(r.label) ?? byLabel.set(r.label, []).get(r.label)!).push(r);
  return [...byLabel.entries()].map(([label, s]) => ({ label, ...deltasFor(s) }));
}

export async function buildReport() {
  const [app, chan, posts7, published7, perAcct, hooks7, recent, lastCollected, cfg] = await Promise.all([
    pool.query("SELECT label, value::float AS value, date::text AS date FROM app_metrics ORDER BY date"),
    pool.query(`SELECT m.influencer_id AS iid, i.name AS iname, m.label AS label, m.value::float AS value, m.date::text AS date
                FROM account_metrics m JOIN influencers i ON i.id = m.influencer_id ORDER BY m.date`),
    pool.query("SELECT count(*)::int AS n FROM posts WHERE created_at > now() - interval '7 days'"),
    pool.query("SELECT count(*)::int AS n FROM posts WHERE status = 'published' AND posted_at > now() - interval '7 days'"),
    pool.query(`SELECT influencer_id AS iid, count(*)::int AS posts,
                       count(*) FILTER (WHERE status = 'published')::int AS published,
                       max(scheduled_at) AS last
                FROM posts WHERE created_at > now() - interval '7 days' GROUP BY 1`),
    pool.query("SELECT count(*)::int AS n FROM hooks WHERE created_at > now() - interval '7 days'"),
    pool.query(`SELECT p.ticket, coalesce(i.name, p.influencer_id) AS account, h.text AS hook,
                       p.scheduled_at, p.created_at, p.status, p.release_url
                FROM posts p LEFT JOIN influencers i ON i.id = p.influencer_id
                LEFT JOIN hooks h ON h.id = p.hook_id ORDER BY p.created_at DESC LIMIT 8`),
    getConfigValue<string>("state:lastCollected"),
    getConfigValue<Record<string, unknown>>("config"),
  ]);

  // group channel metrics per influencer + attach their 7-day content activity
  const posts = new Map<string, { posts: number; published: number; last: string | null }>(
    perAcct.rows.map((r) => [r.iid, { posts: r.posts, published: r.published, last: r.last }]),
  );
  const chanByInf = new Map<string, { name: string; rows: { label: string; value: number; date: string }[] }>();
  for (const r of chan.rows) {
    const g = chanByInf.get(r.iid) ?? chanByInf.set(r.iid, { name: r.iname, rows: [] }).get(r.iid)!;
    g.rows.push({ label: r.label, value: r.value, date: r.date });
  }
  const influencers = [...chanByInf.entries()].map(([iid, g]) => ({
    id: iid, name: g.name,
    metrics: seriesByLabel(g.rows),
    posts7d: posts.get(iid)?.posts ?? 0,
    published7d: posts.get(iid)?.published ?? 0,
  }));

  return {
    business: seriesByLabel(app.rows),
    influencers,
    content: {
      posts7d: posts7.rows[0].n,
      published7d: published7.rows[0].n,
      hooks7d: hooks7.rows[0].n,
      byAccount: [...posts.entries()].map(([iid, p]) => ({ name: chanByInf.get(iid)?.name || iid, posts: p.posts, last: p.last })).sort((a, b) => b.posts - a.posts),
      recentPosts: recent.rows.map((r) => ({
        ticket: r.ticket, account: r.account, hook: r.hook || "", scheduledAt: r.scheduled_at,
        status: r.status || "scheduled", releaseUrl: r.release_url || null,
      })),
    },
    meta: {
      lastCollected: lastCollected || null,
      reportTime: (cfg?.reportTime as string) || "08:00",
      revenuecatConfigured: !!(await secret("REVENUECAT_API_KEY")) && !!(await secret("REVENUECAT_PROJECT_ID")),
    },
  };
}

// ---- daily digest ------------------------------------------------------------------

const RC_NAMES: Record<string, string> = {
  rc_mrr: "MRR", rc_active_trials: "Active trials", rc_active_subscriptions: "Active subs",
  rc_new_customers: "New customers", rc_revenue: "Revenue (28d)", rc_active_users: "Active users",
};
const fmtDelta = (d: number | null) => (d == null ? "" : ` (${d >= 0 ? "+" : ""}${Math.round(d * 100) / 100})`);

async function sendDigest(): Promise<void> {
  if (!process.env.DISCORD_WEBHOOK_URL) process.env.DISCORD_WEBHOOK_URL = await secret("DISCORD_WEBHOOK_URL");
  const r = await buildReport();
  const biz = r.business
    .map((m) => `${RC_NAMES[m.label] || m.label}: **${m.value}**${fmtDelta(m.d1)}`)
    .join(" · ") || "no RevenueCat data yet";
  const followers = r.influencers
    .map((inf) => { const f = inf.metrics.find((m) => /Followers/i.test(m.label)); return f ? `${inf.name}: **${f.value}**${fmtDelta(f.d7 ?? f.d1)}` : null; })
    .filter(Boolean)
    .join(" · ") || "no channel data yet";
  notify("info", "📊 Daily report", {
    detail: [
      `**Business (Δ vs yesterday)**\n${biz}`,
      `**Followers (Δ 7d)**\n${followers}`,
      `**Content (7d)**\n${r.content.posts7d} post(s) scheduled · ${r.content.hooks7d} hook(s) written` +
        (r.content.byAccount.length ? ` — ${r.content.byAccount.map((a) => `${a.name}: ${a.posts}`).join(", ")}` : ""),
      r.meta.revenuecatConfigured ? "" : "_RevenueCat not configured — add REVENUECAT_API_KEY + REVENUECAT_PROJECT_ID in Settings._",
    ].filter(Boolean).join("\n\n"),
  });
}

// ---- the clock ----------------------------------------------------------------------

export function startReportClock(): void {
  setInterval(async () => {
    try {
      const cfg = (await getConfigValue<Record<string, unknown>>("config")) ?? {};
      const t = typeof cfg.reportTime === "string" && /^\d{1,2}:\d{2}$/.test(cfg.reportTime) ? cfg.reportTime : "08:00";
      const [h, m] = t.split(":").map(Number);
      const due = new Date(); due.setHours(h, m, 0, 0);
      if (due.getTime() > Date.now()) due.setDate(due.getDate() - 1); // most recent occurrence
      const last = await getConfigValue<string>("state:reportLastRun");
      if (last && new Date(last).getTime() >= due.getTime()) return;
      await setConfigValue("state:reportLastRun", new Date().toISOString()); // claim first — a failure shouldn't hot-loop
      console.log("📊 daily report run");
      for (const note of await collectAll()) console.log("  " + note);
      await sendDigest();
    } catch (e) {
      console.error("report clock error:", e instanceof Error ? e.message : String(e));
    }
  }, 60_000);
}
