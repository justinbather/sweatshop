import { readFileSync } from "fs";
import { join, dirname } from "path";
import { loadAppConfig } from "./config";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { Board } from "./linear";
import { loadSecrets } from "./secrets";
import { loadProductBrief, productBriefToPrompt } from "./brief";
import { loadInfluencers, profileOf, type Influencer } from "./influencers";
import { addHooks, addChannelMetrics, recentHooks, postsForHook, channelTrends, getState, setState } from "./store";
import { notify } from "./notify";

/**
 * Strategist agent — the autopilot's clock and brain. On each scheduled run
 * (times configured in Settings → Autopilot, stored in ~/.sweatshop/config.json):
 *
 *   1. pull channel analytics from Postiz into the store (file now, Postgres later)
 *   2. write 3 fresh hooks with Claude — informed by the TikTok-hooks playbook
 *      (skills/tiktok-hooks.md), the product brief, and past hooks + performance
 *   3. assign hook 1..N to the N enabled influencers (rest = bench), and create ONE
 *      autopilot ticket in Generation Queue that kicks off the rest of the pipeline:
 *
 *   Strategist ──ticket──► Generator (1 concept/hook; assigned → Creation Queue,
 *   bench → Needs Approval) ──► Creator (images ONLY for the assigned influencer)
 *   ──► Ready to Post (you pick) ──► Posting Queue ──► Poster (slot-scheduled)
 *
 * Runs/day = imaged posts/day per influencer. No run times configured → idle.
 * NOTE: Postiz public analytics is per-CHANNEL (followers/impressions daily series),
 * not per-post; per-post metrics slot into store.postMetrics when a source exists.
 */
const STATES = { queue: "Generation Queue" };
const HOOKS_PER_RUN = 3;
const POSTIZ_BASE = process.env.POSTIZ_API_URL || "https://api.postiz.com/public/v1";
const SKILL_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "tiktok-hooks.md");

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

async function runTimes(): Promise<string[]> {
  const t = (await loadAppConfig()).autopilotTimes;
  return Array.isArray(t) ? t.filter((x: unknown) => typeof x === "string" && /^\d{1,2}:\d{2}$/.test(x)).sort() : [];
}

/** Most recent scheduled datetime <= now (checks today then yesterday). */
function latestDue(times: string[], now: Date): Date | null {
  let best: Date | null = null;
  for (const dayBack of [0, 1]) {
    for (const t of times) {
      const [h, m] = t.split(":").map(Number);
      const d = new Date(now);
      d.setDate(d.getDate() - dayBack);
      d.setHours(h, m, 0, 0);
      if (d.getTime() <= now.getTime() && (!best || d.getTime() > best.getTime())) best = d;
    }
  }
  return best;
}

// ---- 1. analytics ------------------------------------------------------------

async function pullAnalytics(influencers: Influencer[]): Promise<string> {
  const apiKey = process.env.POSTIZ_API_KEY;
  if (!apiKey) return "no POSTIZ_API_KEY — skipped";
  let stored = 0;
  for (const inf of influencers) {
    if (!inf.postizIntegrationId) continue;
    try {
      const res = await fetch(`${POSTIZ_BASE}/analytics/${inf.postizIntegrationId}?date=7`, {
        headers: { Authorization: apiKey },
      });
      if (!res.ok) { console.error(`  analytics ${inf.name}: ${res.status}`); continue; }
      const series: { label: string; data: { total: string; date: string }[] }[] = await res.json();
      const samples = (Array.isArray(series) ? series : []).flatMap((s) =>
        (s.data || []).map((p) => ({ influencerId: inf.id, label: s.label, value: Number(p.total) || 0, date: p.date })),
      );
      await addChannelMetrics(samples);
      stored += samples.length;
    } catch (e) {
      console.error(`  analytics ${inf.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return `${stored} sample(s) stored`;
}

// ---- 2. hook generation --------------------------------------------------------

const HooksSchema = z.object({
  hooks: z
    .array(
      z.object({
        text: z.string().describe("The hook — the exact on-screen line for slide 1. lowercase, native TikTok voice."),
        angle: z.string().describe("Which playbook pattern it uses, e.g. 'myth-bust', 'time-boxed result'."),
        rationale: z.string().describe("One line: why this hook, given the performance data."),
      }),
    )
    .length(HOOKS_PER_RUN),
});

async function performanceContext(): Promise<string> {
  const lines: string[] = [];
  const trends = await channelTrends();
  if (trends.length) {
    lines.push("Channel trends (last stored window):");
    for (const t of trends) lines.push(`- ${t.influencerId} ${t.label}: ${t.first} → ${t.last}`);
  }
  const hooks = await recentHooks(15);
  if (hooks.length) {
    lines.push("", "Recent hooks (avoid repeating their patterns back-to-back):");
    for (const h of hooks) {
      const posts = await postsForHook(h.id);
      lines.push(`- [${h.angle}] "${h.text}"${posts.length ? ` — posted ${posts.length}× (${posts.map((p) => `${p.influencerId} @ ${p.scheduledAt.slice(0, 10)}`).join(", ")})` : " — not posted"}`);
    }
  }
  return lines.join("\n") || "No performance data yet — first run.";
}

async function writeHooks(influencers: Influencer[]): Promise<{ text: string; angle: string; rationale: string }[]> {
  const skill = readFileSync(SKILL_FILE, "utf8");
  const product = await loadProductBrief();
  const system = [
    "You are the Strategist in an automated TikTok content agency. Your single output is scroll-stopping slideshow hooks.",
    skill,
    productBriefToPrompt(product),
  ].filter(Boolean).join("\n\n---\n\n");

  // hook i goes to account i (see createTicket) — write each in its account's register
  const registers = Array.from({ length: HOOKS_PER_RUN }, (_, i) => {
    const inf = influencers[i];
    if (!inf) return `${i + 1} → bench (ugc register: personal, first-person)`;
    return profileOf(inf) === "graphic"
      ? `${i + 1} → ${inf.name} — GRAPHIC account: authoritative, specific, listy; must read as a designed card title`
      : `${i + 1} → ${inf.name} — UGC account: personal, first-person, lived-experience voice`;
  });

  const client = new Anthropic();
  const res = await client.messages.parse({
    model: "claude-opus-4-8",
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system,
    messages: [
      {
        role: "user",
        content:
          `Write ${HOOKS_PER_RUN} hooks for today's posts. Each must use a different playbook pattern.\n\n` +
          `Assignments (write each hook in its target account's register — see "Account registers" in the playbook):\n${registers.join("\n")}\n\n` +
          (await performanceContext()),
      },
    ],
    output_config: { format: zodOutputFormat(HooksSchema) },
  });
  if (res.stop_reason === "refusal") throw new Error("Hook writing was refused by safety classifiers.");
  if (!res.parsed_output) throw new Error(`Hook writing returned no parseable output (stop_reason: ${res.stop_reason}).`);
  return res.parsed_output.hooks;
}

// ---- 3. the autopilot ticket ---------------------------------------------------

async function createTicket(board: Board, influencers: Influencer[]): Promise<void> {
  const hooks = await writeHooks(influencers);
  const stored = await addHooks(hooks);
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");

  const lines = stored.map((h, i) => {
    const inf = influencers[i]; // hook 1..N → the N enabled influencers; the rest are bench
    // "(id · Name)" — the id is the machine token (worker parses the first word), the name is for humans
    return `${i + 1}. [${h.id}] (${inf ? `${inf.id} · ${inf.name}` : "bench"}) ${h.text}`;
  });
  const body = [
    "Autopilot: true",
    `Variations to create: ${stored.length}`,
    "",
    "Use each hook below verbatim as the hook of exactly one concept, in this order:",
    "",
    ...lines,
    "",
    "_Assigned concepts get images for that influencer automatically; the bench concept lands in Needs Approval for manual use._",
    "",
    "Rationale:",
    ...hooks.map((h, i) => `${i + 1}. (${h.angle}) ${h.rationale}`),
  ].join("\n");

  const t = await board.createIssue(`🧠 Autopilot hooks — ${stamp}`, STATES.queue, body);
  console.log(`  ✓ ${stored.length} hooks → ${t.identifier} (${STATES.queue})`);
  notify("success", `🧠 Hooks ready → ${t.identifier}`, {
    url: t.url,
    detail: stored.map((h, i) => `${i + 1}. (${influencers[i]?.name ?? "bench"}) ${h.text}`).join("\n"),
  });
  // hook→post linkage is written by the Poster (recordPost with the hook id);
  // the ticket body itself carries the hook ids for tracing.
}

async function runOnce(board: Board): Promise<void> {
  await loadSecrets();
  const influencers = (await loadInfluencers()).filter((i) => i.enabled);
  if (!influencers.length) { console.log("· no enabled influencers — skipping run"); return; }
  console.log(`▶ autopilot run — ${influencers.length} influencer(s)`);
  notify("info", `🧠 Autopilot run started (${influencers.map((i) => i.name).join(", ")})`);
  try {
    console.log(`  analytics: ${await pullAnalytics(influencers)}`);
    await createTicket(board, influencers);
  } catch (e) {
    notify("error", "🧠 Autopilot run failed", { detail: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

async function main() {
  await loadSecrets();
  const board = new Board(requireEnv("LINEAR_API_KEY"));
  const teamKey = flag("team") ?? process.env.LINEAR_TEAM ?? "CON";
  await board.init(teamKey);
  console.log(`Connected to team ${teamKey}`);

  if (has("check")) {
    const times = await runTimes();
    console.log(`Run times: ${times.join(" · ") || "(none configured — idle)"}`);
    console.log(`Last run: ${(await getState("autopilotLastRun")) || "(never)"}`);
    return;
  }

  requireEnv("ANTHROPIC_API_KEY");
  if (has("once")) { await runOnce(board); return; }

  console.log("Autopilot clock running — checks every 60s for a due run time (Settings → Autopilot).");
  for (;;) {
    try {
      const times = await runTimes();
      const due = times.length ? latestDue(times, new Date()) : null;
      const last = await getState("autopilotLastRun");
      if (due && (!last || new Date(last).getTime() < due.getTime())) {
        await setState("autopilotLastRun", new Date().toISOString()); // claim first: a failed run shouldn't hot-loop
        await runOnce(board);
      }
    } catch (e) {
      console.error("run error:", e instanceof Error ? e.message : String(e));
    }
    await sleep(60_000);
  }
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
