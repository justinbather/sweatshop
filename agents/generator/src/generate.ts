import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { OutputSchema, SingleConceptSchema, type Brief, type Concept } from "./schema";
import { systemPromptFor } from "./prompt";
import type { Profile } from "./influencers";
import { loadProductBrief, productBriefToPrompt, generatorContext } from "./brief";

/** Shared system context (profile-keyed role + product brief + per-agent direction). */
async function buildSystem(profile: Profile): Promise<string> {
  const product = await loadProductBrief();
  return [systemPromptFor(profile), productBriefToPrompt(product), generatorContext(product)]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function imageBlocks(images: ImageInput[]): Anthropic.ContentBlockParam[] {
  return images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.data },
  }));
}

/** A screenshot pulled off a reference ticket, ready for Claude's vision. */
export type ImageInput = {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string; // base64
};

/**
 * The generation core: brief (+ optional reference screenshots) in, concepts out.
 * Pure w.r.t. Linear — the worker fetches images and hands them here.
 *
 * When screenshots of a high-performing post are attached, Claude studies them
 * (vision) and adapts the winning structure into on-brand concepts.
 *
 * Model notes (Opus 4.8): structured output via output_config.format (Zod). No
 * `temperature` knob — variety is steered by the prompt, not sampling.
 */
export async function generate(brief: Brief, images: ImageInput[] = [], profile: Profile = "ugc"): Promise<Concept[]> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  // multimodal user turn: brief text (+ adaptation instruction) then screenshots
  const parts: string[] = [renderBrief(brief)];
  if (images.length) {
    parts.push(
      `\nThe attached screenshot${images.length > 1 ? "s are" : " is"} a real high-performing post in our niche (its metrics/notes are in the context above). Study the hook, the slide-by-slide structure, the pacing, and the visual format — then adapt what made it work into on-brand concepts for our product: keep the winning structure, swap in our product, voice, and recurring character.`,
    );
  }
  const content: Anthropic.ContentBlockParam[] = [
    { type: "text", text: parts.join("\n") },
    ...imageBlocks(images),
  ];

  const res = await client.messages.parse({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" }, // let it plan distinct angles before writing
    system: await buildSystem(profile),
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(OutputSchema) },
  });

  if (res.stop_reason === "refusal") {
    throw new Error("Generation was refused by safety classifiers for this brief.");
  }
  if (!res.parsed_output) {
    throw new Error(
      `Generation returned no parseable output (stop_reason: ${res.stop_reason}).`,
    );
  }
  return res.parsed_output.concepts;
}

/**
 * Revise a single concept per reviewer feedback. Given the current concept
 * (its posted Markdown) and the instruction, return the full revised concept —
 * keeping everything that wasn't asked to change.
 */
export async function revise(
  currentConcept: string,
  instruction: string,
  images: ImageInput[] = [],
  profile: Profile = "ugc",
): Promise<Concept> {
  const client = new Anthropic();
  const text =
    `Here is the current concept:\n\n${currentConcept}\n\n---\n\n` +
    `The reviewer asked for these changes:\n\n${instruction}\n\n` +
    `Apply the requested changes and return the full revised concept. Keep everything that wasn't asked to change, and stay on-brand.`;
  const content: Anthropic.ContentBlockParam[] = [
    { type: "text", text },
    ...imageBlocks(images),
  ];

  const res = await client.messages.parse({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: await buildSystem(profile),
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(SingleConceptSchema) },
  });

  if (res.stop_reason === "refusal") {
    throw new Error("Revision was refused by safety classifiers.");
  }
  if (!res.parsed_output) {
    throw new Error(`Revision returned no parseable output (stop_reason: ${res.stop_reason}).`);
  }
  return res.parsed_output.concept;
}

function renderBrief(brief: Brief): string {
  const lines = [
    `Brief: ${brief.title}`,
    ``,
    `Produce ${brief.count} distinct TikTok concept${brief.count === 1 ? "" : "s"}.`,
  ];
  if (brief.details) lines.push(``, `Context:`, brief.details);
  if (brief.audience) lines.push(``, `Audience: ${brief.audience}`);
  if (brief.constraints) lines.push(``, `Constraints: ${brief.constraints}`);
  return lines.join("\n");
}
