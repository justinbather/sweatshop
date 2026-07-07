import type { Concept } from "./schema";

/**
 * Render generated concepts as a Linear comment (Markdown). This is what a human
 * reviews at the Needs Approval gate before any Higgsfield credits are spent.
 */
export function formatConcepts(concepts: Concept[]): string {
  const out: string[] = [];
  out.push(`## 🎬 ${concepts.length} concept${concepts.length === 1 ? "" : "s"} generated`);
  out.push("");

  concepts.forEach((c, i) => {
    out.push(`### ${i + 1}. ${c.angle}`);
    out.push(`> **${c.hook}**`);
    out.push("");
    out.push(c.caption);
    out.push("");
    out.push(`**Script**`);
    c.script.forEach((b, j) => {
      const ost = b.onScreenText ? `  — _"${b.onScreenText}"_` : "";
      out.push(`${j + 1}. ${b.beat}${ost}`);
    });
    out.push("");
    out.push(`\`${c.hashtags.map((h) => "#" + h).join(" ")}\``);
    out.push(`**Produce:** ${c.suggestedModel} · ${c.format} · ~${c.creditEstimate} credits`);
    out.push("");
    out.push(`_Visual:_ ${c.visualDirection}`);
    out.push("");
    out.push("---");
    out.push("");
  });

  const total = concepts.reduce((s, c) => s + c.creditEstimate, 0);
  out.push(
    `_Est. **${total} credits** to produce all. Approve by moving this ticket to **Creation Queue**, or **Rejected** to skip._`,
  );
  return out.join("\n");
}
