import { pool, getConfigValue } from "./db.js";
import { moveTicket, commentTicket } from "./linear.js";
import { notify } from "../../agents/generator/src/notify.js";

/**
 * Publish tracker: polls Postiz for the state of scheduled posts and closes the
 * loop automatically — no more manually dragging tickets to Published.
 *
 *   Postiz state PUBLISHED → posts.status='published' (+posted_at, release_url),
 *                            Linear ticket → "Published", Discord 🚀
 *   Postiz state ERROR     → posts.status='error', Discord alert, ticket stays put
 *
 * Semantics note (UPLOAD mode): Postiz "PUBLISHED" means it delivered the post to
 * the account's TikTok inbox at the slot time — the final tap happens in the TikTok
 * app. That delivery is the automatable milestone, and the comment says so.
 */
const POSTIZ_BASE = process.env.POSTIZ_API_URL || "https://api.postiz.com/public/v1";

async function postizKey(): Promise<string> {
  if (process.env.POSTIZ_API_KEY) return process.env.POSTIZ_API_KEY;
  const stored = (await getConfigValue<Record<string, string>>("secrets")) ?? {};
  return stored.POSTIZ_API_KEY || "";
}

async function checkPending(): Promise<void> {
  const { rows: pending } = await pool.query(
    `SELECT id, ticket, scheduled_at FROM posts
     WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at < now()`,
  );
  if (!pending.length) return;
  const apiKey = await postizKey();
  if (!apiKey) return;

  // one window query covering everything pending
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
    if (!remote) continue; // not in window / unknown — try again next tick
    const state = String(remote.state || "").toUpperCase();
    if (state === "PUBLISHED") {
      const releaseUrl = remote.releaseURL || null;
      await pool.query(
        "UPDATE posts SET status='published', posted_at=$2, release_url=$3 WHERE id=$1",
        [p.id, remote.publishDate ? new Date(remote.publishDate) : new Date(), releaseUrl],
      );
      await moveTicket(p.ticket, "Published").catch((e) => console.error(`tracker: move ${p.ticket}:`, e.message));
      await commentTicket(p.ticket,
        `🚀 Delivered by Postiz${releaseUrl ? ` — ${releaseUrl}` : ""} (UPLOAD mode: it's in the account's TikTok inbox; finish + publish in the app if you haven't).`,
      ).catch(() => {});
      notify("success", `🚀 Published — ${p.ticket}`, {
        detail: `Postiz delivered the post${releaseUrl ? `: ${releaseUrl}` : ""}. Ticket moved to Published.`,
      });
      console.log(`tracker: ${p.ticket} → published`);
    } else if (state === "ERROR") {
      await pool.query("UPDATE posts SET status='error' WHERE id=$1", [p.id]);
      notify("error", `📮 Postiz delivery FAILED — ${p.ticket}`, {
        detail: "Postiz reports state ERROR for this post. Check the channel connection in Postiz and re-schedule.",
      });
      console.log(`tracker: ${p.ticket} → error`);
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
      await checkPending();
    } catch (e) {
      console.error("tracker error:", e instanceof Error ? e.message : String(e));
    }
  }, 15 * 60_000);
}
