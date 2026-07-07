import { z } from "zod";

/**
 * The output contract for the Generator. Shaped to line up with the dashboard's
 * approval-gate card (concept / hook / caption / model / cost / format) so a
 * generated concept flows straight into the UI and, later, the Creation agent.
 */
export const ConceptSchema = z.object({
  angle: z
    .string()
    .describe(
      "Short label for this concept's distinct angle, e.g. 'POV transformation', 'myth-bust', 'dupe test'. Each concept in a batch must take a genuinely different angle.",
    ),
  hook: z
    .string()
    .describe(
      "The first 1-2 seconds — the on-screen line or spoken opener that stops the scroll. Concrete and specific, not a topic label.",
    ),
  caption: z
    .string()
    .describe("The post caption in native TikTok voice. May end in a soft CTA."),
  script: z
    .array(
      z.object({
        beat: z.string().describe("What happens in this shot/beat."),
        onScreenText: z
          .string()
          .optional()
          .describe("Text overlay for this beat, if any."),
      }),
    )
    .describe("Beat-by-beat shot list for a short vertical video."),
  hashtags: z
    .array(z.string())
    .describe("5-10 relevant hashtags, without the # symbol."),
  visualDirection: z
    .string()
    .describe(
      "A concrete image/video prompt for the Creation agent (Higgsfield): subject, style, lighting, framing, 9:16. Specific enough to generate from.",
    ),
  format: z
    .string()
    .describe("Delivery format, e.g. '9:16 · 15s video' or '9:16 image'."),
  suggestedModel: z
    .string()
    .describe(
      "Suggested Higgsfield model, e.g. 'Soul 2.0', 'Kling 3.0', 'Nano Banana Pro', 'Seedance 2.0'.",
    ),
  creditEstimate: z
    .number()
    .describe(
      "Rough Higgsfield credit estimate to produce this asset. Images are cheap (~4-10); short videos are not (~18-40).",
    ),
});

export const OutputSchema = z.object({
  concepts: z.array(ConceptSchema),
});

/** Revisions operate on a single concept. */
export const SingleConceptSchema = z.object({
  concept: ConceptSchema,
});

export type Concept = z.infer<typeof ConceptSchema>;
export type GeneratorOutput = z.infer<typeof OutputSchema>;

/**
 * What the Generator stashes on each variation ticket: the concept plus autopilot
 * routing added worker-side (never asked of the model) — which stored hook it came
 * from, which single influencer's images to generate (if assigned), and the content
 * profile the concept was written for (drives the Creator's renderer).
 */
export type ConceptStash = Concept & { hookId?: string; influencerId?: string; profile?: "ugc" | "graphic" };

/** A brief is whatever the ticket carries — later this maps from a Linear issue. */
export interface Brief {
  /** Ticket title / the topic or theme. */
  title: string;
  /** Ticket body — extra context, angle requests, references, constraints. */
  details?: string;
  /** How many distinct concepts to produce. */
  count: number;
  /** Who the content is for (optional steer). */
  audience?: string;
  /** Hard constraints, e.g. "no faces", "product must appear", brand voice. */
  constraints?: string;
}
