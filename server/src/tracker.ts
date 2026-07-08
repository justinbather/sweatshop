import { pool, getConfigValue } from "./db.js";
import { moveTicket, commentTicket } from "./linear.js";
import { notify } from "../../agents/generator/src/notify.js";
import { pullChannelAnalytics } from "../../agents/generator/src/analytics.js";
import { loadInfluencers } from "../../agents/generator/src/influencers.js";

/**
 * Two-stage publish tracker (every 15 min):
 *
 *   1. DELIVERY — Postiz post state PUBLISHED means it dropped the post in the
 *      account's TikTok inbox → posts.status='delivered' (+delivered_at,
 *      release_url, videos_baseline), Linear ticket → "Published", Discord 📬.
 *      State ERROR → status='error' + Discord alert.
 *
 *   2. LIVE CONFIRMATION — the final tap happens inside the TikTok app, invisible
 *      to any API. Proxy signal: the account's "Videos" count (channel analytics).
 *      When it rises above a post's delivery-time baseline, delivered posts are
 *      promoted to status='published' (+posted_at) OLDEST-FIRST — the explicit
 *      assumption is that inbox drafts get posted in order. Rough by design, but
 *      it gives real posted_at timestamps for trials-per-post correlation.
 */
const POSTIZ_BASE = process.env.POSTIZ_API_URL || "https://api.postiz.com/public/v1";

async function postizKey(): Promise<string> {
  if (process.env.POSTIZ_API_KEY) return process.env.POSTIZ_API_KEY;
  const stored = (await getConfigValue<Record<string, string>>("secrets")) ?? {};
  return stored.POSTIZ_API_KEY || "";
}

async function videosCount(influencerId: string): Promise<number | null> {
  const { rows } = await pool.query(
    "SELECT value::float AS c FROM account_metrics WHERE influencer_id=$1 AND label='Videos' ORDER BY date DESC LIMIT 1",
    [influencerId],
  );
  return rows[0]?.c ?? null;
}

// ---- stage 1: Postiz delivery ----------------------------------------------------

async function checkDeliveries(): Promise<void> {
  const { rows: pending } = await pool.query(
    `SELECT id, ticket, influencer_id, scheduled_at FROM posts
     WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at < now()`,
  );
  if (!pending.length) return;
  const apiKey = await postizKey();
  if (!apiKey) return;

  const dates = pending.map((p) => new Date(p.scheduled_at).getTime());
  const start = new Date(Math.min(...dates) - 86400_000).toISOString();
  const end = new Date(Date.now() + 86400_000).toISOString();
  const res = await fetch(`${POSTIZ_BASE}/posts?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`, {
    headers: { Authorization: apiKey },
  });
  if (!res.ok) { console.error(`tracker: Postiz /posts → ${res.status}`); return; }
  const data = await res.json();
  const list: any[] = Array.isArray(data) ? data : data.posts || [];
  const byId = new Map(list.map((p) => [String(p.id), p]));

  for (const p of pending) {
    const remote = byId.get(String(p.id));
    if (!remote) continue; // unknown yet — next tick
    const state = String(remote.state || "").toUpperCase();
    if (state === "PUBLISHED") {
      const releaseUrl = remote.releaseURL || null;
      const baseline = await videosCount(p.influencer_id);
      await pool.query(
        "UPDATE posts SET status='delivered', delivered_at=now(), release_url=$2, videos_baseline=$3 WHERE id=$1",
        [p.id, releaseUrl, baseline],
      );
      await moveTicket(p.ticket, "Published").catch((e) => console.error(`tracker: move ${p.ticket}:`, e.message));
      await commentTicket(p.ticket,
        "📬 Delivered to the account's TikTok inbox by Postiz — finish + publish in the app. (Auto-confirms as live when the account's video count ticks up.)",
      ).catch(() => {});
      notify("success", `📬 Delivered — ${p.ticket}`, {
        detail: "In the TikTok inbox now — finish overlays + publish in the app.",
      });
      console.log(`tracker: ${p.ticket} → delivered`);
    } else if (state === "ERROR") {
      await pool.query("UPDATE posts SET status='error' WHERE id=$1", [p.id]);
      notify("error", `📮 Postiz delivery FAILED — ${p.ticket}`, {
        detail: "Postiz reports state ERROR for this post. Check the channel connection in Postiz and re-schedule.",
      });
      console.log(`tracker: ${p.ticket} → error`);
    }
  }
}

// ---- stage 2: live confirmation via video counts -----------------------------------

async function confirmPublished(): Promise<void> {
  const { rows: pending } = await pool.query(
    `SELECT id, ticket, influencer_id, videos_baseline FROM posts
     WHERE status = 'delivered' ORDER BY delivered_at ASC NULLS LAST`,
  );
  if (!pending.length) return;

  // refresh channel analytics for the affected accounts so today's count is fresh
  const infIds = [...new Set(pending.map((p) => p.influencer_id).filter(Boolean))];
  try {
    const influencers = (await loadInfluencers()).filter((i) => infIds.includes(i.id));
    await pullChannelAnalytics(influencers);
  } catch { /* stale counts are still usable */ }

  for (const infId of infIds) {
    const current = await videosCount(infId);
    if (current == null) continue;
    const mine = pending.filter((p) => p.influencer_id === infId);

    // posts delivered before we had a count: baseline = current (future increments promote them)
    for (const p of mine.filter((p) => p.videos_baseline == null)) {
      await pool.query("UPDATE posts SET videos_baseline=$2 WHERE id=$1", [p.id, current]);
      p.videos_baseline = current;
    }

    // increments since the oldest pending baseline = how many went live; promote in order
    const base = Math.min(...mine.map((p) => Number(p.videos_baseline)));
    let promotable = Math.max(0, Math.floor(current - base));
    for (const p of mine) {
      if (promotable <= 0) break;
      await pool.query("UPDATE posts SET status='published', posted_at=now() WHERE id=$1", [p.id]);
      promotable--;
      await commentTicket(p.ticket, "✅ Confirmed live — the account's video count incremented (order-based match; rough by design).").catch(() => {});
      notify("success", `✅ Live on TikTok — ${p.ticket}`, {
        detail: "The account's video count incremented — counting this post as published (order-based match).",
      });
      console.log(`tracker: ${p.ticket} → published (video count)`);
    }
  }
}

export function startPublishTracker(): void {
  setInterval(async () => {
    try {
      if (!process.env.DISCORD_WEBHOOK_URL) {
        const stored = (await getConfigValue<Record<string, string>>("secrets")) ?? {};
        if (stored.DISCORD_WEBHOOK_URL) process.env.DISCORD_WEBHOOK_URL = stored.DISCORD_WEBHOOK_URL;
      }
      await checkDeliveries();
      await confirmPublished();
    } catch (e) {
      console.error("tracker error:", e instanceof Error ? e.message : String(e));
    }
  }, 15 * 60_000);
}
