import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import type { IncomingMessage } from "http";

/**
 * Single-password gate for the whole dashboard (this UI can spend money).
 * Set DASHBOARD_PASSWORD to enforce; unset = open (local dev). Cookie-based so the
 * WebSocket upgrade is covered too (browsers attach cookies to WS, not headers).
 * The session token is an HMAC of the password — stateless, survives restarts,
 * and rotating the password invalidates every session.
 */
const PASSWORD = () => process.env.DASHBOARD_PASSWORD || "";
const COOKIE = "ss_auth";

const sessionToken = () => createHmac("sha256", PASSWORD()).update("sweatshop-session-v1").digest("hex");

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export function wsAuthorized(req: IncomingMessage): boolean {
  if (!PASSWORD()) return true;
  const tok = cookieValue(req.headers.cookie, COOKIE);
  return !!tok && safeEqual(tok, sessionToken());
}

const LOGIN_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sweatshop — sign in</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { background:#13102a; color:#e8e6f5; font-family: "DM Sans", system-ui, sans-serif;
         display:grid; place-items:center; height:100vh; margin:0; }
  form { background:#1a1733; border:1px solid #322d57; border-radius:10px; padding:28px 30px;
         display:flex; flex-direction:column; gap:12px; width:280px; }
  h1 { font-size:15px; margin:0 0 4px; letter-spacing:.06em; }
  input { background:#0d0b1a; border:1px solid #322d57; color:#e8e6f5; padding:10px 12px;
          border-radius:7px; font-size:14px; }
  button { background:#8b7cf0; border:none; color:#fff; padding:10px; border-radius:7px;
           font-weight:700; cursor:pointer; font-size:13px; }
  .err { color:#f0556a; font-size:12px; min-height:14px; margin:0; }
</style></head><body>
<form method="POST" action="/login">
  <h1>▣ SWEATSHOP</h1>
  <p class="err">{{ERR}}</p>
  <input type="password" name="password" placeholder="password" autofocus autocomplete="current-password" />
  <button type="submit">Sign in</button>
</form></body></html>`;

export function mountAuth(app: import("express").Express): void {
  app.get("/login", (_req, res) => res.type("html").send(LOGIN_HTML.replace("{{ERR}}", "")));
  app.post("/login", (req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const pw = decodeURIComponent((/(?:^|&)password=([^&]*)/.exec(body)?.[1] || "").replace(/\+/g, "%20"));
      if (PASSWORD() && safeEqual(pw, PASSWORD())) {
        res.setHeader("Set-Cookie", `${COOKIE}=${sessionToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
        res.redirect("/");
      } else {
        res.status(401).type("html").send(LOGIN_HTML.replace("{{ERR}}", "wrong password"));
      }
    });
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!PASSWORD()) return next(); // no password configured → open (local dev)
  if (req.path === "/healthz" || req.path === "/login") return next();
  const tok = cookieValue(req.headers.cookie, COOKIE);
  if (tok && safeEqual(tok, sessionToken())) return next();
  if (req.path.startsWith("/api")) { res.status(401).json({ error: "unauthorized" }); return; }
  res.redirect("/login");
}
