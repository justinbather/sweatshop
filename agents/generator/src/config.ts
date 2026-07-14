import { join } from "path";
import { readFileSync } from "fs";
import { DATA_DIR } from "./paths";
import { usePg, getConfigValue } from "./db";

/**
 * Non-secret shared app settings (image model, autopilot run times).
 *   fs (desktop): ~/.sweatshop/config.json  ·  pg (server): app_config key 'config'
 */
export type AppConfig = { imageModel?: string; autopilotTimes?: string[]; reportTime?: string };

const FILE = join(DATA_DIR, "config.json");

export async function loadAppConfig(): Promise<AppConfig> {
  if (usePg()) {
    try { return (await getConfigValue<AppConfig>("config")) ?? {}; } catch { return {}; }
  }
  try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return {}; }
}
