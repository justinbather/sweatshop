# Sweatshop

An agentic TikTok content system: a Strategist writes hooks from performance data, a
Generator turns them into slideshow concepts, a Creator renders the images (UGC photo
or graphic-card style per account), and a Poster schedules them to each account's
TikTok inbox via Postiz — coordinated through a Linear board, monitored from a
pixel-art dashboard.

TypeScript throughout. Express API, Postgres, four supervised agent processes, Docker Compose.

## Run it

```bash
cp .env.example .env      # paste API keys (or enter them later in Settings)
docker compose up -d --build
open http://localhost:8787
```

That's Postgres + the server (API, agent workers, dashboard) in two containers.
Agents default to OFF on a fresh deploy — enable them on the Agents tab.

## Layout

```
server/     API + worker manager + WS log hub (Express, STORAGE=pg)
agents/     the four agents (Strategist · Generator · Creator · Poster)
renderer/   the dashboard UI (served by the server; web/studio-client.js is the bridge)
db/         Postgres schema migrations (applied automatically on boot)
data/       refs/ + outputs/ volume (reference images, generated slides)
docs/       HOSTING.md (deploy plan) · ATTRIBUTION.md (attribution guide)
ROADMAP.md  what's built, what's next
```

## How it works

**A kanban board is the queue.** Rather than running a message broker, each agent polls a named
column on a Linear board (team `CON`), does its work, and moves the ticket to the next column.
The board is the workflow state machine, which means the pipeline is inspectable and steerable
in a tool a human already uses — a ticket sitting in `Needs Approval` is a genuine approval gate,
not a UI over a hidden queue. Transitions go through Linear's GraphQL API in `server/src/linear.ts`.

**Agents are supervised child processes, not in-process workers.** `server/src/workers.ts` spawns
each agent as its own Node process, so one agent crashing or wedging can't take down the API. The
manager handles:

- crash detection and respawn with a fail counter and a five-second backoff
- an enabled/disabled flag persisted in Postgres, defaulting to off, so a fresh deploy never starts
  spending money on API calls by accident
- one-shot runs (`--once`) for testing a single agent pass without leaving it running
- a SIGTERM drain that stops respawns, asks workers to exit, and force-kills stragglers

**Logs stream to the dashboard over WebSockets.** `server/src/hub.ts` is a small hub on `/ws` that
fans agent stdout and status changes out to every connected dashboard client, so you can watch
what the agents are doing live instead of tailing container logs.

**Postgres holds the state and the feedback loop** — influencers, hooks, posts, images, tests, and
three tiers of metrics (`post_metrics`, `account_metrics`, `app_metrics`). The point of separating
them is to correlate content against business outcomes rather than engagement, which is what
`ROADMAP.md` calls the learning layer.

## Notes

The original Electron desktop shell (the v1 POC) was retired in v2 — the same UI now
runs in the browser against the server. `server/src/migrate-local.ts` imports a v1
`~/.sweatshop` state into Postgres if you're coming from the desktop era.

See `ROADMAP.md` for what's built versus planned.
