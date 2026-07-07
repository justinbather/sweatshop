# Sweatshop — Roadmap

An agentic content system for AI-influencer / short-form (TikTok, IG) content, with
a pixel-art Electron control dashboard. Coordination runs through a Linear board
(team **CON**); each agent is a worker that polls a column, does its job, and hands
off to the next column.

## The flywheel (target loop)

```
  you add winning-content tickets  ─┐
                                    ▼
        Generator  ──► spinoff variations ──► you approve
                                    ▼
        Creator (Nano Banana Pro) ──► images for approved variations
                                    ▼
        Poster ──► publishes to TikTok/IG
                                    ▼
     Post-analytics ──► store per-post metrics (views/likes/saves…)
                                    ▼
   App-analytics (RevenueCat/PostHog) ──► trials / downloads / revenue
                                    ▼
    Learning layer ──► correlate posts ↔ business outcomes,
                        steer/filter what gets made next
                                    └──────────► back to the top
```

The point: close the loop so the system learns what actually drives the business,
not just what gets views.

---

## Built — the POC (working end-to-end)

> **v2 note:** the Electron desktop shell described below was retired after the v2
> cutover — the same dashboard now runs in the browser against the Dockerized server
> (see README / docs/HOSTING.md). Agent behavior is unchanged.

The full pipeline runs: drop a reference ticket → concept variations → on-brand **9:16**
images → a TikTok draft you finish + publish. _(One more POC feature still to add — TBD.)_

- **Dashboard** — Electron pixel-art app ("Sweatshop"), branded icon + app name. Settings (keys + image-model toggle), Brand (product brief + per-agent briefs + character), reference-image uploader, live activity feed + logs (no mocks), per-agent polling on/off (`~/.sweatshop/agents.json`, always-on workers w/ auto-restart).
- **Keys** — Anthropic · Linear · Gemini · OpenAI · Postiz, entered in-app (`~/.sweatshop/secrets.json`); workers re-read each poll so a newly-saved key propagates **without a restart**.
- **Brand brief** — product brief + per-agent direction + AI-influencer character (`~/.sweatshop/brief.json`), injected into agent prompts.
- **Linear board (CON)** — coordination/routing; state = pipeline stage, each agent polls its column.
- **Generator** (bespoke, Opus 4.8): reads ticket + reference screenshots (vision), fans a ticket into N variation sub-issues (`Variations to create: N`), structured output; revise loop via `Revise`.
- **Approvals** — real `Needs Approval` tickets in-app; approve → `Creation Queue`.
- **Creator** (live): watches `Creation Queue` → per-slide single-image prompts (person→influencer / object→food) → generates with **Nano Banana Pro** *or* **OpenAI GPT Image** (Settings toggle) → forces exact **9:16 (1080×1920)** via smart-crop → uploads to Linear + writes a linked post ticket (caption, hashtags, copyable on-screen captions) in `Posting Queue`. Consistency via reference images + an **anchor** (first character render reused across slides). Modesty clause + one **retry** on OpenAI safety false-positives. Raw unbranded UGC (no logos/screens/phones).
- **Poster** (live → Postiz): watches `Posting Queue` → uploads slides + caption (incl. on-screen text) → **TikTok draft via UPLOAD** (`type:"now"`, `PUBLIC_TO_EVERYONE`) → `Drafted`; you finish overlays + publish in the TikTok app. Idempotency guard.

---

## Post-POC plan (v2 — close the flywheel)

> **Hosting plan:** the full move-to-hosted plan (server, Postgres+R2, web dashboard,
> cutover checklist) lives in [docs/HOSTING.md](docs/HOSTING.md) — it is the expanded,
> executable version of Workstream A below.

The POC proved the pipeline. v2 turns fire-and-forget into a system that **persists what
it makes, measures what happens, and feeds it back**. Four workstreams:

- **A. Foundation** — always-on backend (VPS/VM), managed **Postgres + pgvector**, S3-style object store.
- **B. System of record** — hooks, posts, images, analytics as first-class DB rows (below). Postgres becomes truth; **Linear stays the human control/approval surface**.
- **C. Agent restructure** — split the Generator into a **Hook** agent + a **Post-generation** agent; add an **Analytics** agent.
- **D. Optimization loops** — A/B hooks, a **winning-variations** agent, and a **Pinterest image library** the Creator can pull from instead of generating.
- **E. Account profiles** — content style becomes a property of the account (`ugc` vs `graphic`), so new TikTok accounts with different formats reuse the whole pipeline. Detail below.

### Data model

```
influencers   (id, name, notes, created_at)

hooks         (id, text, angle, source, embedding, created_at)

posts         (id, hook_id→hooks, influencer_id→influencers, description,
               tiktok_id, status, posted_at, test_id→tests (nullable),
               variant_label, created_at)

images        (id, s3_url, influencer_id→influencers (nullable), gen_ai bool,
               type, tags text[], embedding, last_used_at, use_count, created_at)

post_images   (post_id→posts, image_id→images, position)   -- join; cover = position 1

tests         (id, name, hypothesis, variable, created_at) -- variable: hook | cover | content

post_metrics  (id, post_id→posts, views, likes, saves, comments, shares, captured_at)

account_metrics (id, influencer_id→influencers, followers, captured_at)
```

Design notes:
- **`post_images` join, not an array** — images are reused across posts; the join makes reuse + "best cover" (`position = 1`) queryable, slide order preserved.
- **Tests, not pairwise A/B** — a `tests` row groups N variants; `variable` records what's held-vs-varied. This is the only *causal* signal — aggregate per-image performance is correlational (an image inherits its post's outcome).
- **pgvector `embedding`** on images + hooks — tags for exact filters (`'blueberries' = ANY(tags)`), embeddings for fuzzy retrieval + hook dedupe.
- **`last_used_at` + `use_count`** — reuse picker prefers least-recent / least-used so the library doesn't get stale.
- **`account_metrics` split from `post_metrics`** — followers is account-level, not per-post.

Queries this unlocks: best hooks · best images · best **cover** images · tests (same hook, different first image) · reusable generated images · reusable Pinterest images (freshness-gated).

### Build order (dependencies)

1. **Foundation (A)** — ✅ **BUILT (local Docker)**: full Postgres schema + migrations,
   dual-backend storage (`STORAGE=fs|pg`), server (API + worker manager + WS + web
   dashboard), `docker-compose.yml`, cutover importer. See docs/HOSTING.md status
   block for the quickstart. Remaining: remote host + auth + S3 (images are on the
   `./data` volume for now).
2. **Persist (B)** — hooks/posts/metrics already flow to Postgres in pg mode; remaining: images table rows + S3 keys per generated slide.
3. **Split Generator (C)** — Hook agent (hooks→DB) → Post agent (expands a hook into script + images).
4. **Analytics agent (C)** — pull per-post metrics (Postiz/TikTok) → `post_metrics`. *Needs 1–2.*
5. **A/B hooks (D)** — hold content constant, vary the hook, attribute via metrics. *Needs hooks first-class + analytics.*
6. **Pinterest library (D)** — ingest→S3, vision-categorize + embed → `images`; the Creator's per-slide split becomes **generate (UGC/person) vs retrieve (food match)**. Independent once the store exists.
7. **Winning-variations agent (D)** — reads posts + metrics, makes new variants of what converts. *Data-gated — genuinely last.*
8. **Account profiles (E)** — independent of 1–7; can ship on the POC file store today. Detail below.

### Workstream E — account profiles (UGC vs graphic slideshows)

> **Status: steps 1, 2, 3(a) and 5 are BUILT** (profile + design tokens on the Cast,
> per-profile Generator prompt packs with profile-grouped generation, image-model
> graphic renderer with style-anchor chain + brand-asset seeding, Strategist hook
> registers, graphic post tickets without the caption-copy list, regen loop works
> for both). Remaining: 3(c) hybrid sharp/SVG text compositing, and the per-account
> `DIRECT_POST` flip (step 4).

**Goal:** run a second (third, nth) TikTok account whose slideshows are *designed
graphics* (typography cards, listicle graphics, stat slides) instead of UGC photos —
without forking the pipeline.

**The insight:** the pipeline (Strategist → Generator → Creator → Poster, Linear
routing, approval gates, regen loop, slot scheduling, hook A/B, the store) is already
content-agnostic. UGC is baked into exactly three places: the Generator's prompt, the
Creator's renderer, and the "overlay text in TikTok" finishing step. So: make
**content style a property of the account** — a `profile` — and have those three
places branch on it. "Influencer" quietly generalizes to **account archetype** =
channel + identity + rendering strategy.

- A **ugc** account's identity = reference images (a face) → photo renderer.
- A **graphic** account's identity = a design system (palette, fonts, layout
  templates, voice) → graphic renderer. Same Cast slot, different payload.

**Step 1 — `profile` on the Cast** _(ships first, zero behavior change)_
- `influencers.json` / Cast card gains `profile: "ugc" | "graphic"` (default `ugc`)
  and, for graphic accounts, `design: { palette: [..], fonts: {display, body},
  templates: ["stat-card","numbered-list","quote"], voice: "authoritative" }`.
- Cast UI: profile picker; graphic profile swaps the face-refs uploader for design
  tokens + brand-asset uploads (logo, background textures — stored in the same
  `refs/<id>/` dir, they're just assets not faces).
- Connect the new TikTok channel in Postiz, map it on the Cast card as usual.
- v2 schema: `influencers` gains `profile text` + `design jsonb`;
  `images.type` gains `'graphic'`.

**Step 2 — per-profile Generator prompt packs**
- `prompt.ts` becomes profile-keyed blocks: the current SYSTEM_PROMPT is the `ugc`
  pack; a new `graphic` pack inverts the photo rules — each script beat's
  `onScreenText` IS the slide (exact final copy, text-light, one idea per slide) and
  `beat` becomes a layout hint (`"stat-card: 73% big, source small"`,
  `"numbered-list item 3"`). Concept schema unchanged — it already carries
  angle/hook/script/caption.
- Selection: the autopilot ticket's hook assignment names the account → the worker
  passes that account's profile into `generate()`; manual tickets default to `ugc`
  (or a `Profile: graphic` line on the ticket).

**Step 3 — Creator renderer branch** _(the real fork; roll out in this order)_
- **(a) Image-model graphics first** (zero new build, validates the account):
  `planSlides` branches on profile — graphic prompts = design tokens + exact slide
  text + "flat designed graphic, bold typography, 9:16, no photograph". Nano Banana
  Pro renders typography well; expect occasional typos/brand drift. No reference
  images, no anchor, no modesty clause needed on this branch.
- **(c) Hybrid as the end state** (when the account earns it): image model generates
  only the *background* (texture/imagery — where models shine), text composited
  **programmatically** with `sharp` + SVG templates (already a dependency: SVG →
  `sharp.composite` over the background at 1080×1920). Deterministic, pixel-perfect
  brand fonts/colors, no safety filters, ~free per slide. Templates = one SVG
  function per `design.templates` entry.
- (b) Fully templated (satori/HTML→PNG) only if volume demands total consistency.
- Regen loop works unchanged (`regen 3: make the stat bigger` re-renders one slide).

**Step 4 — Poster + finishing step shrinks**
- Graphic slides have text baked in → the TikTok-inbox step is just music + publish.
  Post ticket omits the "copy on-screen captions" section for graphic posts.
- Once trusted, graphic accounts can flip `content_posting_method` to `DIRECT_POST`
  (per-account setting on the Cast card) → fully hands-off for that account, while
  UGC accounts keep the manual overlay flow.

**Step 5 — Strategist awareness**
- `skills/tiktok-hooks.md` gains per-profile sections (ugc = personal/first-person;
  graphic = authoritative/listy). The Strategist already assigns hooks to accounts —
  it writes each hook in the target account's register.
- Free experiment unlocked: same topic as UGC vs graphic = the `tests` table's
  `variable: 'content'` case, attributed via the existing post↔hook links.

**Effort:** step 1 ≈ half a day; steps 2+3a ≈ a day; 3c ≈ a day when warranted;
4–5 ≈ hours. Each step ships independently; a third archetype later (meme account,
screenshot-thread account) = one more prompt pack + renderer, not a new pipeline.

### Decisions still open
- **Host/DB stack:** Supabase (Postgres + pgvector + S3-compatible storage + webhooks, one box) vs **Neon + Cloudflare R2**. Leaning Supabase for the consolidation.
- **First v2 push:** Foundation + persist only, or also land the Hook/Post split?
- Confirmed: **Postgres + pgvector** (relational, *not* a graph DB); **no Kafka** (a DB/Redis queue is enough at this scale).

### App-analytics (parallel track — **pulled forward, now the gating work**)
- **PostHog** (hosted MCP) + **RevenueCat** (REST v2 + webhooks) → `account`/business metrics, so the learning layer can correlate posts ↔ trials/revenue, not just views.
- Priority raised by the growth plan below: scaling accounts without install/revenue
  attribution = scaling blind.

---

## Growth plan (business — July 2026)

**State:** ~100 paying users · $600 MRR · ~$1k/mo total revenue (Nourish).

**Strategy:** organic TikTok accounts (this system) as the growth engine AND the
creative R&D lab → scale the accounts the data says convert → turn on ads once
revenue supports a real test budget, seeded with proven organic creative → add a
branded/founder account. Organic isn't just "before ads" — the winning organic posts
become the ad creative (TikTok **Spark Ads** boost existing posts), so the two phases
compound.

### The attribution problem (funnel reality)
The funnel is TikTok → link in bio, but **TikTok suppresses outbound App Store
navigation** — most installs come from users *searching the app name on the App
Store*. So link/UTM attribution alone structurally cannot work here. The stack that
does:

1. **Onboarding survey (primary).** "How did you hear about us?" with *per-account*
   options (e.g. "TikTok — Sadie", "TikTok — Chelsea", "TikTok — [graphics acct]",
   "App Store search", "Friend", "Other"). Post-install self-report is the standard
   workaround for exactly this funnel — big consumer apps run on it. Feed the answer
   into PostHog as a person property → joins to revenue via RevenueCat. At current
   volume even manual review works.
2. **Posting-time ↔ install correlation (automated, already half-built).** The store
   records every post's account, hook, and scheduled time. Pull daily installs/trials
   (App Store Connect API or RevenueCat) and correlate lift in the 24–48h window
   after each account's posts. Accounts posting at different times = per-account
   signal without any user action. Noisy at small volume; gets sharper as cadence
   and volume grow. This becomes the Analytics agent's job.
3. **Apple custom product pages (CPPs) per account.** Each account's bio link points
   at its own CPP URL — App Store Connect reports views/installs per page. Only
   captures the minority who click through the bio, but it's clean signal.
4. **App Store Connect source breakdown (sanity check).** Search vs referrer split
   confirms the funnel shape and catches shifts.

None of these is complete alone; together (survey as workhorse, correlation as the
automated backbone) they're enough to rank accounts/formats by revenue.

> **Implementation guide:** the full build-out — survey wiring (PostHog identify +
> stable option keys), RevenueCat→PostHog revenue join, the Sweatshop collectors +
> weekly Discord attribution digest, CPP setup, and sequencing — lives in
> [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md).

### Milestones (in order)
1. **Graphics account test** — running now (Workstream E built).
2. **Attribution** — onboarding survey in the app + RevenueCat/PostHog collectors +
   per-account CPPs. *Gates everything below.*
3. **Scale by data** — add/kill accounts based on attributed trials, not views.
   Platform hedge: mirror content to IG Reels / YouTube Shorts via Postiz (near-zero
   marginal cost; de-risks single-platform dependence). Keep health-claim guardrails
   tight in the brief as volume grows.
4. **Founder/brand account** — don't defer too long: founder content converts at
   early stage, compounds trust, and is the one format the machine can't make.
   Middle path: a third "feature-highlight" profile (screen recordings + captions)
   the pipeline drives, founder videos added manually.
5. **Ads — explicit trigger, not a vibe:** ≈ **$3–5k MRR** (funds ~$2k/mo of ad
   spend for a 3-month test without touching runway). Launch with Spark Ads on the
   top attributed organic posts; the corpus of proven hooks is the moat most app
   founders don't have when they start paying for traffic.

---

## Key decisions & constraints

- **Linear is the router for the POC.** State = pipeline stage; agents poll their column.
  **v2:** Postgres becomes the system of record; Linear stays the human control/approval
  surface (don't rip it out — evolve it).
- **Datastore = Postgres + pgvector** (relational, not a graph DB — the hook→post→image→metrics
  relationships are a clean relational DAG; pgvector covers similarity/retrieval). Images
  in an **S3-style object store**. **No Kafka** — a DB/Redis queue suffices at this scale.
- **Orchestrator = supervisor + policy, not a router** — budget/credit caps, rate
  limits, scheduling, restarts. Not built yet; folds the worker registry in later.
- **Agents stay bespoke** (hand-coded). No generic "create an agent from a form".
- **Posting = Postiz** (hosted, platform-approved OAuth), not Ayrshare. Draft-to-TikTok
  via `UPLOAD`; same provider returns per-post metrics for the Analytics agent.
- **Image model = Nano Banana Pro or OpenAI GPT Image** (toggle). Gemini is more permissive
  for influencer content + native 9:16; OpenAI's edits safety filter is stricter (mitigated
  by a modesty clause + one retry).
- **Analytics**: own-account data is accessible; PostHog via MCP, RevenueCat via REST.
- **Back-half → always-on service.** RevenueCat webhooks need a public endpoint and
  collection runs on a schedule; this doesn't belong in the desktop app.
- **Model**: `claude-opus-4-8` (no `temperature` — variety steered by prompt).

---

## Multi-user / distribution _(parked)_

- **Path A (now, zero infra):** only one person runs the Generator (per-agent toggle);
  both create tickets + approve via the shared Linear board.
- **Path B (with the service):** agents run on the always-on host; desktop app is a
  thin control/monitor client. Package the app (`electron-builder` → dmg/exe;
  compile the worker to JS) so a partner can install it.
- Shared **product brief** should live on the service, not per-laptop.

---

## Gamification (this is a far future enhancement)
- Using revenue data from RevenueCat, the user unlocks more office space, nicer desks etc as the revenue hits certain targets

---

## Open questions

- Host/DB stack: **Supabase** (all-in-one) vs **Neon + Cloudflare R2** — and where the workers run (Fly.io / Railway / Hetzner).
- First v2 push: Foundation + persist only, or also land the Hook/Post split?
- Postiz: hosted to start, self-host later? Confirm cost tier + carousel support on the chosen plan.
- Learning layer: correlation dashboards first; revisit "auto-decide" after a corpus.

---

## Cleanup / TODO

- **Generator `suggestedModel` is stale** — still suggests Higgsfield models
  (Soul 2.0, Kling, etc.) in the concept schema/prompt. The Creator ignores it and
  always uses Nano Banana Pro, so it's cosmetic. Drop the field (or repoint it) and
  remove the Higgsfield model references from `schema.ts` / `prompt.ts`.
- Strip the leftover unused `HIGGSFIELD_API_KEY` from `~/.sweatshop/secrets.json`.

---

## References

- [PostHog MCP](https://posthog.com/docs/model-context-protocol)
- [Postiz (open-source scheduler, MCP + API)](https://github.com/gitroomhq/postiz-app)
- [Ayrshare API](https://www.ayrshare.com/docs/whatsnew/latest)
- [TikTok Content Posting API (2026)](https://zernio.com/blog/tiktok-developer-api)
- [Instagram Graph API (2026)](https://zernio.com/blog/instagram-graph-api)
- [Higgsfield Soul ID (character consistency)](https://higgsfield.ai/blog/sould-id-best-character-consistency)
