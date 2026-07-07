import pg from "pg";

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

export async function getConfigValue<T = unknown>(key: string): Promise<T | null> {
  const { rows } = await pool.query("SELECT value FROM app_config WHERE key = $1", [key]);
  return rows.length ? (rows[0].value as T) : null;
}
export async function setConfigValue(key: string, value: unknown): Promise<void> {
  await pool.query(
    "INSERT INTO app_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [key, JSON.stringify(value)],
  );
}
