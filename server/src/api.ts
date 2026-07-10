import { Router, json } from "express";
import { pool, getConfigValue, setConfigValue } from "./db.js";
import { listRefs, addRef, removeRef, mimeFor } from "../../agents/generator/src/assets.js";
import { agentStatus, setEnabled, runOnce } from "./workers.js";
import { pipelineCounts, listApprovals, resolveApproval, listTickets, createTicket, moveIssueById, commentIssueById, uploadToLinear, fetchLinearAsset, moveTicket, getTicketByIdentifier } from "./linear.js";
import { buildReport, collectAll } from "./report.js";

/**
 * /api — mirrors the desktop app's `window.studio` bridge 1:1 so the same renderer
 * runs in a browser via web/studio-client.js. State lives in Postgres (app_config +
 * tables); reference images and generated slides live on disk under DATA_DIR.
 */
const ALLOWED_SECRETS = ["LINEAR_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "POSTIZ_API_KEY", "DISCORD_WEBHOOK_URL", "REVENUECAT_API_KEY", "REVENUECAT_PROJECT_ID"];
const mask = (v?: string) => (v ? "••••••••" + String(v).slice(-4) : "");
const slug = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "influencer";
const IMG_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export const api = Router();
api.use(json({ limit: "40mb" })); // ref uploads arrive as data URLs

const wrap = (fn: (req: any, res: any) => Promise<unknown>) => (req: any, res: any) =>
  fn(req, res).then((out) => res.json(out ?? true)).catch((e) => res.status(500).json({ error: e instanceof Error ? e.message : String(e) }));

// ---- secrets (env wins; stored fallback in app_config — same trust as a .env) ----
async function secretsMap(): Promise<Record<string, string>> {
  return (await getConfigValue<Record<string, string>>("secrets")) ?? {};
}
api.get("/secrets/status", wrap(async () => {
  const stored = await secretsMap();
  return Object.fromEntries(ALLOWED_SECRETS.map((k) => {
    const v = process.env[k] || stored[k];
    return [k, { set: !!v, masked: mask(v) }];
  }));
}));
api.post("/secrets/set", wrap(async (req) => {
  const { name, value } = req.body || {};
  if (!ALLOWED_SECRETS.includes(name)) throw new Error(`unknown secret: ${name}`);
  const stored = await secretsMap();
  if (value) stored[name] = String(value); else delete stored[name];
  await setConfigValue("secrets", stored);
  const v = process.env[name] || stored[name];
  return { set: !!v, masked: mask(v) };
}));

// ---- config / brief -----------------------------------------------------------
api.get("/config", wrap(async () => (await getConfigValue("config")) ?? {}));
api.post("/config", wrap(async (req) => {
  const cur = (await getConfigValue<Record<string, unknown>>("config")) ?? {};
  const next = { ...cur, ...(req.body || {}) };
  await setConfigValue("config", next);
  return next;
}));
api.get("/brief", wrap(async () => (await getConfigValue("brief")) ?? {}));
api.post("/brief", wrap(async (req) => { await setConfigValue("brief", req.body || {}); }));

// ---- influencers ----------------------------------------------------------------
api.get("/influencers", wrap(async () => {
  const { rows } = await pool.query("SELECT id, name, postiz_integration_id, timeslots, enabled, profile, design FROM influencers ORDER BY created_at");
  return rows.map((r) => ({
    id: r.id, name: r.name, postizIntegrationId: r.postiz_integration_id || "",
    timeslots: r.timeslots || [], enabled: !!r.enabled,
    profile: r.profile === "graphic" ? "graphic" : "ugc", design: r.design || undefined,
  }));
}));
api.post("/influencers", wrap(async (req) => {
  const list: any[] = Array.isArray(req.body) ? req.body : [];
  const clean = list.filter((i) => i && i.name).map((i) => ({
    id: i.id || slug(i.name),
    name: String(i.name),
    postizIntegrationId: i.postizIntegrationId || "",
    timeslots: Array.isArray(i.timeslots) ? [...new Set(i.timeslots.filter((t: string) => /^\d{1,2}:\d{2}$/.test(t)))].sort() : [],
    enabled: i.enabled !== false,
    profile: i.profile === "graphic" ? "graphic" : "ugc",
    design: i.design && typeof i.design === "object" ? i.design : null,
  }));
  for (const i of clean) {
    await pool.query(
      `INSERT INTO influencers (id, name, postiz_integration_id, timeslots, enabled, profile, design)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET name=$2, postiz_integration_id=$3, timeslots=$4, enabled=$5, profile=$6, design=$7`,
      [i.id, i.name, i.postizIntegrationId, i.timeslots, i.enabled, i.profile, i.design ? JSON.stringify(i.design) : null],
    );
  }
  // removed from the roster: delete if unreferenced, else keep-but-disable (posts FK)
  const keep = clean.map((i) => i.id);
  const { rows: gone } = await pool.query(
    keep.length ? `SELECT id FROM influencers WHERE NOT (id = ANY($1))` : `SELECT id FROM influencers`,
    keep.length ? [keep] : [],
  );
  for (const g of gone) {
    try { await pool.query("DELETE FROM influencers WHERE id = $1", [g.id]); }
    catch { await pool.query("UPDATE influencers SET enabled = false WHERE id = $1", [g.id]); }
  }
  return clean;
}));

// ---- postiz channel list (for the Cast account picker) --------------------------
api.get("/postiz/integrations", wrap(async () => {
  const stored = await secretsMap();
  const key = process.env.POSTIZ_API_KEY || stored.POSTIZ_API_KEY;
  if (!key) return { error: "no POSTIZ_API_KEY" };
  const base = process.env.POSTIZ_API_URL || "https://api.postiz.com/public/v1";
  const res = await fetch(`${base}/integrations`, { headers: { Authorization: key } });
  if (!res.ok) return { error: `Postiz ${res.status}` };
  const data = await res.json();
  const arr = Array.isArray(data) ? data : data.integrations || [];
  return { integrations: arr.map((i: any) => ({ id: i.id, name: i.name || i.username || i.id, platform: i.identifier || i.providerIdentifier || i.platform || "" })) };
}));

// ---- reference images (asset layer: disk or S3/Supabase Storage) ----------------
api.get("/refs/:id", wrap(async (req) => {
  const files = await listRefs(slug(req.params.id));
  return files.map((f) => ({ file: f.name, dataUrl: `data:${mimeFor(f.name)};base64,${f.data.toString("base64")}` }));
}));
api.post("/refs/:id", wrap(async (req) => {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(req.body?.dataUrl || "");
  if (!m) throw new Error("unsupported image");
  const file = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${IMG_EXT[m[1].toLowerCase()] || "png"}`;
  await addRef(slug(req.params.id), file, Buffer.from(m[2], "base64"));
  return { file };
}));
api.post("/refs/:id/remove", wrap(async (req) => {
  await removeRef(slug(req.params.id), String(req.body?.file || ""));
}));

// ---- agents ----------------------------------------------------------------------
api.get("/agents", wrap(async () => agentStatus()));
api.post("/agents/:id/enabled", wrap(async (req) => setEnabled(req.params.id, !!req.body?.enabled)));
api.post("/agents/:id/run-once", wrap(async (req) => runOnce(req.params.id)));

// ---- approvals (Linear) -----------------------------------------------------------
api.get("/approvals", wrap(async () => {
  try { return await listApprovals(); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}));
api.post("/approvals/:id/resolve", wrap(async (req) => {
  await resolveApproval(req.params.id, req.body?.decision === "approve" ? "approve" : "reject");
}));

// ---- board (browse/act on Linear tickets without opening Linear) -------------------
api.get("/board", wrap(async (req) => {
  const states = String(req.query.states || "").split(",").map((s: string) => s.trim()).filter(Boolean);
  if (!states.length) throw new Error("states query param required");
  return listTickets(states);
}));
api.post("/board/create", wrap(async (req) => {
  const { title, details, count, graphic, images } = req.body || {};
  if (!title) throw new Error("title required");
  const lines: string[] = [];
  if (graphic) lines.push("Profile: graphic");
  lines.push(`Variations to create: ${Math.max(1, Math.min(8, Number(count) || 3))}`, "");
  if (details) lines.push(String(details), "");
  for (const dataUrl of (Array.isArray(images) ? images : []).slice(0, 8)) {
    const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(String(dataUrl));
    if (!m) continue;
    const url = await uploadToLinear(`ref-${Date.now()}.${IMG_EXT[m[1].toLowerCase()] || "png"}`, m[1], Buffer.from(m[2], "base64"));
    lines.push(`![reference](${url})`);
  }
  return createTicket(String(title), lines.join("\n"), "Generation Queue");
}));
api.post("/board/:id/move", wrap(async (req) => {
  if (!req.body?.state) throw new Error("state required");
  await moveIssueById(req.params.id, String(req.body.state));
}));
api.post("/board/:id/comment", wrap(async (req) => {
  if (!req.body?.body) throw new Error("body required");
  await commentIssueById(req.params.id, String(req.body.body));
}));
// authenticated image proxy: Linear-hosted assets need the API key to fetch
api.get("/asset", (req: any, res: any) => {
  fetchLinearAsset(String(req.query.url || ""))
    .then(({ contentType, data }) => { res.set("Content-Type", contentType).set("Cache-Control", "private, max-age=3600").send(data); })
    .catch((e) => res.status(400).json({ error: e instanceof Error ? e.message : String(e) }));
});

api.get("/ticket/:id", wrap(async (req) => getTicketByIdentifier(req.params.id)));

// ---- calendar (scheduled posts + mark published) ----------------------------------
// Postiz is the source of truth for what's actually scheduled; we enrich each post
// with our ticket/hook (matched on the Postiz post id) and prefer our locally-marked
// published/error status. Falls back to the posts table if Postiz is unreachable.
api.get("/calendar", wrap(async (req) => {
  const start = String(req.query.start || "");
  const end = String(req.query.end || "");
  if (!start || !end) throw new Error("start + end query params required (ISO)");

  const { rows } = await pool.query(
    `SELECT p.id, p.ticket, coalesce(i.name, p.influencer_id) AS account, h.text AS hook,
            p.scheduled_at, p.status, p.release_url
     FROM posts p LEFT JOIN influencers i ON i.id = p.influencer_id
     LEFT JOIN hooks h ON h.id = p.hook_id
     WHERE p.scheduled_at >= $1 AND p.scheduled_at < $2`,
    [start, end],
  );
  const byId = new Map(rows.map((r) => [String(r.id), r]));

  const stored = await secretsMap();
  const key = process.env.POSTIZ_API_KEY || stored.POSTIZ_API_KEY;
  if (key) {
    try {
      const base = process.env.POSTIZ_API_URL || "https://api.postiz.com/public/v1";
      const res = await fetch(`${base}/posts?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`, { headers: { Authorization: key } });
      if (res.ok) {
        const data = await res.json();
        const list: any[] = Array.isArray(data) ? data : data.posts || [];
        return list.map((p) => {
          const mine = byId.get(String(p.id));
          const st = String(p.state || "").toUpperCase();
          const status = mine && (mine.status === "published" || mine.status === "error")
            ? mine.status
            : st === "PUBLISHED" ? "published" : st === "ERROR" ? "error" : st === "DRAFT" ? "draft" : "scheduled";
          return {
            ticket: mine?.ticket || null,
            account: p.integration?.name || mine?.account || "unknown",
            hook: mine?.hook || "",
            scheduledAt: p.publishDate || mine?.scheduled_at,
            status,
            releaseUrl: p.releaseURL || mine?.release_url || null,
          };
        }).filter((e) => e.scheduledAt);
      }
    } catch { /* fall through to DB */ }
  }
  // no Postiz / unreachable → our own records
  return [...byId.values()].map((r) => ({
    ticket: r.ticket, account: r.account, hook: r.hook || "",
    scheduledAt: r.scheduled_at, status: r.status || "scheduled", releaseUrl: r.release_url || null,
  }));
}));
api.post("/calendar/:ticket/publish", wrap(async (req) => {
  const ticket = req.params.ticket;
  const publish = req.body?.published !== false; // default true; false = revert
  if (publish) {
    await pool.query("UPDATE posts SET status = 'published', posted_at = coalesce(posted_at, now()) WHERE ticket = $1", [ticket]);
    await moveTicket(ticket, "Published").catch(() => {}); // ticket may already be there
  } else {
    await pool.query("UPDATE posts SET status = 'scheduled', posted_at = NULL WHERE ticket = $1", [ticket]);
    await moveTicket(ticket, "Drafted").catch(() => {});
  }
  return { ok: true, status: publish ? "published" : "scheduled" };
}));

// ---- daily growth report -----------------------------------------------------------
api.get("/report", wrap(async () => buildReport()));
api.post("/report/collect", wrap(async () => {
  const notes = await collectAll();
  return { notes, report: await buildReport() };
}));

// ---- pipeline overview -------------------------------------------------------------
api.get("/pipeline/counts", wrap(async () => {
  try { return { counts: await pipelineCounts() }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}));
api.get("/pipeline/stats", wrap(async () => {
  const [hooks, posts, metrics, lastRun, cfg, infs, upcoming] = await Promise.all([
    pool.query("SELECT count(*)::int AS n FROM hooks"),
    pool.query("SELECT count(*)::int AS n FROM posts"),
    pool.query("SELECT count(*)::int AS n FROM account_metrics"),
    getConfigValue<string>("state:autopilotLastRun"),
    getConfigValue<Record<string, unknown>>("config"),
    pool.query("SELECT name FROM influencers WHERE enabled ORDER BY created_at"),
    pool.query(`SELECT p.ticket, coalesce(i.name, p.influencer_id) AS account, p.scheduled_at
                FROM posts p LEFT JOIN influencers i ON i.id = p.influencer_id
                WHERE p.status = 'scheduled' AND p.scheduled_at > now()
                ORDER BY p.scheduled_at LIMIT 5`),
  ]);
  return {
    hooks: hooks.rows[0].n,
    posts: posts.rows[0].n,
    metricSamples: metrics.rows[0].n,
    lastRun: lastRun || null,
    autopilotTimes: (cfg?.autopilotTimes as string[]) || [],
    reportTime: (cfg?.reportTime as string) || "08:00",
    imageModel: cfg?.imageModel === "openai" ? "GPT Image" : "Nano Banana Pro",
    influencers: infs.rows.map((r) => r.name),
    upcoming: upcoming.rows.map((r) => ({ ticket: r.ticket, account: r.account, scheduledAt: r.scheduled_at })),
  };
}));
