# Hosting Sweatshop — the plan

> **Status (v2 SHIPPED for local Docker):** Phases 0–3 are built — dual-backend
> storage (`STORAGE=fs|pg`), full Postgres schema (`db/migrations/`), the server
> (`server/`: API mirroring `window.studio`, worker manager with SIGTERM drain, WS
> log hub, web dashboard), `web/studio-client.js`, Dockerfile + `docker-compose.yml`,
> and the cutover importer (`server/src/migrate-local.ts`).
>
> **Quickstart:**
> ```bash
> cp .env.example .env            # paste API keys (or enter them later in Settings)
> docker compose up -d --build    # postgres + server
> open http://localhost:8787      # the same pixel dashboard, in a browser
> # cutover from the desktop app (optional):
> #   1) turn every agent OFF in the desktop app
> #   2) cd server && DATABASE_URL=postgres://sweatshop:sweatshop@localhost:5433/sweatshop npm run migrate-local
> #   3) enable agents in the hosted dashboard (they import disabled on purpose)
> ```
> Images: the asset layer is dual-backend — `./data` volume by default, or any
> S3-compatible store (set `S3_ENDPOINT` + keys) which makes the container fully
> **stateless**. Agents default to **off** on a fresh server.

## Deploy: Supabase + Railway/Fly (the chosen stack)

Supabase provides Postgres **and** S3-compatible Storage; one stateless container
runs the server + workers. No volume anywhere.

**1. Supabase project**
- Create the project → Project Settings → **Database** → copy the *session pooler*
  connection string → `DATABASE_URL`.
- **Storage** → create a private bucket `sweatshop` → Project Settings → Storage →
  **S3 connection**: copy endpoint + region, create access keys →
  `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
  `S3_BUCKET=sweatshop`.

**2. Move the data** (from the local Docker stack)
```bash
# schema + rows: dump local pg, restore into Supabase
docker compose exec -T db pg_dump -U sweatshop sweatshop > dump.sql
psql "$DATABASE_URL" < dump.sql
# images: ./data → the bucket
cd server && S3_ENDPOINT=… S3_REGION=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
  S3_BUCKET=sweatshop npm run assets-to-s3
```

**3. The container** — Railway (or Fly): new service from this repo (Dockerfile is
auto-detected), paste all env vars (`DATABASE_URL`, `S3_*`, the API keys, `TZ`,
`LINEAR_TEAM`). No volume needed. Set the deploy strategy to **stop-then-start**
(never rolling): two live instances would double-post.

**4. Protect it** — the dashboard can spend money. Cloudflare Access in front of the
Railway domain, or keep it un-exposed and reach it over Tailscale.

**5. Cut over** — `docker compose down` locally (or disable local agents) **before**
enabling agents on the hosted dashboard. One stack polls Linear, ever.

Local dev still works unchanged (`docker compose up` = local pg + volume); hosted
mode is purely env-var driven.

Goal: the whole system — agents, datastores, dashboard — runs on a server 24/7.
Laptop closed, autopilot still posts. This is the v2 "Foundation" workstream from
ROADMAP.md expanded into an executable plan.

## Why this is a re-homing, not a rewrite

The POC accidentally has the right seams:

1. **`window.studio` (preload.js)** — the entire UI talks to the backend through one
   typed bridge (`secrets`, `brief`, `refs`, `influencers`, `postiz`, `agents`,
   `approvals`, `pipeline`, `config`, `worker.onLog`). Re-implement that same
   interface over HTTP + WebSocket and the renderer runs unchanged as a website.
2. **Small storage modules** — all persistence goes through a handful of files:
   `store.ts`, `influencers.ts`, `secrets.ts`, `brief.ts`, plus `config.json` reads
   in `creator.ts`/`strategist.ts` and image dirs (`refs/`, `outputs/`). Swap their
   internals from `fs` to Postgres/S3 and the agents run unchanged.
3. **Workers are already headless** — each agent is a poll loop with `--once`/`--check`
   modes; Electron only spawns them. A server process manager replaces `main.js`'s
   spawn logic.
4. **Linear stays the router** — approval gates, regen comments, queue columns are
   all untouched. Only *where the agents run* changes.

```
                       ┌────────────────────── server (1 container) ──────────────────────┐
 browser ── HTTPS/WS ──┤  API (Fastify)   worker manager (strategist·generator·creator·   │
 (dashboard)           │  /api/* + WS logs        ·poster, in-process loops)              │
                       └──────┬──────────────────────┬─────────────────────┬──────────────┘
                              │                      │                     │
                        Postgres (+pgvector)   S3/R2 (refs, outputs)   external APIs
                        hooks·posts·metrics·                           Linear · Anthropic ·
                        influencers·brief·config                       Gemini/OpenAI · Postiz
```

## Stack decisions

| Concern | Choice | Why |
|---|---|---|
| Language | **TypeScript, one Node service** | All four agents are already TS; the Go-orchestrator idea from CLAUDE.md would be a rewrite with no payoff at this scale. |
| DB | **Managed Postgres + pgvector** (Neon or Supabase) | Roadmap decision; free tier is plenty; pgvector ready for embeddings. |
| Objects | **Cloudflare R2** (S3 API) | No egress fees (images get downloaded by Postiz + dashboard); S3-compatible so `@aws-sdk/client-s3` works. |
| Host | **Fly.io or Railway** (container) — Hetzner VPS + compose if cost matters | One Dockerfile either way; Fly/Railway give deploys + logs + restarts with zero ops. |
| API server | **Fastify + ws** | Small, typed, fast enough forever here. |
| Auth (v1) | **Cloudflare Access or Tailscale** in front | Zero auth code while single-user; add real auth (Auth.js) when multi-user. |
| Secrets | **Host env vars** | Not in the DB. Settings panel becomes status display (set/unset) instead of an editor. |
| Queue/webhooks | **Keep polling Linear** (30s) | Webhooks are an optimization, not a requirement; add later behind the same worker functions. |

## Target layout

```
sweatshop/
  agents/generator/        # agent logic (unchanged call signatures)
    src/storage/           # NEW: storage interface + fs and pg/s3 impls
  server/                  # NEW: Fastify app
    src/api/               # /api/* — mirrors the window.studio surface 1:1
    src/workers/           # in-process manager: enable flags, clocks, SIGTERM drain
    src/ws.ts              # log stream + agent status broadcast
    Dockerfile
  web/                     # renderer/ served statically +
    studio-client.js       # NEW: window.studio implemented over fetch/WS
  db/migrations/           # SQL migrations
  scripts/migrate-local.ts # one-shot: ~/.sweatshop → Postgres + R2
```

---

## Phase 0 — extract the seams (local, no behavior change)

The point: after this phase the app still runs 100% locally, but every read/write
goes through an interface with a swappable backend.

1. **`storage/` module** with one interface, `FsStorage` impl first:
   - `hooks/posts/metrics` (today `store.ts` → store.json)
   - `influencers` (influencers.json) — includes `claimSlot` (move the slot math to
     SQL later: `max(scheduled_at)` per influencer instead of schedule-state.json)
   - `brief`, `config` (brief.json, config.json — kill the scattered
     `readFileSync(CONFIG_FILE)` in creator.ts/strategist.ts)
   - `refs`: `listRefs(influencerId) → {data, mimeType}[]`, `putRef`, `deleteRef`
   - `outputs`: `putSlide(conceptId, infId, n, buf)`, `listSlides(conceptId, infId) → Buffer[]/streams`
     (poster currently reads paths off disk — change it to consume buffers/streams
     so S3 objects work; Postiz upload already takes bytes)
2. **Worker entry refactor** — export each agent's cycle (`runCycle`, `processQueue`,
   `processRegens`, `runOnce`) so a manager can drive them in-process. Keep the CLI
   `main()`s working (dev tool).
3. **Config-driven single knob**: `STORAGE=fs|hosted` env selects the impl.

Exit test: full autopilot run locally on `FsStorage` — identical behavior.
Estimated effort: the largest refactor, ~a day.

## Phase 1 — stand up the data layer

1. Create Neon/Supabase project (+ `CREATE EXTENSION vector`), R2 bucket.
2. Migrations (roadmap schema, abbreviated):

```sql
CREATE TABLE influencers (id text PRIMARY KEY, name text NOT NULL,
  postiz_integration_id text, timeslots text[] DEFAULT '{}',
  enabled boolean DEFAULT true, created_at timestamptz DEFAULT now());

CREATE TABLE hooks (id text PRIMARY KEY, text text NOT NULL, angle text,
  rationale text, ticket text, embedding vector(1536), created_at timestamptz);

CREATE TABLE posts (id text PRIMARY KEY,          -- postiz id
  ticket text NOT NULL, concept_id text, hook_id text REFERENCES hooks(id),
  influencer_id text REFERENCES influencers(id), status text DEFAULT 'scheduled',
  scheduled_at timestamptz, test_id text, variant_label text, created_at timestamptz);

CREATE TABLE images (id text PRIMARY KEY, s3_key text NOT NULL,
  influencer_id text REFERENCES influencers(id), gen_ai boolean DEFAULT true,
  type text, tags text[] DEFAULT '{}', embedding vector(1536),
  last_used_at timestamptz, use_count int DEFAULT 0, created_at timestamptz);

CREATE TABLE post_images (post_id text REFERENCES posts(id),
  image_id text REFERENCES images(id), position int, PRIMARY KEY (post_id, image_id));

CREATE TABLE account_metrics (id bigserial PRIMARY KEY,
  influencer_id text REFERENCES influencers(id), label text, value numeric,
  date date, captured_at timestamptz, UNIQUE (influencer_id, label, date));

CREATE TABLE post_metrics (id bigserial PRIMARY KEY, post_id text REFERENCES posts(id),
  label text, value numeric, captured_at timestamptz);  -- reserved (no per-post source yet)

CREATE TABLE tests (id text PRIMARY KEY, name text, hypothesis text,
  variable text CHECK (variable IN ('hook','cover','content')), created_at timestamptz);

CREATE TABLE app_config (key text PRIMARY KEY, value jsonb);  -- brief, config, agent enables
```

3. **`PgStorage` + S3 impl** of the Phase-0 interface (`pg` + `@aws-sdk/client-s3`).
4. **`scripts/migrate-local.ts`** — one-shot import: store.json → hooks/posts/
   account_metrics; influencers.json → influencers; brief/config → app_config;
   `refs/**`, `outputs/**` → R2 (key scheme `refs/<inf>/<file>`,
   `outputs/<concept>/<inf>/slide-N.png`) with `images` rows for outputs.

Exit test: run the agents locally with `STORAGE=hosted` against the real DB/bucket.

## Phase 2 — the server

1. **`server/`** Fastify app:
   - `/api/*` mirroring `window.studio` 1:1 (the main.js IPC handlers are the spec —
     secrets status, brief, refs [S3 presigned upload for the web UI], influencers,
     postiz integrations proxy, agents list/enable/runOnce, approvals list/resolve,
     pipeline counts/stats).
   - **Worker manager** replaces main.js spawning: each agent runs as an in-process
     loop; enable flags live in `app_config`; `runOnce` calls the exported cycle
     directly (no child processes). Per-agent **Postgres advisory lock** so two
     server instances (deploy overlap!) can never double-run an agent — this is the
     hosted version of the double-posting guard.
   - **Graceful drain**: SIGTERM → stop starting new tickets, finish the current
     one (bounded ~90s), exit. Deploys stop being able to strand tickets mid-state.
   - **WS**: broadcast log lines + agent status (replaces `worker:log` IPC); ring
     buffer of last ~200 lines for reconnects.
2. **Dockerfile** (node:22-slim, `npm ci`, esbuild bundle, non-root) + deploy.
   Env: `DATABASE_URL, S3_*, ANTHROPIC_API_KEY, LINEAR_API_KEY, GEMINI_API_KEY,
   OPENAI_API_KEY, POSTIZ_API_KEY, LINEAR_TEAM=CON`.
3. `/healthz` (DB ping + worker heartbeats) wired to the platform's health checks.

Exit test: kill the laptop; a scheduled Strategist run produces two Ready-to-Post
tickets and, after approval, scheduled TikTok drafts.

## Phase 3 — hosted dashboard

1. **`web/studio-client.js`** — implements `window.studio` over `/api` + WS
   (`worker.onLog` ⇒ WS subscription; everything else ⇒ fetch). Loaded before
   `app.js` instead of Electron's preload.
2. Serve `renderer/` + client statically from the server. Same pixel UI, in a browser.
3. Put **Cloudflare Access** (or Tailscale) in front — the dashboard can approve
   posts and spend money; it must not be public.
4. Electron app: either retire it, or keep it as a shell that loads the hosted URL
   (nice-to-have, zero logic left in it).

## Phase 4 — ops hardening

- **Cutover discipline (the one dangerous moment):** local workers OFF before server
  workers ON — both polling the same Linear columns means double image spend or
  double drafts. Checklist: disable all agents in the app → run migrate-local →
  enable agents on the server → verify one full run → archive `~/.sweatshop`.
- **Spend guards:** daily caps in `app_config` (`maxImageGensPerDay`,
  `maxClaudeCallsPerDay`); workers check a counters table before spending. An
  autopilot bug should cost a day's cap, not a month of credits.
- **Alerting:** any `⚠/✗` worker line → Discord/Telegram webhook. You stop reading
  logs; failures come to you.
- **Backups:** managed-PG automatic backups + weekly R2 lifecycle copy; store.json
  era is over, but the migration script doubles as a restore-shape reference.
- **Metrics collectors** (from ROADMAP Phase 2): the always-on host is finally the
  right place for RevenueCat webhooks + PostHog pulls → `account_metrics` and the
  learning layer.

## What deliberately does NOT change

- Linear board = routing + approval gates + regen comments (the human surface).
- Agent logic, prompts, the hooks skill file, image pipeline, Postiz draft flow.
- The pixel dashboard UI (only its transport changes).

## Cost & effort

- Infra: Neon/Supabase free tier + R2 (~$0 at this volume) + Fly/Railway ~$5–10/mo
  (or Hetzner ~€4). API usage (images + Claude) stays the dominant cost.
- Effort, in order: Phase 0 ≈ 1 day (the real work — storage interface + worker
  export), Phase 1 ≈ ½ day, Phase 2 ≈ 1–1½ days, Phase 3 ≈ ½ day, Phase 4 ongoing.
  Roughly 3–4 focused days end-to-end, each phase independently shippable and
  reversible (the fs backend keeps working throughout).

## Open questions (decide at each phase, not now)

- Neon (pure Postgres) vs Supabase (also gives storage + auth — could replace R2
  and Cloudflare Access in one).
- Multi-user: when a partner needs a login, add Auth.js + per-user roles; the API
  surface doesn't change.
- Linear webhooks to replace polling (latency nicety; not needed at 30s cadence).
