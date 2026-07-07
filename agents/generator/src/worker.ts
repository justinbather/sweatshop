import type { Issue } from "@linear/sdk";
import { Board } from "./linear";
import { generate, revise, type ImageInput } from "./generate";
import { formatConcepts } from "./format";
import { loadSecrets } from "./secrets";
import { loadInfluencers, profileOf, type Profile } from "./influencers";
import { notify } from "./notify";

/**
 * The Generator worker. Watches the board and runs the handoff:
 *
 *   Generation Queue  ──claim──►  Generating  ──generate + comment──►  Needs Approval
 *
 * A ticket you create by hand and a ticket the Researcher's cron creates are
 * indistinguishable — both just land in Generation Queue.
 *
 *   --check          connect, print states + queue, exit (verify wiring)
 *   --once           process the queue once, then exit (good for cron)
 *   --interval <s>   poll every N seconds (default 30); the default mode
 *   --team <KEY>     override team key (default LINEAR_TEAM or "CON")
 */
const STATES = {
  queue: "Generation Queue",
  working: "Generating",
  approval: "Needs Approval",
  creation: "Creation Queue", // autopilot: assigned concepts skip approval, go straight to the Creator
  generated: "Generated", // parent reference tickets land here after fanout
  revise: "Revise", // comment a change, move here → agent revises → Needs Approval
};
const DEFAULT_COUNT = 3;
const MIN_COUNT = 1, MAX_COUNT = 8;
const clampCount = (n: number) => Math.max(MIN_COUNT, Math.min(MAX_COUNT, Number.isFinite(n) ? n : DEFAULT_COUNT));

const VARIATIONS_RE = /variations?\s*(?:to create)?\s*[:\-]\s*(\d{1,2})/i;

// How many variations to fan out. Priority: a "Variations to create: N" line in
// the description (the ticket template), then a label like "x5", then [x5] in the
// title, else DEFAULT_COUNT.
async function variationCount(issue: Issue): Promise<number> {
  const dm = VARIATIONS_RE.exec(issue.description ?? "");
  if (dm) return clampCount(Number(dm[1]));
  try {
    const labels = await issue.labels();
    for (const l of labels.nodes) {
      const m = /^x?(\d{1,2})$/i.exec((l.name || "").trim());
      if (m) return clampCount(Number(m[1]));
    }
  } catch { /* labels optional */ }
  const t = /\[x(\d{1,2})\]/i.exec(issue.title || "");
  if (t) return clampCount(Number(t[1]));
  return DEFAULT_COUNT;
}

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

const ALLOWED_MEDIA = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// Pull reference screenshots off a ticket (pasted into the description or attached).
// Linear-hosted images need the API key to fetch; signed URLs work unauthenticated.
async function fetchTicketImages(issue: Issue, apiKey: string): Promise<ImageInput[]> {
  const urls = new Set<string>();
  const desc = issue.description ?? "";
  const re = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(desc)) !== null) urls.add(m[1]);
  try {
    const att = await issue.attachments();
    for (const a of att.nodes) {
      if (a.url && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(a.url)) urls.add(a.url);
    }
  } catch { /* attachments optional */ }

  const images: ImageInput[] = [];
  for (const url of [...urls].slice(0, 8)) {
    try {
      let res = await fetch(url, { headers: { Authorization: apiKey } });
      if (!res.ok) res = await fetch(url); // fall back to unauthenticated (signed URLs)
      if (!res.ok) continue;
      let ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (ct === "image/jpg") ct = "image/jpeg";
      if (!ALLOWED_MEDIA.has(ct)) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 4_500_000) continue; // skip oversized
      images.push({ mediaType: ct as ImageInput["mediaType"], data: buf.toString("base64") });
    } catch { /* skip bad image */ }
  }
  return images;
}

// Autopilot tickets (from the Strategist) carry pre-written hooks with routing:
//   Autopilot: true
//   1. [h_xxxxxx] (<influencerId>|bench) hook text
// One concept is generated per hook (verbatim, same order — enforced in the system
// prompt); the worker zips hookId/influencerId back onto each concept by index.
type HookMeta = { hookId: string; influencerId?: string; text: string; profile: Profile };
async function autopilotHooks(issue: Issue): Promise<HookMeta[]> {
  const d = issue.description ?? "";
  if (!/^\s*Autopilot:\s*true/im.test(d)) return [];
  const byId = new Map((await loadInfluencers()).map((i) => [i.id, i]));
  const metas: HookMeta[] = [];
  // the parenthetical is "(influencerId)" or "(influencerId · Name)" — first token is the id
  for (const m of d.matchAll(/^\s*\d+\.\s*\[(h_\w+)\]\s*\(([\w-]+)[^)]*\)\s*(.+)$/gm)) {
    const influencerId = m[2] === "bench" ? undefined : m[2];
    metas.push({
      hookId: m[1],
      influencerId,
      text: m[3].trim(),
      profile: profileOf(influencerId ? byId.get(influencerId) : undefined), // bench → ugc
    });
  }
  return metas;
}

// Manual tickets opt into the graphic pack with a "Profile: graphic" line.
const manualProfile = (issue: Issue): Profile =>
  /^\s*Profile:\s*graphic/im.test(issue.description ?? "") ? "graphic" : "ugc";

// One generation call covers one content profile (its system prompt differs), so a
// mixed autopilot ticket (ugc + graphic accounts) is split into per-profile units.
// Each unit's brief carries ONLY its own hook lines.
const HOOK_LINE_RE = /^\s*\d+\.\s*\[h_\w+\][^\n]*$/gm;
function briefForUnit(issue: Issue, unit: HookMeta[]) {
  const base = briefFromIssue(issue, unit.length);
  const details = (base.details ?? "").replace(HOOK_LINE_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  const hookLines = unit.map((m, i) => `${i + 1}. [${m.hookId}] (${m.influencerId ?? "bench"}) ${m.text}`).join("\n");
  return { ...base, details: `${details}\n\nUse each hook below verbatim, one concept per hook, in this order:\n${hookLines}` };
}

// Ticket -> brief. Strip the image markdown (images go to Claude separately) and
// the "Variations to create" line (that's handled as the count, not context).
function briefFromIssue(issue: Issue, count: number) {
  const details = (issue.description ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/^.*variations?\s*(?:to create)?\s*[:\-].*$/gim, "")
    .trim() || undefined;
  return { title: issue.title, details, count };
}

async function processQueue(board: Board, apiKey: string): Promise<void> {
  const tickets = await board.queue(STATES.queue);
  if (tickets.length === 0) {
    console.log(`· ${STATES.queue} empty`);
    return;
  }
  for (const issue of tickets) {
    const metas = await autopilotHooks(issue);
    const count = metas.length || await variationCount(issue);
    console.log(`→ ${issue.identifier}  ${issue.title}  (×${count}${metas.length ? ", autopilot" : ""})`);
    notify("info", `⚙️ Generator started — ${issue.identifier} (×${count})`, { url: issue.url, detail: issue.title });
    try {
      await board.move(issue.id, STATES.working);
      const images = await fetchTicketImages(issue, apiKey);
      if (images.length) console.log(`  · ${images.length} reference screenshot(s)`);

      // fan out: one sub-issue per variation. Manual tickets → Needs Approval.
      // Autopilot tickets → assigned concepts go straight to Creation Queue (the
      // human gate is Ready to Post); the bench concept waits in Needs Approval.
      // One generate() call per content profile; the concept's profile is stashed
      // so the Creator picks the matching renderer.
      const units: [Profile, HookMeta[]][] = metas.length
        ? [...metas.reduce((m, h) => (m.get(h.profile)?.push(h) ?? m.set(h.profile, [h]), m), new Map<Profile, HookMeta[]>())]
        : [[manualProfile(issue), []]];
      let toCreation = 0, toApproval = 0;
      for (const [profile, unitMetas] of units) {
        const brief = unitMetas.length ? briefForUnit(issue, unitMetas) : briefFromIssue(issue, count);
        const concepts = await generate(brief, images, profile);
        for (let i = 0; i < concepts.length; i++) {
          const meta = unitMetas[i]; // concepts come back in hook order (enforced in the prompt)
          const stash = { ...concepts[i], profile, ...(meta ? { hookId: meta.hookId, influencerId: meta.influencerId } : {}) };
          const target = meta?.influencerId ? STATES.creation : STATES.approval;
          if (meta?.influencerId) toCreation++; else toApproval++;
          const desc = "_Concept data (used by the Creator agent)._\n\n```json\n" + JSON.stringify(stash, null, 2) + "\n```";
          const title = meta?.influencerId ? `${concepts[i].angle} → ${meta.influencerId}` : concepts[i].angle;
          const childId = await board.createVariation(issue.id, title, target, desc);
          await board.comment(childId, formatConcepts([concepts[i]]));
        }
      }
      await board.move(issue.id, STATES.generated);
      const routed = `${toCreation} → ${STATES.creation}, ${toApproval} → ${STATES.approval}`;
      console.log(`  ✓ ${routed}; parent → ${STATES.generated}`);
      notify("success", `⚙️ Concepts routed — ${issue.identifier}: ${routed}`, { url: issue.url });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ✗ ${msg}`);
      notify("error", `⚙️ Generation failed — ${issue.identifier}`, { url: issue.url, detail: msg });
      // leave it in Generating so it's visibly stuck; comment the reason.
      await board.comment(issue.id, `⚠️ Generation failed: ${msg}`).catch(() => {});
    }
  }
}

// A comment is a "concept" if it's one the agent posted (marked with 🎬).
// Everything after the latest concept comment is treated as reviewer feedback —
// author can't be used to tell them apart (personal key = same author).
async function reviseInputs(issue: Issue): Promise<{ current: string; instruction: string }> {
  let nodes: Array<{ body?: string | null; createdAt?: Date | string }> = [];
  try {
    const cm = await issue.comments();
    nodes = cm.nodes as Array<{ body?: string | null; createdAt?: Date | string }>;
  } catch { /* no comments */ }
  const sorted = [...nodes].sort(
    (a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime(),
  );
  let current = "";
  let instruction: string[] = [];
  for (const c of sorted) {
    const body = (c.body || "").trim();
    if (!body) continue;
    if (body.includes("🎬")) { current = body; instruction = []; }
    else instruction.push(body);
  }
  return { current, instruction: instruction.join("\n\n") };
}

async function processRevisions(board: Board, apiKey: string): Promise<void> {
  let tickets: Issue[] = [];
  try { tickets = await board.queue(STATES.revise); } catch { return; }
  for (const issue of tickets) {
    console.log(`↻ ${issue.identifier}  ${issue.title}`);
    try {
      const { current, instruction } = await reviseInputs(issue);
      if (!instruction) {
        await board.comment(issue.id, "↻ No change described. Add a comment with what to change, then move this back to Revise.");
        await board.move(issue.id, STATES.approval);
        continue;
      }
      const images = await fetchTicketImages(issue, apiKey);
      // the variation's stashed JSON carries its content profile
      const profile: Profile = /"profile":\s*"graphic"/.test(issue.description ?? "") ? "graphic" : "ugc";
      const revised = await revise(current, instruction, images, profile);
      await board.comment(issue.id, "↻ **Revised per your comment.**\n\n" + formatConcepts([revised]));
      await board.move(issue.id, STATES.approval);
      console.log(`  ✓ revised → ${STATES.approval}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ✗ ${msg}`);
      await board.comment(issue.id, `⚠️ Revision failed: ${msg}`).catch(() => {});
      await board.move(issue.id, STATES.approval).catch(() => {});
    }
  }
}

async function runCycle(board: Board, apiKey: string): Promise<void> {
  await loadSecrets(); // pick up keys (incl. DISCORD_WEBHOOK_URL) saved after startup
  await processQueue(board, apiKey);
  await processRevisions(board, apiKey);
}

async function main() {
  await loadSecrets();
  const linearKey = requireEnv("LINEAR_API_KEY");
  const board = new Board(linearKey);
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

  requireEnv("ANTHROPIC_API_KEY"); // only needed to actually generate

  if (has("once")) {
    await runCycle(board, linearKey);
    return;
  }

  const interval = Number(flag("interval") ?? 30) * 1000;
  console.log(`Polling ${STATES.queue} + ${STATES.revise} every ${interval / 1000}s… (Ctrl-C to stop)`);
  for (;;) {
    await runCycle(board, linearKey).catch((e) => console.error("poll error:", e.message));
    await sleep(interval);
  }
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
