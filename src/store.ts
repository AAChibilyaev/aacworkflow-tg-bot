/** File-backed per-Telegram-user store: { token, workspaceId }. Tokens are
 *  secrets — the file is written 0600 on the bot host. Set DATA_FILE to relocate. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type UserRec = { token: string; workspaceId?: string };
const FILE = process.env.DATA_FILE ?? "./data/users.json";
let cache: Record<string, UserRec> = {};

if (existsSync(FILE)) {
  try { cache = JSON.parse(readFileSync(FILE, "utf8")); } catch { cache = {}; }
}
function save() {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

export const getUser = (id: number): UserRec | undefined => cache[String(id)];
export const setToken = (id: number, token: string) => { cache[String(id)] = { ...(cache[String(id)] ?? {}), token }; save(); };
export const setWorkspace = (id: number, ws: string) => { const u = cache[String(id)]; if (u) { u.workspaceId = ws; save(); } };
export const clearUser = (id: number) => { delete cache[String(id)]; save(); };
