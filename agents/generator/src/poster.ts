import { listSlides, type AssetFile } from "./assets";
import type { Issue } from "@linear/sdk";
import { Board } from "./linear";
import { loadSecrets } from "./secrets";
import { loadInfluencers, claimSlot, type Influencer } from "./influencers";
import { notify } from "./notify";
import { recordPost } from "./store";

/**
 * Poster agent (DRAFT mode). Watches `Posting Queue` (where the Creator drops
 * finished posts), preps a TikTok draft in Postiz, and moves the ticket to
 * `Drafted`. The real review gate is TikTok itself: with content_posting_method
 * UPLOAD the slides land in your TikTok app inbox (a draft, never a live post) —
 * you add the on-screen captions + app screenshot and publish from there.
 *
 *   Posting Queue ──[Poster → Postiz UPLOAD]──► Drafted
 *                                                  └─ finish overlays + publish
 *                                                     in the TikTok app → Published.
 *
 * Idempotency guard: never re-creates a draft for a ticket that already has one.
 *
 * Create a `Posting Queue` and a `Drafted` column in Linear before enabling this.
 */
const STATES = {
  queue: "Posting Queue",
  working: "Posting", // optional working state; best-effort claim
  drafted: "Drafted",
  review: "Ready to Post", // incomplete sets get bounced back here to fix/regenerate
};

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (env or ~/.sweatshop/secrets.json).`);
  return v;
}

type Post = { caption: string; hashtags: string; onScreen: string; conceptId: string | null; influencerId: string | null; hookId: string | null; expectedSlides: number; images: AssetFile[] };

// Parse the post ticket the Creator wrote (buildPostDescription format); slides
// come from the asset layer (disk or S3).
async function parsePost(issue: Issue): Promise<Post> {
  const d = issue.description ?? "";
  const caption = (/\*\*Caption\*\*\s*\n+([\s\S]*?)(?:\n\s*\n|\n\*\*|$)/.exec(d)?.[1] || "").trim();
  const hashtags = (/\*\*Hashtags\*\*\s*\n+(.+)/.exec(d)?.[1] || "").trim();
  // the per-slide on-screen text block (between the header and the Slides section)
  const onScreen = (/\*\*On-screen captions\*\*[^\n]*\n+([\s\S]*?)(?:\n\s*\*\*Slides|$)/.exec(d)?.[1] || "").trim();
  // tolerate Linear's markdown rewrites: **CON-66**, [CON-66](url), or bare CON-66
  const conceptId = /From concept\W*(CON-\d+)/.exec(d)?.[1] || null;
  // plain tag first; fall back to the old markdown form (Linear stores it as *Influencer **id***)
  const influencerId = /Influencer-ID:\s*([\w-]+)/.exec(d)?.[1] || /Influencer \*\*([\w-]+)\*\*/.exec(d)?.[1] || null;
  const hookId = /Hook-ID:\s*(h_\w+)/.exec(d)?.[1] || null;
  const expectedSlides = Number(/Slides:\s*(\d+)/.exec(d)?.[1] || 0);
  const images: AssetFile[] = conceptId && influencerId ? await listSlides(conceptId, influencerId) : [];
  return { caption, hashtags, onScreen, conceptId, influencerId, hookId, expectedSlides, images };
}

// The TikTok draft description: caption, the per-slide on-screen text (so it's on
// hand to overlay in the app), then hashtags.
function draftContent(post: Post): string {
  return [
    post.caption.trim(),
    post.onScreen ? `On-screen text:\n${post.onScreen}` : "",
    post.hashtags.trim(),
  ].filter(Boolean).join("\n\n");
}

// Idempotency: never re-schedule a ticket that was already handled.
async function alreadyDrafted(issue: Issue): Promise<boolean> {
  try {
    const cm = await issue.comments();
    return cm.nodes.some((n) => /✅ (Scheduled|Draft created)/.test(n.body || ""));
  } catch { return false; }
}

// ---- Postiz API -------------------------------------------------------------
// Hosted default; override with POSTIZ_API_URL for a self-hosted instance.
const POSTIZ_BASE = process.env.POSTIZ_API_URL || "https://api.postiz.com/public/v1";

async function postizJson(path: string, apiKey: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${POSTIZ_BASE}${path}`, {
    ...init,
    headers: { Authorization: apiKey, ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`Postiz ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function uploadMedia(apiKey: string, file: AssetFile): Promise<{ id: string; path: string }> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file.data)]), file.name);
  const res = await fetch(`${POSTIZ_BASE}/upload`, { method: "POST", headers: { Authorization: apiKey }, body: form });
  if (!res.ok) throw new Error(`Postiz /upload → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Upload the slides and SCHEDULE a TikTok draft to the influencer's mapped account
// for its next open slot. With content_posting_method UPLOAD, at that time Postiz
// delivers it to the TikTok app inbox (never a live post) — you finish overlays +
// publish there.
async function schedulePost(post: Post, inf: Influencer): Promise<{ id: string; when: Date } | null> {
  const apiKey = process.env.POSTIZ_API_KEY;
  if (!apiKey) return null; // stub mode
  if (!inf.postizIntegrationId) throw new Error(`no Postiz account mapped for ${inf.name} — set it on the Cast tab`);

  const image: { id: string; path: string }[] = [];
  for (const file of post.images) image.push(await uploadMedia(apiKey, file));

  const when = await claimSlot(inf); // next open slot for this influencer
  const body = {
    type: "schedule",
    date: when.toISOString(),
    shortLink: false,
    tags: [],
    posts: [
      {
        integration: { id: inf.postizIntegrationId },
        value: [{ content: draftContent(post), image }],
        settings: {
          __type: "tiktok",
          title: (post.caption || "").replace(/\s+/g, " ").trim().slice(0, 90),
          privacy_level: "PUBLIC_TO_EVERYONE", // post to everyone
          duet: false,
          stitch: false,
          comment: true,
          autoAddMusic: "yes", // photo slideshows need a track
          brand_content_toggle: false,
          brand_organic_toggle: false,
          video_made_with_ai: false, // flip to true for TikTok's AI-content disclosure
          content_posting_method: "UPLOAD", // deliver to the TikTok inbox to finish overlays + publish there
        },
      },
    ],
  };
  const created = await postizJson("/posts", apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const id = created?.[0]?.id || created?.id || created?.postId || "created";
  return { id: String(id), when };
}

async function processQueue(board: Board): Promise<void> {
  const tickets = await board.queue(STATES.queue);
  if (tickets.length === 0) {
    console.log(`· ${STATES.queue} empty`);
    return;
  }
  await loadSecrets(); // pick up a POSTIZ key saved after the worker started
  const hasKey = !!process.env.POSTIZ_API_KEY;
  const byId = new Map((await loadInfluencers()).map((i) => [i.id, i]));
  for (const issue of tickets) {
    console.log(`→ ${issue.identifier}  ${issue.title}`);
    try {
      if (await alreadyDrafted(issue)) {
        console.log("  already scheduled — moving to Drafted");
        await board.move(issue.id, STATES.drafted);
        continue;
      }
      await board.move(issue.id, STATES.working).catch(() => {}); // best-effort claim
      const post = await parsePost(issue);
      const inf = post.influencerId ? byId.get(post.influencerId) : undefined;
      if (!inf) {
        await board.comment(issue.id, `⚠️ Couldn't resolve the influencer for this post (${post.influencerId ?? "no tag"}). Add/enable them on the Cast tab, then re-queue.`);
        await board.move(issue.id, STATES.drafted);
        continue;
      }
      // never post an incomplete set — bounce it back to review to regenerate the missing slide(s)
      if (post.expectedSlides && post.images.length < post.expectedSlides) {
        await board.comment(issue.id, `⚠️ Only ${post.images.length}/${post.expectedSlides} images generated — not scheduling. Regenerate the missing slide(s), then re-approve into ${STATES.queue}.`);
        notify("warn", `📮 Bounced — ${issue.identifier}: ${post.images.length}/${post.expectedSlides} images`, {
          url: issue.url, detail: `Sent back to ${STATES.review} — regen the missing slide(s), then re-approve.`,
        });
        await board.move(issue.id, STATES.review);
        continue;
      }

      const result = await schedulePost(post, inf);
      if (result) {
        // the store is how analytics later joins posts ↔ hooks ↔ influencers
        await recordPost({
          id: result.id,
          ticket: issue.identifier,
          conceptId: post.conceptId ?? undefined,
          hookId: post.hookId ?? undefined,
          influencerId: inf.id,
          scheduledAt: result.when.toISOString(),
        });
        await board.comment(issue.id, `✅ Scheduled to **${inf.name}**'s TikTok for ${result.when.toLocaleString()} (Postiz id ${result.id}, ${post.images.length} image(s)). Lands in the TikTok inbox at that time — finish overlays + publish there.`);
        const whenText = result.when.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        notify("success", `✅ Scheduled — ${issue.identifier}`, {
          url: issue.url,
          detail: [
            `**Account:** ${inf.name}`,
            `**Drafts to TikTok inbox:** ${whenText}`,
            `**Post:** "${(post.caption.split("\n")[0] || issue.title).slice(0, 100)}" · ${post.images.length} image(s)`,
            `Finish overlays + publish in the app.`,
          ].join("\n"),
        });
      } else {
        await board.comment(
          issue.id,
          `📮 (stub) ${hasKey ? "Postiz key set — " : "no POSTIZ_API_KEY yet — "}would schedule ${post.images.length} image(s) to **${inf.name}**'s next slot.`,
        );
      }
      await board.move(issue.id, STATES.drafted);
      console.log(`  ✓ ${post.images.length} image(s) → ${inf.name} → ${STATES.drafted}${result ? ` @ ${result.when.toLocaleString()}` : " (stub)"}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ✗ ${msg}`);
      notify("error", `📮 Scheduling failed — ${issue.identifier}`, { url: issue.url, detail: msg });
      // don't auto-retry — leave it out of the queue with the error noted.
      await board.comment(issue.id, `⚠️ Draft prep failed: ${msg}`).catch(() => {});
      await board.move(issue.id, STATES.drafted).catch(() => {});
    }
  }
}

async function main() {
  await loadSecrets();
  const board = new Board(requireEnv("LINEAR_API_KEY"));
  const teamKey = flag("team") ?? process.env.LINEAR_TEAM ?? "CON";
  await board.init(teamKey);
  console.log(`Connected to team ${teamKey}`);

  if (has("check")) {
    console.log(`States: ${board.stateNames().join(" · ")}`);
    const q = await board.queue(STATES.queue);
    console.log(`\n${STATES.queue}: ${q.length} ticket(s)`);
    q.forEach((i) => console.log(`  · ${i.identifier}  ${i.title}`));
    return;
  }

  if (has("once")) { await processQueue(board); return; }

  const interval = Number(flag("interval") ?? 30) * 1000;
  console.log(`Polling ${STATES.queue} every ${interval / 1000}s… (Ctrl-C to stop)`);
  for (;;) {
    await processQueue(board).catch((e) => console.error("poll error:", e.message));
    await sleep(interval);
  }
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
