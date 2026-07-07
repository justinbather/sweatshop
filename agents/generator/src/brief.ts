import { join } from "path";
import { readFileSync } from "fs";
import { DATA_DIR } from "./paths";
import { usePg, getConfigValue } from "./db";

/**
 * The product brief — stable context about the app the agents make content for.
 * Written by the app's Brand tab, read by every agent. Sits underneath the
 * per-ticket task: brief = "what the app is", ticket = "this specific angle".
 *   fs (desktop): ~/.sweatshop/brief.json  ·  pg (server): app_config key 'brief'
 */
export const BRIEF_PATH = join(DATA_DIR, "brief.json");

export interface Character {
  name?: string;
  description?: string;
  refs?: string[]; // reference image URLs / paths
  soulId?: string; // Higgsfield Soul character id, if trained
}

export interface AgentBriefs {
  researcher?: { notes?: string };
  generator?: { notes?: string };
  creation?: { notes?: string; character?: Character };
}

export interface ProductBrief {
  product?: { name?: string; oneLiner?: string; description?: string; url?: string };
  audience?: string;
  valueProps?: string;
  voice?: string;
  visual?: string;
  pillars?: string[];
  goals?: string;
  guardrails?: string;
  agents?: AgentBriefs;
}

export async function loadProductBrief(): Promise<ProductBrief | null> {
  if (usePg()) {
    try { return await getConfigValue<ProductBrief>("brief"); } catch { return null; }
  }
  try {
    return JSON.parse(readFileSync(BRIEF_PATH, "utf8")) as ProductBrief;
  } catch {
    return null; // no brief yet — agents fall back to generic
  }
}

/** Render the brief as a stable system-prompt section. Empty fields are skipped. */
export function productBriefToPrompt(b: ProductBrief | null): string {
  if (!b) return "";
  const s: string[] = [];
  const p = b.product ?? {};
  const heading = [p.name, p.oneLiner].filter(Boolean).join(" — ");
  if (heading) s.push(`Product: ${heading}`);
  if (p.description) s.push(p.description);
  if (p.url) s.push(`Link: ${p.url}`);
  if (b.audience) s.push(`Audience: ${b.audience}`);
  if (b.valueProps) s.push(`What it solves: ${b.valueProps}`);
  if (b.voice) s.push(`Voice: ${b.voice}`);
  if (b.visual) s.push(`Visual identity: ${b.visual}`);
  if (b.pillars && b.pillars.length) {
    s.push(`Content pillars:\n${b.pillars.map((x) => `- ${x}`).join("\n")}`);
  }
  if (b.goals) s.push(`Every post should drive: ${b.goals}`);
  if (b.guardrails) s.push(`Guardrails: ${b.guardrails}`);
  if (s.length === 0) return "";

  return `You are making content for this specific product. Ground every concept in it — the real product, its voice, its audience. Do not invent unrelated products.\n\n${s.join("\n\n")}`;
}

/**
 * Generator-specific direction: its own notes, plus the Creation agent's
 * constraints (images-only, styles, the recurring AI influencer) so the concepts
 * it produces are actually producible and feature the right character.
 */
export function generatorContext(b: ProductBrief | null): string {
  const a = b?.agents;
  if (!a) return "";
  const parts: string[] = [];

  if (a.generator?.notes) parts.push(`Direction for you (Generator):\n${a.generator.notes}`);

  const c = a.creation;
  if (c) {
    const prod: string[] = [];
    if (c.notes) prod.push(c.notes);
    const ch = c.character;
    if (ch && (ch.name || ch.description)) {
      const refs = (ch.refs ?? []).filter(Boolean);
      prod.push(
        `Feature this recurring AI influencer in the imagery: ${[ch.name, ch.description]
          .filter(Boolean)
          .join(" — ")}.` +
          (refs.length ? ` Reference images: ${refs.join(", ")}.` : "") +
          (ch.soulId ? ` Higgsfield Soul character: ${ch.soulId}.` : "") +
          ` Keep her appearance consistent across concepts, and write visualDirection so it matches these references.`,
      );
    }
    if (prod.length) {
      parts.push(
        `Downstream production constraints — the Creation agent actually produces these, so only suggest models/formats it can make and plan visuals accordingly:\n${prod.join(
          "\n",
        )}`,
      );
    }
  }
  return parts.join("\n\n");
}
