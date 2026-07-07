import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { wsAuthorized } from "./auth.js";

/**
 * WS hub: streams worker log lines + agent status to every connected dashboard
 * (replaces the Electron `worker:log` / `agents:status` IPC). Keeps a ring buffer
 * so a freshly opened dashboard sees recent history.
 */
type LogMsg = { type: "log"; agent: string; line: string };
type AgentsMsg = { type: "agents"; agents: unknown[] };

const RING_MAX = 300;
const ring: LogMsg[] = [];
let wss: WebSocketServer | null = null;

export function attachHub(server: Server): void {
  wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws, req) => {
    if (!wsAuthorized(req)) { ws.close(4401, "unauthorized"); return; }
    for (const msg of ring) ws.send(JSON.stringify(msg)); // replay history
  });
}

function send(msg: LogMsg | AgentsMsg): void {
  const data = JSON.stringify(msg);
  wss?.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}

export function broadcastLog(agent: string, line: string): void {
  const msg: LogMsg = { type: "log", agent, line };
  ring.push(msg);
  if (ring.length > RING_MAX) ring.shift();
  send(msg);
}

export function broadcastAgents(agents: unknown[]): void {
  send({ type: "agents", agents });
}
