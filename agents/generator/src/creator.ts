import { loadAppConfig } from "./config";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import type { Issue } from "@linear/sdk";
import { Board } from "./linear";
import { loadSecrets } from "./secrets";
import { loadProductBrief } from "./brief";
import { loadInfluencers, profileOf, type Influencer, type Design } from "./influencers";
import { listRefs, putSlide } from "./assets";
import { notify } from "./notify";
import type { Concept, ConceptStash } from "./schema";

/**
 * Creator agent. Watches Creation Queue (approved variations), reads each
 * concept, generates its slideshow images via Google's Nano Banana Pro
 * (Gemini image model), and drops a post ticket per influencer in Posting Queue.
 *
 *   Creation Queue ──claim──► Creating ──generate──► Posting Queue (→ Poster → TikTok inbox = your gate)
 *
 * AUTH: a single `GEMINI_API_KEY` (aistudio.google.com), stored in the app's Keys
 * panel. Character consistency comes from the reference images the user uploads on
 * the Brand tab (~/.sweatshop/refs) — passed to the model with each generation.
 *
 * ⚠️ Without `GEMINI_API_KEY` it runs in STUB mode: posts the per-slide plan instead
 * of generating, so the flow is testable. The real Gemini call is written against
 * the typed SDK; confirm the model id + response shape on your first live run
 * (Nano Banana Pro is new, and image generation isn't free).
 *
 * Create a `Ready to Post` column in Linear before enabling this agent.
 */
const STATES = {
  queue: "Creation Queue",
  working: "Creating",
  post: "Posting Queue",   // post tickets go straight to the Poster (TikTok inbox = the review gate)
  review: "Ready to Post", // fix-it lane: incomplete sets bounce here; regen-by-comment watches it
  done: "Generated",       // the original variation ends here once its post ticket(s) exist
};

const GEMINI_MODEL = "gemini-3-pro-image"; // Nano Banana Pro
const OPENAI_MODEL = "gpt-image-2";        // OpenAI GPT Image
const OUT_W = 1080, OUT_H = 1920;          // final 9:16 TikTok frame
const MAX_REFS = 14;

type Provider = "gemini" | "openai";
// Which image model the Creator uses, toggled in the app's Settings. Re-read each
// poll so the toggle applies without a restart. Defaults to Gemini.
async function imageProvider(): Promise<Provider> {
  return (await loadAppConfig()).imageModel === "openai" ? "openai" : "gemini";
}
const providerKeyName = (p: Provider) => (p === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY");

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

function conceptFromJson(s: string): Concept | null {
  const m = /```json\s*([\s\S]*?)```/.exec(s);
  if (!m) return null;
  try { return JSON.parse(m[1]) as Concept; } catch { return null; }
}

// Reconstruct a concept from the Generator's human-readable comment (formatConcepts
// output) — for older tickets that predate the JSON stash. Format is ours, so this
// is reliable enough to generate from.
function conceptFromMarkdown(body: string): Concept | null {
  if (!/🎬/.test(body)) return null;
  const one = (re: RegExp) => (re.exec(body)?.[1] || "").trim();
  const angle = one(/^###\s*\d*\.?\s*(.+)$/m) || "Concept";
  const hook = one(/^>\s*\*\*(.+?)\*\*/m);
  const visualDirection = one(/^_Visual:_\s*(.+)$/m);
  const hashtags = one(/^`(#.+?)`$/m).split(/\s+/).map((t) => t.replace(/^#/, "")).filter(Boolean);
  const prod = /\*\*Produce:\*\*\s*(.+?)\s*·\s*(.+?)\s*·\s*~?(\d+)/.exec(body);

  const script: Concept["script"] = [];
  const scriptSection = (body.split(/\*\*Script\*\*/)[1] || "").split(/\r?\n/);
  for (const line of scriptSection) {
    const m = /^\s*\d+\.\s+(.+?)(?:\s+—\s+_"(.+?)"_)?\s*$/.exec(line);
    if (m) script.push({ beat: m[1].trim(), onScreenText: m[2]?.trim() });
    else if (/^(`#|\*\*Produce|_Visual|---)/.test(line.trim())) break;
  }

  let caption = "";
  const before = (body.split(/\*\*Script\*\*/)[0] || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hi = before.findIndex((l) => l.startsWith(">"));
  if (hi >= 0 && before[hi + 1] && !before[hi + 1].startsWith("#")) caption = before[hi + 1];

  return {
    angle, hook, caption,
    script: script.length ? script : [{ beat: visualDirection || hook || angle }],
    hashtags, visualDirection,
    format: prod?.[2]?.trim() || "9:16 image slideshow",
    suggestedModel: prod?.[1]?.trim() || "Soul 2.0",
    creditEstimate: prod ? Number(prod[3]) : 0,
  };
}

// Concept from: JSON in description → JSON in a comment → parsed markdown comment.
async function extractConcept(issue: Issue): Promise<Concept | null> {
  const fromDesc = conceptFromJson(issue.description ?? "");
  if (fromDesc) return fromDesc;
  try {
    const cm = await issue.comments(); // newest-first
    for (const c of cm.nodes) { const p = conceptFromJson(c.body ?? ""); if (p) return p; }
    for (const c of cm.nodes) { const p = conceptFromMarkdown(c.body ?? ""); if (p) return p; }
  } catch { /* no comments */ }
  return null;
}

// Words in a beat that imply a person is in the shot (→ use the influencer).
const PERSON_HINTS = /\b(she|her|hers|woman|girl|selfie|pov|face|hand|hands|holding|holds|walking|walks|sitting|sits|standing|smil|laugh|posing|person|influencer|model|mirror)\b/i;

// Keep character prompts wholesome so image-model safety filters (esp. OpenAI's,
// which rejects anything it reads as sexual) don't reject the generation.
const SAFE_CLAUSE =
  "Keep it wholesome and platform-safe: she is fully clothed in modest, casual everyday clothing " +
  "(loose, comfortable, fully covering — no swimwear, lingerie, underwear, crop tops, cleavage, or tight/revealing outfits), " +
  "in a relaxed, natural, non-provocative pose with ordinary framing. Nothing suggestive, sexualized, intimate, or flirtatious — " +
  "this is plain everyday lifestyle content, like a normal person's casual phone photo.";

// usesCharacter → send the influencer's reference images (identity).
// styleAnchor → chain slides visually: seed slide 1 with brand assets (if any),
// then reuse the first render as a design reference for the rest of the set.
type SlidePlan = { prompt: string; usesCharacter: boolean; styleAnchor?: boolean };

// Build one SINGLE-image prompt per slide. Each slide replicates the reference
// slide's subject type (the Generator's beat already encodes it): a person shot →
// the influencer (with her reference images); a food/object shot → objects only.
function planSlides(concept: Concept, charName: string, style: string): SlidePlan[] {
  const beats = concept.script && concept.script.length
    ? concept.script.map((b) => b.beat)
    : [concept.visualDirection || concept.hook || concept.angle];
  const firstName = charName.split(/\s+/)[0];
  const nameRe = firstName ? new RegExp(`\\b${firstName}\\b`, "i") : null;

  return beats.map((beat) => {
    const usesCharacter = (nameRe?.test(beat) ?? false) || PERSON_HINTS.test(beat);
    const subject = usesCharacter
      ? `The person in the frame is ${charName || "the recurring influencer"}. EVERY reference image provided shows the SAME single person — match her face, hair, skin tone and styling EXACTLY; she must be unmistakably identical to the references and to the other slides in this set. Do not invent a different face. ${SAFE_CLAUSE}`
      : `No people at all in the frame — the subject is food / objects only.`;
    const prompt = [
      "A single vertical 9:16 photograph — ONE image only.",
      "Do NOT make a collage, grid, contact sheet, split-screen, storyboard, or multi-panel layout.",
      beat.trim() + ".",
      subject,
      style ? `Overall aesthetic (palette/lighting only): ${style.replace(/\s+/g, " ").trim()}.` : "",
      "Shot like a real, candid amateur smartphone snapshot — natural available light, a slightly imperfect angle and focus, authentic and a little unpolished. Avoid a glossy, hyper-real, studio, editorial, or CGI look; it should read as a genuine everyday phone photo someone actually took, NOT a perfect AI render.",
      "NEVER show a phone, phone screen, camera, tablet, laptop, TV, or any glowing device display in the frame. Do NOT depict anyone holding up, photographing, or filming something — show the subject itself directly, never a screen of it.",
      "ABSOLUTELY NO logos, brand marks, mascots, app screenshots, product packaging, on-screen text, captions, or watermarks — this is raw, unbranded content. If the aesthetic mentions a logo or app, ignore it; do not draw it.",
    ].filter(Boolean).join(" ");
    return { prompt, usesCharacter };
  });
}

// Graphic profile: each slide is a flat designed text card — the model RENDERS the
// exact onScreenText into the graphic (nothing to overlay later). Consistency comes
// from the account's design tokens + the style anchor chain.
function planSlidesGraphic(concept: Concept, design?: Design): SlidePlan[] {
  const d = design || {};
  const system = [
    d.palette ? `Palette: ${d.palette}.` : "",
    d.fontStyle ? `Typography: ${d.fontStyle}.` : "",
    d.style ? `Overall style: ${d.style}.` : "",
  ].filter(Boolean).join(" ")
    || "Clean minimal design: near-black background, one warm accent color, bold condensed sans-serif, generous whitespace.";
  const beats = concept.script && concept.script.length
    ? concept.script
    : [{ beat: "title card — hook huge, centered", onScreenText: concept.hook }];

  return beats.map((b) => ({
    usesCharacter: false,
    styleAnchor: true,
    prompt: [
      "A single vertical 9:16 designed graphic slide — flat graphic design, NOT a photograph. ONE card only; no collage, grid, or multi-panel layout.",
      `Render EXACTLY this text as the card's content, spelled exactly, large and easily legible: "${(b.onScreenText || b.beat).replace(/"/g, "'").trim()}"`,
      `Layout: ${b.beat.trim()}.`,
      `Design system: ${system}`,
      "Every slide in this set shares ONE design system — if a reference design image is provided, match its palette, typography and layout family exactly.",
      "Simple iconography or illustration accents are fine. No photographs, no people, no watermarks, no third-party logos.",
    ].join(" "),
  }));
}

// Renderer dispatch: the concept's profile (stamped by the Generator) or, for
// legacy concepts without one, the target account's profile.
function planFor(concept: ConceptStash, inf: Influencer, style: string): SlidePlan[] {
  const profile = concept.profile ?? profileOf(inf);
  return profile === "graphic" ? planSlidesGraphic(concept, inf.design) : planSlides(concept, inf.name, style);
}

type RefImage = { mimeType: string; data: string };
// Reference photos can be many MB straight off a phone; downscale to <=1024px so
// the multipart edits payload stays small (identity survives the downscale fine).
async function loadRefImages(influencerId: string): Promise<RefImage[]> {
  try {
    const files = (await listRefs(influencerId)).slice(0, MAX_REFS);
    const out: RefImage[] = [];
    for (const f of files) {
      const buf = await sharp(f.data)
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      out.push({ mimeType: "image/png", data: buf.toString("base64") });
    }
    return out;
  } catch { return []; }
}

type Slide = { slide: number; prompt: string; key?: string; data?: Buffer; assetUrl?: string; error?: string };

// One generated image, as base64 (provider-agnostic).
type GenImage = { mimeType: string; data: string };

// Gemini / Nano Banana Pro: text + inline reference images in a single call.
async function genGemini(ai: GoogleGenAI, prompt: string, images: RefImage[]): Promise<GenImage> {
  const parts: any[] = [{ text: prompt }, ...images.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.data } }))];
  const response = await ai.models.generateContent({ model: GEMINI_MODEL, contents: [{ role: "user", parts }] });
  const img = (response.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
  if (!img?.inlineData?.data) throw new Error("no image in Gemini response");
  return { mimeType: img.inlineData.mimeType || "image/png", data: img.inlineData.data };
}

// OpenAI GPT Image: /images/edits (multipart) when we have reference images to
// condition on, else /images/generations (JSON). Returns b64_json either way.
async function genOpenAI(apiKey: string, prompt: string, images: RefImage[]): Promise<GenImage> {
  const auth = { Authorization: `Bearer ${apiKey}` };
  let res: Response;
  if (images.length === 0) {
    res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ model: OPENAI_MODEL, prompt, size: "1024x1536", quality: "medium", n: 1 }),
    });
  } else {
    const form = new FormData();
    form.append("model", OPENAI_MODEL);
    form.append("prompt", prompt);
    form.append("size", "1024x1536");
    form.append("quality", "medium");
    for (const r of images.slice(0, 16)) {
      const ext = (r.mimeType.split("/")[1] || "png").replace("jpeg", "jpg");
      form.append("image[]", new Blob([new Uint8Array(Buffer.from(r.data, "base64"))], { type: r.mimeType }), `ref.${ext}`);
    }
    res = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: auth, body: form });
  }
  if (!res.ok) throw new Error(`OpenAI images → ${res.status} ${(await res.text()).slice(0, 200)}`);
  const b64 = (await res.json())?.data?.[0]?.b64_json;
  if (!b64) throw new Error("no image in OpenAI response");
  return { mimeType: "image/png", data: b64 };
}

// One generation with up to 3 attempts — clears OpenAI safety false-positives and
// transient network/model hiccups (a slide that just "won't generate" usually does
// on a retry). Backs off between tries.
async function genWithRetry(provider: Provider, apiKey: string, ai: GoogleGenAI | null, prompt: string, images: RefImage[]): Promise<GenImage> {
  const once = () => (provider === "openai" ? genOpenAI(apiKey, prompt, images) : genGemini(ai!, prompt, images));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await once();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < 3) {
        console.log(`  ↻ slide attempt ${attempt} failed (${msg.slice(0, 70)}) — retrying`);
        await new Promise((r) => setTimeout(r, 1200 * attempt));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Run an async fn over items with a concurrency cap.
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) { const it = queue.shift() as T; await fn(it); }
  });
  await Promise.all(workers);
}

const CONCURRENCY = 4;

// Generate one image per slide with the chosen provider. Character consistency: the
// first character slide is generated FIRST to establish an "anchor" (its render is
// reused as an extra reference), then every remaining slide is generated
// CONCURRENTLY so a 6-slide post isn't six serial round-trips. No key → stub.
async function generateSlides(plans: SlidePlan[], refs: RefImage[], conceptId: string, influencerId: string, provider: Provider): Promise<Slide[]> {
  const apiKey = process.env[providerKeyName(provider)];
  if (!apiKey) return plans.map((p, i) => ({ slide: i + 1, prompt: p.prompt }));

  const ai = provider === "gemini" ? new GoogleGenAI({ apiKey }) : null;

  const slides: Slide[] = plans.map((p, i) => ({ slide: i + 1, prompt: p.prompt }));
  let anchor: RefImage | null = null;

  const genOne = async (i: number): Promise<Buffer | null> => {
    const { prompt, usesCharacter, styleAnchor } = plans[i];
    try {
      // character slides: identity refs + anchor. graphic slides: the anchor once it
      // exists, else brand assets (uploaded "refs") seed the first card's design.
      const images: RefImage[] = usesCharacter
        ? [...refs, ...(anchor ? [anchor] : [])]
        : styleAnchor ? (anchor ? [anchor] : refs.slice(0, 3)) : [];
      const gen = await genWithRetry(provider, apiKey, ai, prompt, images);
      // force exactly 9:16 (1080x1920); smart-crop keeps the salient region in frame
      const cropped = await sharp(Buffer.from(gen.data, "base64"))
        .resize(OUT_W, OUT_H, { fit: "cover", position: "attention" })
        .png()
        .toBuffer();
      const key = await putSlide(conceptId, influencerId, i + 1, cropped);
      slides[i] = { slide: i + 1, prompt, key, data: cropped };
      return cropped;
    } catch (e) {
      slides[i] = { slide: i + 1, prompt, error: e instanceof Error ? e.message : String(e) };
      return null;
    }
  };

  // anchor first (serial) so the concurrent slides lock onto one face (character)
  // or one design system (graphic), then everything else runs concurrently
  const anchorIdx = plans.findIndex((p) => p.usesCharacter || p.styleAnchor);
  if (anchorIdx >= 0) {
    const cropped = await genOne(anchorIdx);
    if (cropped) anchor = { mimeType: "image/png", data: cropped.toString("base64") };
  }
  await mapLimit(plans.map((_, i) => i).filter((i) => i !== anchorIdx), CONCURRENCY, genOne);

  return slides;
}

// The ready-to-post ticket the Poster agent consumes: caption, hashtags, per-slide
// captions + the generated image paths, and a link back to the source concept.
function buildPostDescription(concept: Concept, slides: Slide[], refCount: number, conceptRef: { identifier: string; url: string }, inf: Influencer, hookId?: string, profile: "ugc" | "graphic" = "ugc"): string {
  const graphic = profile === "graphic";
  const out: string[] = [];
  out.push(`**Influencer:** ${inf.name}`, "");
  out.push("**Caption**", concept.caption || "", "");
  const tags = (concept.hashtags || []).map((h) => "#" + h).join(" ");
  if (tags) out.push("**Hashtags**", tags, "");

  // ugc: clean, copy-paste list of the per-slide on-screen text (overlaid in TikTok).
  // graphic: text is rendered INTO the cards — nothing to copy, so no list.
  const captions = graphic ? [] : slides
    .map((s, i) => ({ n: s.slide, text: (concept.script?.[i]?.onScreenText || "").trim() }))
    .filter((c) => c.text);
  if (captions.length) {
    out.push("**On-screen captions** — copy onto each slide in TikTok:", "");
    captions.forEach((c) => out.push(`${c.n}. ${c.text}`));
    out.push("");
  }

  out.push(graphic
    ? "**Slides** — text is baked into each card; check for typos (comment `regen N: fix …` to redo one):"
    : "**Slides** — add the matching caption onto each image in-app (images have no baked text):", "");
  slides.forEach((s, i) => {
    const cap = concept.script?.[i]?.onScreenText ? `"${concept.script[i].onScreenText}"` : "";
    out.push(`**${s.slide}.** ${cap}`.trim());
    if (s.assetUrl) out.push(`![slide ${s.slide}](${s.assetUrl})`);
    else if (s.key) out.push(`\`${s.key}\` _(stored — Linear upload failed)_`);
    else if (s.error) out.push(`⚠️ ${s.error}`);
    else out.push("_(not generated)_");
    out.push("");
  });
  out.push(`Format: ${concept.format || "9:16 image slideshow"} · ${refCount} reference image(s)`);
  out.push("", "---", `_From concept **${conceptRef.identifier}** — ${conceptRef.url}_`);
  out.push(`Influencer-ID: ${inf.id}`); // machine tag for the Poster — plain text so Linear doesn't remangle the markdown
  out.push(`Slides: ${slides.length}`);  // expected slide count — Poster refuses to post an incomplete set
  if (hookId) out.push(`Hook-ID: ${hookId}`); // links the post to its stored hook for analytics
  return out.join("\n");
}

async function processQueue(board: Board): Promise<void> {
  const tickets = await board.queue(STATES.queue);
  if (tickets.length === 0) {
    console.log(`· ${STATES.queue} empty`);
    return;
  }
  await loadSecrets(); // re-read each poll so keys saved after startup propagate without a restart
  const provider = await imageProvider();
  const hasKey = !!process.env[providerKeyName(provider)];
  console.log(`· image model: ${provider === "openai" ? "OpenAI GPT Image" : "Nano Banana Pro"}${hasKey ? "" : " (no key — stub mode)"}`);
  const style = (await loadProductBrief())?.visual || "";
  const influencers = (await loadInfluencers()).filter((i) => i.enabled);
  console.log(`· fanning out to ${influencers.length} influencer(s): ${influencers.map((i) => i.name).join(", ") || "(none)"}`);

  for (const issue of tickets) {
    console.log(`→ ${issue.identifier}  ${issue.title}`);
    try {
      await board.move(issue.id, STATES.working);
      const concept = (await extractConcept(issue)) as ConceptStash | null;
      if (!concept) {
        await board.comment(issue.id, "⚠️ Creator couldn't read a structured concept — moving to Generated.");
        await board.move(issue.id, STATES.done);
        continue;
      }
      // autopilot concepts are assigned to ONE influencer; manual concepts fan to
      // every account whose content profile matches the concept's (a ugc script
      // renders wrong on a graphic account and vice versa)
      const conceptProfile = concept.profile ?? "ugc";
      const targets = concept.influencerId
        ? influencers.filter((i) => i.id === concept.influencerId)
        : influencers.filter((i) => profileOf(i) === conceptProfile);
      if (targets.length === 0) {
        await board.comment(issue.id, concept.influencerId
          ? `⚠️ Assigned influencer "${concept.influencerId}" is missing or disabled — enable them on the Cast tab and re-queue.`
          : `⚠️ No enabled ${conceptProfile} accounts to fan out to — add/enable one on the Cast tab and re-run.`);
        await board.move(issue.id, STATES.done);
        continue;
      }

      notify("info", `🎨 Creator started — ${issue.identifier} → ${targets.map((t) => t.name).join(", ")}`, {
        url: issue.url, detail: concept.angle,
      });
      // fan out: one full post per target influencer, generated with that influencer's refs
      const summary: string[] = [];
      for (const inf of targets) {
        const refs = await loadRefImages(inf.id);
        const plans = planFor(concept, inf, style);
        const slides = await generateSlides(plans, refs, issue.identifier, inf.id, provider);
        const ok = slides.filter((s) => s.key).length;

        for (const s of slides) {
          if (!s.data) continue;
          try { s.assetUrl = await board.uploadBuffer(`slide-${s.slide}.png`, "image/png", s.data); }
          catch (e) { console.error("  upload failed:", e instanceof Error ? e.message : String(e)); }
          delete s.data; // free memory once uploaded
        }

        const post = await board.createIssue(
          `📮 [${inf.name}] ${concept.angle}`,
          STATES.post,
          buildPostDescription(concept, slides, refs.length, { identifier: issue.identifier, url: issue.url }, inf, concept.hookId, conceptProfile),
        );
        await board.relate(post.id, issue.id).catch((e) => console.error("  relation failed:", e.message));
        summary.push(`${inf.name}: ${hasKey ? `${ok}/${slides.length} img` : "plan"} → ${post.identifier}`);
        console.log(`  ✓ ${inf.name}: ${hasKey ? `${ok}/${slides.length} generated` : "plan"} → post ${post.identifier}`);
        const complete = ok === slides.length;
        notify(complete ? "success" : "warn",
          `📮 Post created — ${post.identifier} [${inf.name}] (${ok}/${slides.length} images) → Posting Queue`, {
          url: post.url, detail: `${concept.angle}${complete ? "" : " — ⚠️ incomplete set: the Poster will bounce it to Ready to Post for regen"}`,
        });
      }

      await board.comment(issue.id, `🎨 Fanned out to ${targets.length} influencer(s):\n${summary.map((s) => `- ${s}`).join("\n")}`);
      await board.move(issue.id, STATES.done);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ✗ ${msg}`);
      notify("error", `🎨 Creation failed — ${issue.identifier}`, { url: issue.url, detail: msg });
      await board.comment(issue.id, `⚠️ Creation failed: ${msg}`).catch(() => {});
    }
  }
}

// Regenerate a single slide image to disk (throws after retries on failure).
async function genOneSlide(provider: Provider, refs: RefImage[], prompt: string, usesCharacter: boolean): Promise<Buffer> {
  const apiKey = process.env[providerKeyName(provider)];
  if (!apiKey) throw new Error(`${providerKeyName(provider)} not set`);
  const ai = provider === "gemini" ? new GoogleGenAI({ apiKey }) : null;
  const gen = await genWithRetry(provider, apiKey, ai, prompt, usesCharacter ? refs : []);
  return sharp(Buffer.from(gen.data, "base64"))
    .resize(OUT_W, OUT_H, { fit: "cover", position: "attention" }).png().toBuffer();
}

// Regen loop: on a Ready-to-Post ticket, a comment like "regen 3: more natural
// light" makes the Creator regenerate just that slide in place. Idempotent — each
// request is acknowledged with "✅ Regenerated slide N" and skipped thereafter.
const REGEN_RE = /regen(?:erate)?\s+(?:slide\s+)?(\d+)\s*[:\-]?\s*([\s\S]*)/i;

async function processRegens(board: Board): Promise<void> {
  const tickets = await board.queue(STATES.review);
  if (!tickets.length) return;
  const provider = await imageProvider();
  const style = (await loadProductBrief())?.visual || "";
  const influencers = await loadInfluencers();

  for (const issue of tickets) {
    let nodes: { body?: string; createdAt: Date | string }[];
    try { nodes = (await issue.comments()).nodes as any; } catch { continue; }
    const at = (c: { createdAt: Date | string }) => new Date(c.createdAt).getTime();
    const lastAck = Math.max(0, ...nodes.filter((c) => /✅ Regenerated/.test(c.body || "")).map(at));
    const reqs = nodes
      .filter((c) => !(c.body || "").includes("✅") && REGEN_RE.test(c.body || "") && at(c) > lastAck)
      .sort((a, b) => at(a) - at(b));
    if (!reqs.length) continue;

    const d = issue.description ?? "";
    // tolerate Linear's markdown rewrites: **CON-66**, [CON-66](url), or bare CON-66
    const conceptId = /From concept\W*(CON-\d+)/.exec(d)?.[1];
    const hookId = /Hook-ID:\s*(h_\w+)/.exec(d)?.[1];
    const infId = /Influencer-ID:\s*([\w-]+)/.exec(d)?.[1] || /Influencer \*\*([\w-]+)\*\*/.exec(d)?.[1];
    const inf = influencers.find((i) => i.id === infId);
    if (!conceptId || !inf) { await board.comment(issue.id, "⚠️ Regen: couldn't find the concept or influencer for this post."); continue; }
    const conceptIssue = await board.issueByIdentifier(conceptId);
    const concept = conceptIssue ? ((await extractConcept(conceptIssue)) as ConceptStash | null) : null;
    if (!concept || !conceptIssue) { await board.comment(issue.id, `⚠️ Regen: couldn't load concept ${conceptId}.`); continue; }

    const refs = await loadRefImages(inf.id);
    const plans = planFor(concept, inf, style);
    const urlMap = new Map<number, string>();
    for (const m of d.matchAll(/!\[slide (\d+)\]\(([^)]+)\)/g)) urlMap.set(Number(m[1]), m[2]);

    for (const req of reqs) {
      const rm = REGEN_RE.exec(req.body || "");
      if (!rm) continue;
      const n = Number(rm[1]);
      const instruction = (rm[2] || "").trim();
      if (n < 1 || n > plans.length) { await board.comment(issue.id, `⚠️ Regen: slide ${n} is out of range (1–${plans.length}).`); continue; }
      const plan = plans[n - 1];
      const prompt = instruction ? `${plan.prompt} ${instruction}` : plan.prompt;
      console.log(`↻ regen ${issue.identifier} slide ${n}${instruction ? `: ${instruction.slice(0, 50)}` : ""}`);
      try {
        const rendered = await genOneSlide(provider, refs, prompt, plan.usesCharacter);
        await putSlide(conceptId, inf.id, n, rendered);
        urlMap.set(n, await board.uploadBuffer(`slide-${n}.png`, "image/png", rendered));
        await board.comment(issue.id, `✅ Regenerated slide ${n}${instruction ? ` (${instruction.slice(0, 60)})` : ""}.`);
        notify("success", `🎨 Regenerated slide ${n} — ${issue.identifier}`, { url: issue.url, detail: instruction || undefined });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await board.comment(issue.id, `⚠️ Regenerated slide ${n} failed: ${msg}`);
        notify("error", `🎨 Regen slide ${n} failed — ${issue.identifier}`, { url: issue.url, detail: msg });
      }
    }

    // rebuild the ticket with the updated image(s)
    const slides: Slide[] = plans.map((p, i) => {
      const url = urlMap.get(i + 1);
      return url ? { slide: i + 1, prompt: p.prompt, key: `slide-${i + 1}.png`, assetUrl: url } : { slide: i + 1, prompt: p.prompt };
    });
    await board.setDescription(issue.id, buildPostDescription(concept, slides, refs.length, { identifier: conceptId, url: conceptIssue.url }, inf, hookId, concept.profile ?? profileOf(inf)))
      .catch((e) => console.error("regen description update failed:", e instanceof Error ? e.message : String(e)));
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

  if (has("once")) { await processQueue(board); await processRegens(board); return; }

  const interval = Number(flag("interval") ?? 30) * 1000;
  console.log(`Polling ${STATES.queue} + regen requests in ${STATES.review} every ${interval / 1000}s… (Ctrl-C to stop)`);
  for (;;) {
    await processQueue(board).catch((e) => console.error("poll error:", e.message));
    await processRegens(board).catch((e) => console.error("regen poll error:", e.message));
    await sleep(interval);
  }
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
