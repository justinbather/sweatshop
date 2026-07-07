import pg from "pg";

/**
 * Storage mode switch + shared Postgres pool. STORAGE=pg (server/Docker) routes the
 * data modules (influencers, store, brief, secrets, config) to Postgres; anything
 * else (the desktop app) keeps the original ~/.sweatshop JSON files. Binary assets
 * (refs/outputs) stay on disk under DATA_DIR in both modes.
 */
export const usePg = (): boolean => process.env.STORAGE === "pg";

let pool: pg.Pool | null = null;
export function db(): pg.Pool {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error("STORAGE=pg but DATABASE_URL is not set");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  }
  return pool;
}

/** app_config KV — brief / config / secrets / agents / state:* live here in pg mode. */
export async function getConfigValue<T = unknown>(key: string): Promise<T | null> {
  const { rows } = await db().query("SELECT value FROM app_config WHERE key = $1", [key]);
  return rows.length ? (rows[0].value as T) : null;
}
export async function setConfigValue(key: string, value: unknown): Promise<void> {
  await db().query(
    "INSERT INTO app_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [key, JSON.stringify(value)],
  );
}
