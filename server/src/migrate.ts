import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { pool } from "./db.js";
import { ROOT } from "./paths.js";

/** Tiny forward-only migrator: applies db/migrations/*.sql in name order, once each. */
export async function migrate(): Promise<void> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())");
  const dir = join(ROOT, "db", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const { rows } = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [f]);
    if (rows.length) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      await client.query("COMMIT");
      console.log(`migrated: ${f}`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${f} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      client.release();
    }
  }
}
