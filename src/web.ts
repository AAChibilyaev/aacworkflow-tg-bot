/**
 * Mini App web server: serves the in-Telegram app and a thin API proxy.
 *
 * Auth: the browser (Telegram WebApp) sends `initData` in the
 * `X-Telegram-Init-Data` header. We verify its HMAC signature with the bot
 * token (Telegram spec), map the Telegram user → their stored aacworkflow
 * token, and proxy calls. The aacworkflow token never reaches the browser.
 */
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { aac, resolveWorkspace } from "./aac.js";
import { getUser } from "./store.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const APP_HTML = (() => { try { return readFileSync(join(__dir, "../public/app.html"), "utf8"); } catch { return "<h1>app.html missing</h1>"; } })();

function verify(initData: string, botToken: string): { id: number } | null {
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get("hash"); if (!hash) return null;
    p.delete("hash");
    const dcs = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
    const calc = createHmac("sha256", secret).update(dcs).digest("hex");
    if (calc !== hash) return null;
    const authDate = Number(p.get("auth_date") ?? 0);
    if (authDate && Date.now() / 1000 - authDate > 86400) return null; // 24h freshness
    const user = JSON.parse(p.get("user") ?? "{}");
    return user?.id ? { id: Number(user.id) } : null;
  } catch { return null; }
}

const json = (res: any, code: number, data: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };

export function startWeb(botToken: string, port: number) {
  createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init-Data");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (url.pathname === "/health") return json(res, 200, { ok: true });
    if (url.pathname === "/" || url.pathname === "/app") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(APP_HTML); return;
    }
    if (!url.pathname.startsWith("/api/")) { res.writeHead(404); res.end("not found"); return; }

    // Authenticated API proxy.
    const auth = verify(String(req.headers["x-telegram-init-data"] ?? ""), botToken);
    if (!auth) return json(res, 401, { error: "bad initData" });
    const u = getUser(auth.id);
    if (!u?.token) return json(res, 403, { error: "not_linked", message: "Откройте бота и подключите ключ: /login" });
    const token = u.token;

    try {
      const ws = await resolveWorkspace(token, u.workspaceId);
      const body = await readBody(req);
      if (url.pathname === "/api/me" && req.method === "GET") return json(res, 200, await aac(token, "GET", "/api/me"));
      if (url.pathname === "/api/tasks" && req.method === "GET") return json(res, 200, await aac(token, "GET", "/api/issues", { workspaceId: ws }));
      if (url.pathname === "/api/tasks" && req.method === "POST") return json(res, 200, await aac(token, "POST", "/api/issues", { workspaceId: ws, body: { title: body.title } }));
      if (url.pathname === "/api/agents" && req.method === "GET") return json(res, 200, await aac(token, "GET", "/api/agents", { workspaceId: ws }));
      const done = url.pathname.match(/^\/api\/tasks\/([^/]+)\/done$/);
      if (done && req.method === "POST") return json(res, 200, await aac(token, "PUT", `/api/issues/${done[1]}`, { workspaceId: ws, body: { status: "done" } }));
      return json(res, 404, { error: "unknown endpoint" });
    } catch (e) { return json(res, 500, { error: String(e instanceof Error ? e.message : e) }); }
  }).listen(port, () => console.error(`[tg-bot] mini-app web server on :${port}`));
}

function readBody(req: any): Promise<any> {
  return new Promise((resolve) => { let d = ""; req.on("data", (c: any) => (d += c)); req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } }); });
}
