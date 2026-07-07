import { spawn, type ChildProcess } from "child_process";
import { AGENTS_DIR, DATA_DIR } from "./paths.js";
import { getConfigValue, setConfigValue } from "./db.js";
import { broadcastLog, broadcastAgents } from "./hub.js";

/**
 * Worker manager — the server-side port of the Electron supervisor (main.js).
 * Each agent runs as a child process (same scripts, STORAGE=pg) with auto-restart.
 * Enable flags live in app_config 'agents' and — unlike the desktop app — default
 * to OFF on a fresh deploy: a new server should never start posting by itself.
 */
const AGENTS: Record<string, { name: string; script: string }> = {
  strategist: { name: "Strategist", script: "src/strategist.ts" },
  generator: { name: "Generator", script: "src/worker.ts" },
  creator: { name: "Creator", script: "src/creator.ts" },
  poster: { name: "Poster", script: "src/poster.ts" },
};

const procs: Record<string, ChildProcess> = {};
const onceProcs: Record<string, ChildProcess> = {};
const fails: Record<string, number> = {};
let quitting = false;
let draining = false;

async function enabledMap(): Promise<Record<string, boolean>> {
  return (await getConfigValue<Record<string, boolean>>("agents")) ?? {};
}
const isEnabled = async (id: string) => (await enabledMap())[id] === true; // server default: OFF

export async function agentStatus() {
  const en = await enabledMap();
  return Object.keys(AGENTS).map((id) => ({
    id, name: AGENTS[id].name, running: !!procs[id], enabled: en[id] === true, once: !!onceProcs[id],
  }));
}
async function pushAgents() { broadcastAgents(await agentStatus()); }

function spawnWorker(id: string, extraArgs: string[] = []): ChildProcess {
  const a = AGENTS[id];
  const child = spawn(process.execPath, ["--import", "tsx", a.script, ...extraArgs], {
    cwd: AGENTS_DIR,
    env: { ...process.env, STORAGE: "pg", SWEATSHOP_DATA_DIR: DATA_DIR },
  });
  const pump = (buf: Buffer) => buf.toString().split(/\r?\n/).forEach((raw) => {
    const line = raw.replace(/\s+$/, "");
    if (!line) return;
    console.log(`[${id}] ${line}`); // container stdout (docker logs) …
    broadcastLog(id, line);         // … and the dashboard's live feed
  });
  child.stdout?.on("data", pump);
  child.stderr?.on("data", pump);
  return child;
}

export async function startAgent(id: string): Promise<void> {
  const a = AGENTS[id];
  if (!a || procs[id] || quitting) return;
  const startedAt = Date.now();
  const child = spawnWorker(id);
  procs[id] = child;
  broadcastLog(id, `▶ ${a.name} started`);
  await pushAgents();

  child.on("error", (e) => broadcastLog(id, `error: ${e.message}`));
  child.on("exit", async (code) => {
    delete procs[id];
    await pushAgents();
    if (quitting || draining || !(await isEnabled(id))) {
      broadcastLog(id, `■ ${a.name} stopped`);
      return;
    }
    const ranMs = Date.now() - startedAt;
    fails[id] = ranMs < 8000 ? (fails[id] || 0) + 1 : 0;
    if (fails[id] >= 3) {
      broadcastLog(id, `⚠ ${a.name} keeps exiting — check keys in Settings, then re-enable.`);
      return;
    }
    broadcastLog(id, `■ ${a.name} exited (code ${code ?? 0}) — restarting in 5s`);
    setTimeout(() => { if (!quitting && !draining) void startAgent(id); }, 5000);
  });
}

export function stopAgent(id: string): void {
  procs[id]?.kill("SIGTERM");
}

export async function setEnabled(id: string, enabled: boolean) {
  if (!AGENTS[id]) throw new Error(`unknown agent: ${id}`);
  const en = await enabledMap();
  en[id] = enabled;
  await setConfigValue("agents", en);
  if (enabled) { fails[id] = 0; void startAgent(id); } else { stopAgent(id); }
  return agentStatus();
}

export async function runOnce(id: string) {
  const a = AGENTS[id];
  if (!a) throw new Error(`unknown agent: ${id}`);
  if (onceProcs[id]) throw new Error(`${a.name} run already in progress`);
  if (id !== "strategist" && procs[id]) throw new Error(`${a.name} is auto-polling — turn it off to step manually`);
  const child = spawnWorker(id, ["--once"]);
  onceProcs[id] = child;
  broadcastLog(id, `▶ ${a.name} — manual run`);
  await pushAgents();
  child.on("exit", async (code) => {
    delete onceProcs[id];
    broadcastLog(id, `■ ${a.name} manual run finished${code ? ` (code ${code})` : ""}`);
    await pushAgents();
  });
  return agentStatus();
}

export async function startEnabledAgents(): Promise<void> {
  const en = await enabledMap();
  for (const id of Object.keys(AGENTS)) if (en[id] === true) void startAgent(id);
}

/** SIGTERM drain: stop respawns, ask workers to exit, force-kill stragglers. */
export function shutdown(): void {
  quitting = true;
  draining = true;
  for (const id of Object.keys(procs)) procs[id]?.kill("SIGTERM");
  for (const id of Object.keys(onceProcs)) onceProcs[id]?.kill("SIGTERM");
  setTimeout(() => {
    for (const id of Object.keys(procs)) procs[id]?.kill("SIGKILL");
    process.exit(0);
  }, 8000).unref();
}
