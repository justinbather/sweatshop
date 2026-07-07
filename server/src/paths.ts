import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

/** Repo root (server/src → up two). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RENDERER_DIR = join(ROOT, "renderer");
export const WEB_DIR = join(ROOT, "web");
export const AGENTS_DIR = join(ROOT, "agents", "generator");
/** Binary assets (refs/outputs). In Docker this is the mounted /data volume. */
export const DATA_DIR = process.env.SWEATSHOP_DATA_DIR || join(ROOT, "data");
