import express from "express";
import { createServer } from "http";
import { readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { migrate } from "./migrate.js";
import { mountAuth, requireAuth } from "./auth.js";
import { api } from "./api.js";
import { attachHub } from "./hub.js";
import { startEnabledAgents, shutdown } from "./workers.js";
import { pool } from "./db.js";
import { RENDERER_DIR, WEB_DIR, DATA_DIR } from "./paths.js";

/**
 * Sweatshop v2 server: applies migrations, serves the pixel dashboard (the same
 * renderer as the desktop app, bridged via web/studio-client.js), exposes /api +
 * /ws, and supervises the agent workers (STORAGE=pg).
 */
const PORT = Number(process.env.PORT || 8787);

async function main() {
  await migrate();
  mkdirSync(join(DATA_DIR, "refs"), { recursive: true });
  mkdirSync(join(DATA_DIR, "outputs"), { recursive: true });

  const app = express();
  if (!process.env.DASHBOARD_PASSWORD) console.warn("⚠ DASHBOARD_PASSWORD not set — dashboard is OPEN (fine locally, not on a public URL)");
  mountAuth(app);
  app.use(requireAuth);
  app.use("/api", api);
  app.get("/healthz", async (_req, res) => {
    try { await pool.query("SELECT 1"); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
  });

  // the dashboard: renderer/ verbatim, with the browser bridge injected first
  const indexHtml = readFileSync(join(RENDERER_DIR, "index.html"), "utf8")
    .replace('<script src="sprites.js"></script>', '<script src="studio-client.js"></script>\n  <script src="sprites.js"></script>');
  app.get("/", (_req, res) => res.type("html").send(indexHtml));
  app.use(express.static(WEB_DIR));
  app.use(express.static(RENDERER_DIR));

  const server = createServer(app);
  attachHub(server);
  server.listen(PORT, () => console.log(`sweatshop server → http://localhost:${PORT}`));

  await startEnabledAgents();

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
