import { homedir } from "os";
import { join } from "path";

/**
 * Root for file-backed state and binary assets (refs/, outputs/, *.json in fs mode).
 * Desktop (Electron) leaves this unset → ~/.sweatshop. The Docker server sets
 * SWEATSHOP_DATA_DIR=/data (a mounted volume). Images stay on disk in both modes;
 * only structured state moves to Postgres in pg mode.
 */
export const DATA_DIR = process.env.SWEATSHOP_DATA_DIR || join(homedir(), ".sweatshop");
