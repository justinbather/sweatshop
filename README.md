# Sweatshop

An agentic TikTok content system: a Strategist writes hooks from performance data, a
Generator turns them into slideshow concepts, a Creator renders the images (UGC photo
or graphic-card style per account), and a Poster schedules them to each account's
TikTok inbox via Postiz — coordinated through a Linear board, monitored from a
pixel-art dashboard.

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

The original Electron desktop shell (the v1 POC) was retired in v2 — the same UI now
runs in the browser against the server. `server/src/migrate-local.ts` imports a v1
`~/.sweatshop` state into Postgres if you're coming from the desktop era.
