import { generate } from "./generate";
import { loadSecrets } from "./secrets";
import type { Brief, Concept } from "./schema";

/**
 * Run the generation core against a brief and print the concepts.
 * This stands in for a Linear ticket until step 2 wires the queue.
 *
 *   ANTHROPIC_API_KEY=... npm run generate -- --topic "summer skincare" --count 3
 *   ANTHROPIC_API_KEY=... npm run generate -- --topic "..." --details "..." --json
 */
function parseArgs(argv: string[]): { brief: Brief; json: boolean } {
  const args = new Map<string, string>();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") { json = true; continue; }
    if (a.startsWith("--")) { args.set(a.slice(2), argv[++i] ?? ""); }
  }
  const brief: Brief = {
    title: args.get("topic") ?? "summer skincare — week 1",
    details: args.get("details"),
    count: Number(args.get("count") ?? 3),
    audience: args.get("audience"),
    constraints: args.get("constraints"),
  };
  return { brief, json };
}

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

function printConcept(i: number, x: Concept) {
  console.log(`\n${c.bold(c.cyan(`── Concept ${i + 1}: ${x.angle} ──`))}`);
  console.log(`${c.dim("hook   ")} ${c.bold(x.hook)}`);
  console.log(`${c.dim("caption")} ${x.caption}`);
  console.log(`${c.dim("script ")}`);
  x.script.forEach((b, j) => {
    const ost = b.onScreenText ? c.yellow(`  [“${b.onScreenText}”]`) : "";
    console.log(`   ${c.dim(`${j + 1}.`)} ${b.beat}${ost}`);
  });
  console.log(`${c.dim("tags   ")} ${x.hashtags.map((h) => "#" + h).join(" ")}`);
  console.log(`${c.dim("visual ")} ${x.visualDirection}`);
  console.log(
    `${c.dim("produce")} ${c.magenta(x.suggestedModel)} · ${x.format} · ${c.magenta(`~${x.creditEstimate} cr`)}`,
  );
}

async function main() {
  loadSecrets();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "Set ANTHROPIC_API_KEY first, e.g.\n  ANTHROPIC_API_KEY=sk-ant-... npm run generate -- --topic \"...\"",
    );
    process.exit(1);
  }
  const { brief, json } = parseArgs(process.argv.slice(2));
  console.error(c.dim(`\nGenerating ${brief.count} concept(s) for: ${brief.title}\n`));

  const concepts = await generate(brief);

  if (json) {
    console.log(JSON.stringify(concepts, null, 2));
    return;
  }
  concepts.forEach((x, i) => printConcept(i, x));
  const total = concepts.reduce((s, x) => s + x.creditEstimate, 0);
  console.log(c.dim(`\n${concepts.length} concepts · est. ${total} credits to produce all\n`));
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
