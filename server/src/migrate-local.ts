import { readFileSync, readdirSync, mkdirSync, copyFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { pool } from "./db.js";
import { setConfigValue } from "./db.js";
import { migrate } from "./migrate.js";
import { DATA_DIR } from "./paths.js";

/**
 * One-shot cutover: import the desktop app's ~/.sweatshop state into Postgres and
 * copy refs/outputs into DATA_DIR (the ./data bind mount in docker-compose).
 *
 *   DATABASE_URL=postgres://sweatshop:sweatshop@localhost:5433/sweatshop npm run migrate-local
 *
 * Idempotent (upserts). ⚠️ CUTOVER RULE: turn every agent OFF in the desktop app
 * before enabling agents on the server — both polling the same Linear columns will
 * double-generate and double-post. Agents are imported DISABLED for this reason.
 */
const SRC = join(homedir(), ".sweatshop");
const readJson = (f: string): any => { try { return JSON.parse(readFileSync(join(SRC, f), "utf8")); } catch { return null; } };

function copyDir(src: string, dst: string): number {
  let n = 0;
  let entries: string[] = [];
  try { entries = readdirSync(src); } catch { return 0; }
  mkdirSync(dst, { recursive: true });
  for (const e of entries) {
    const s = join(src, e);
    if (statSync(s).isDirectory()) n += copyDir(s, join(dst, e));
    else { copyFileSync(s, join(dst, e)); n++; }
  }
  return n;
}

async function main() {
  await migrate();

  // influencers
  const inf = readJson("influencers.json")?.influencers ?? [];
  for (const i of inf) {
    await pool.query(
      `INSERT INTO influencers (id, name, postiz_integration_id, timeslots, enabled, profile, design)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET name=$2, postiz_integration_id=$3, timeslots=$4, enabled=$5, profile=$6, design=$7`,
      [i.id, i.name, i.postizIntegrationId || "", i.timeslots || [], i.enabled !== false,
       i.profile === "graphic" ? "graphic" : "ugc", i.design ? JSON.stringify(i.design) : null],
    );
  }
  console.log(`influencers: ${inf.length}`);

  // store.json → hooks / posts / account_metrics / state
  const store = readJson("store.json") ?? {};
  for (const h of store.hooks ?? []) {
    await pool.query(
      `INSERT INTO hooks (id, text, angle, rationale, ticket, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [h.id, h.text, h.angle || "", h.rationale ?? null, h.ticket ?? null, h.createdAt || new Date().toISOString()],
    );
  }
  for (const p of store.posts ?? []) {
    await pool.query(
      `INSERT INTO posts (id, ticket, concept_id, hook_id, influencer_id, scheduled_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [p.id, p.ticket, p.conceptId ?? null, p.hookId ?? null, p.influencerId, p.scheduledAt || null, p.createdAt || new Date().toISOString()],
    );
  }
  for (const m of store.channelMetrics ?? []) {
    await pool.query(
      `INSERT INTO account_metrics (influencer_id, label, value, date)
       VALUES ($1,$2,$3,$4) ON CONFLICT (influencer_id, label, date) DO UPDATE SET value = EXCLUDED.value`,
      [m.influencerId, m.label, m.value, m.date],
    );
  }
  for (const [k, v] of Object.entries(store.state ?? {})) await setConfigValue(`state:${k}`, v);
  console.log(`hooks: ${(store.hooks ?? []).length} · posts: ${(store.posts ?? []).length} · metrics: ${(store.channelMetrics ?? []).length}`);

  // config / brief / secrets — agents imported DISABLED (cutover safety)
  const cfg = readJson("config.json"); if (cfg) await setConfigValue("config", cfg);
  const brief = readJson("brief.json"); if (brief) await setConfigValue("brief", brief);
  const secrets = readJson("secrets.json"); if (secrets) await setConfigValue("secrets", secrets);
  await setConfigValue("agents", {});
  console.log(`config: ${cfg ? "✓" : "–"} · brief: ${brief ? "✓" : "–"} · secrets: ${secrets ? Object.keys(secrets).length + " key(s)" : "–"} · agents: all DISABLED (enable on the server after stopping the desktop workers)`);

  // binary assets
  console.log(`refs: ${copyDir(join(SRC, "refs"), join(DATA_DIR, "refs"))} file(s) · outputs: ${copyDir(join(SRC, "outputs"), join(DATA_DIR, "outputs"))} file(s) → ${DATA_DIR}`);

  await pool.end();
  console.log("\n✔ migrated. Next: stop desktop agents → enable server agents in the dashboard.");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
