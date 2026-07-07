import { join } from "path";
import { readFileSync } from "fs";
import { DATA_DIR } from "./paths";
import { usePg, getConfigValue } from "./db";

/**
 * Shared secret store. Env vars ALWAYS win; the store is the fallback so keys
 * entered in the UI flow through to the workers.
 *   fs (desktop): ~/.sweatshop/secrets.json (written by the app's Settings)
 *   pg (server):  app_config key 'secrets' (written by the server's Settings API)
 * Same trust level as a .env file either way.
 */
export const SECRETS_PATH = join(DATA_DIR, "secrets.json");

/** Load any stored secrets into process.env (without overriding real env). */
export async function loadSecrets(): Promise<void> {
  let data: Record<string, unknown> = {};
  if (usePg()) {
    try { data = (await getConfigValue<Record<string, unknown>>("secrets")) ?? {}; } catch { /* db not up yet */ }
  } else {
    try { data = JSON.parse(readFileSync(SECRETS_PATH, "utf8")); } catch { /* no secrets file yet */ }
  }
  for (const [k, v] of Object.entries(data)) {
    if (!process.env[k] && typeof v === "string" && v) process.env[k] = v;
  }
}
