#!/usr/bin/env node
/**
 * AACWorkflow Telegram bot — strict single-panel UX, HTML-formatted.
 *  • One evolving panel message for navigation (no spam), in-place edits.
 *  • Clean typography: headers, meta lines, expandable blockquotes.
 *  • Tasks: filters, search, rich card (status / priority / assign / comment).
 *  • Agents: chat with streaming replies.
 *  • Multi-tenant: each user connects their OWN aacworkflow.com token.
 */
import { Bot, InlineKeyboard, type Context } from "grammy";
import { aac, resolveWorkspace, serverUrl } from "./aac.js";
import { getUser, setToken, setWorkspace, setChat, clearUser } from "./store.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
if (!BOT_TOKEN) { console.error("[tg-bot] TELEGRAM_BOT_TOKEN is not set."); process.exit(1); }
const bot = new Bot(BOT_TOKEN);

const PAGE = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Pend = { kind: "newtask" | "login" | "search" } | { kind: "comment"; id: string; back: number };
const pending = new Map<number, Pend>();
const panelId = new Map<number, number>();
const wsName = new Map<string, string>();

const STATUSES: [string, string][] = [["todo", "К работе"], ["in_progress", "В работе"], ["done", "Готово"], ["cancelled", "Отменить"], ["backlog", "Бэклог"]];
const PRIOS: [string, string][] = [["urgent", "Срочно"], ["high", "Высокий"], ["medium", "Средний"], ["low", "Низкий"], ["no_priority", "—"]];
const FILTERS: Record<string, { label: string; keep: (s: string) => boolean }> = {
  open: { label: "Открытые", keep: (s) => s !== "done" && s !== "cancelled" },
  progress: { label: "В работе", keep: (s) => s === "in_progress" || s === "started" },
  done: { label: "Готово", keep: (s) => s === "done" },
  all: { label: "Все", keep: () => true },
};
const STATUS_RU: Record<string, string> = { todo: "к работе", in_progress: "в работе", started: "в работе", done: "готово", cancelled: "отменена", backlog: "бэклог" };
const PRIO_RU: Record<string, string> = { urgent: "срочный", high: "высокий", medium: "средний", low: "низкий", no_priority: "—" };

const tokenOf = (ctx: Context) => (ctx.from ? getUser(ctx.from.id)?.token ?? null : null);
const wsOf = (ctx: Context, token: string) => resolveWorkspace(token, ctx.from ? getUser(ctx.from.id)?.workspaceId : undefined);
// HTML helpers
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cut = (s: string, n: number) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s ?? "");
const errMsg = (e: unknown) => String(e instanceof Error ? e.message : e);
const dot = (s?: string) => (s === "done" ? "🟢" : s === "in_progress" || s === "started" ? "🔵" : s === "cancelled" ? "⚫️" : "🟡");
const b = (s: unknown) => `<b>${esc(s)}</b>`;
const dim = (s: unknown) => `<i>${esc(s)}</i>`;
const mono = (s: unknown) => `<code>${esc(s)}</code>`;
/** Title + optional subtitle block. */
const head = (t: string, sub?: string) => b(t) + (sub ? `\n${dim(sub)}` : "");
const quote = (s: string, expandable = false) => `<blockquote${expandable ? " expandable" : ""}>${esc(s)}</blockquote>`;

async function panel(ctx: Context, text: string, kb: InlineKeyboard) {
  const opts = { parse_mode: "HTML" as const, reply_markup: kb, link_preview_options: { is_disabled: true } };
  const uid = ctx.from?.id;
  if (ctx.callbackQuery?.message) { try { const m = await ctx.editMessageText(text, opts); if (uid && typeof m === "object") panelId.set(uid, m.message_id); return; } catch { /* */ } }
  if (uid && panelId.has(uid)) { try { await ctx.api.editMessageText(uid, panelId.get(uid)!, text, opts); return; } catch { /* */ } }
  const m = await ctx.reply(text, opts); if (uid) panelId.set(uid, m.message_id);
}
async function wsLabel(ctx: Context, token: string) {
  try { const id = await wsOf(ctx, token); if (wsName.has(id)) return wsName.get(id)!;
    const d = await aac(token, "GET", "/api/workspaces"); (Array.isArray(d) ? d : d?.workspaces ?? d?.data ?? []).forEach((w: any) => wsName.set(w.id, w.name));
    return wsName.get(id) ?? "—"; } catch { return "—"; }
}
const backBtn = (kb: InlineKeyboard, to = "nav:home", label = "‹ Назад") => kb.text(label, to);

// ── Screens ─────────────────────────────────────────────────────────────
async function home(ctx: Context) {
  const token = tokenOf(ctx);
  if (!token) return panel(ctx, head("AACWorkflow") + "\n\n" + quote("Подключите ключ доступа, чтобы управлять задачами и агентами."), new InlineKeyboard().text("🔑 Подключить ключ", "nav:login"));
  const ws = await wsLabel(ctx, token);
  const kb = new InlineKeyboard()
    .text("📋 Задачи", "nav:tasks:0:open").text("🤖 Агенты", "nav:agents").row()
    .text("＋ Новая задача", "nav:new").text("🔍 Поиск", "nav:search").row()
    .text(`🏢 ${cut(ws, 20)}`, "nav:ws").text("👤 Профиль", "nav:me");
  await panel(ctx, head("AACWorkflow", ws), kb);
}

async function tasks(ctx: Context, page = 0, filter = "open") {
  const token = tokenOf(ctx); if (!token) return home(ctx);
  if (!FILTERS[filter]) filter = "open";
  try {
    const w = await wsOf(ctx, token);
    const data = await aac(token, "GET", "/api/issues", { workspaceId: w });
    const all0: any[] = Array.isArray(data) ? data : data?.issues ?? data?.data ?? [];
    const all = all0.filter((i) => FILTERS[filter].keep(i.status ?? ""));
    const pages = Math.max(1, Math.ceil(all.length / PAGE));
    page = Math.min(Math.max(0, page), pages - 1);
    const kb = new InlineKeyboard();
    (Object.keys(FILTERS) as string[]).forEach((f) => kb.text(`${f === filter ? "• " : ""}${FILTERS[f].label}`, `nav:tasks:0:${f}`));
    kb.row();
    all.slice(page * PAGE, page * PAGE + PAGE).forEach((i) => kb.text(`${dot(i.status)} ${cut(i.title, 40)}`, `task:${i.id}:${page}:${filter}`).row());
    if (pages > 1) {
      if (page > 0) kb.text("‹", `nav:tasks:${page - 1}:${filter}`);
      kb.text(`${page + 1} / ${pages}`, `nav:tasks:${page}:${filter}`);
      if (page < pages - 1) kb.text("›", `nav:tasks:${page + 1}:${filter}`);
      kb.row();
    }
    kb.text("＋ Новая", "nav:new").text("⟳ Обновить", `nav:tasks:${page}:${filter}`).row();
    backBtn(kb);
    await panel(ctx, head("Задачи", `${FILTERS[filter].label} · ${all.length}`) + (all.length ? "" : "\n\n" + quote("Здесь пока пусто.")), kb);
  } catch (e) { await panel(ctx, "⚠️ " + esc(errMsg(e)), new InlineKeyboard().text("‹ Назад", "nav:home")); }
}

async function task(ctx: Context, id: string, bk = 0, filter = "open") {
  const token = tokenOf(ctx); if (!token) return home(ctx);
  try {
    const w = await wsOf(ctx, token);
    const i = await aac(token, "GET", `/api/issues/${id}`, { workspaceId: w });
    const line = [STATUS_RU[i.status] ?? i.status ?? "—", PRIO_RU[i.priority] ?? i.priority].filter(Boolean).join(" · ");
    let text = `${dot(i.status)} ${b(i.title)}\n`;
    if (i.identifier) text += `${mono(i.identifier)}  ·  ${dim(line)}\n`; else text += `${dim(line)}\n`;
    if (i.description) text += "\n" + quote(String(i.description).slice(0, 900), String(i.description).length > 140);
    const tail = `${id}:${bk}:${filter}`;
    const kb = new InlineKeyboard();
    if (i.status !== "done") kb.text("✓ Завершить", `set:status:done:${tail}`);
    kb.text("⟳", `task:${tail}`).row();
    kb.text("◔ Статус", `edit:status:${tail}`).text("⚑ Приоритет", `edit:prio:${tail}`).row();
    kb.text("👤 Назначить агента", `edit:assign:${tail}`).row();
    kb.text("💬 Комментарий", `cmt:${tail}`).row();
    backBtn(kb, `nav:tasks:${bk}:${filter}`, "‹ К задачам");
    await panel(ctx, text, kb);
  } catch (e) { await panel(ctx, "⚠️ " + esc(errMsg(e)), new InlineKeyboard().text("‹ К задачам", `nav:tasks:${bk}:${filter}`)); }
}

async function editTask(ctx: Context, what: string, id: string, bk: number, filter: string) {
  const token = tokenOf(ctx); if (!token) return home(ctx);
  const tail = `${id}:${bk}:${filter}`;
  const kb = new InlineKeyboard();
  if (what === "status") STATUSES.forEach(([v, l]) => kb.text(l, `set:status:${v}:${tail}`).row());
  else if (what === "prio") PRIOS.forEach(([v, l]) => kb.text(l, `set:prio:${v}:${tail}`).row());
  else if (what === "assign") {
    try {
      const w = await wsOf(ctx, token);
      const data = await aac(token, "GET", "/api/agents", { workspaceId: w });
      (Array.isArray(data) ? data : data?.agents ?? data?.data ?? []).slice(0, 10).forEach((a: any) => kb.text(cut(a.name, 34), `set:assign:${a.id}:${tail}`).row());
    } catch (e) { return panel(ctx, "⚠️ " + esc(errMsg(e)), new InlineKeyboard().text("‹ Назад", `task:${tail}`)); }
  }
  kb.text("‹ Отмена", `task:${tail}`);
  await panel(ctx, head(what === "status" ? "Статус задачи" : what === "prio" ? "Приоритет" : "Назначить агента", "Выберите значение"), kb);
}
async function applyEdit(ctx: Context, kind: string, value: string, id: string, bk: number, filter: string) {
  const token = tokenOf(ctx); if (!token) return home(ctx);
  const patch = kind === "status" ? { status: value } : kind === "prio" ? { priority: value } : { assignee_type: "agent", assignee_id: value };
  try { await aac(token, "PUT", `/api/issues/${id}`, { workspaceId: await wsOf(ctx, token), body: patch }); } catch (e) { void e; }
  await task(ctx, id, bk, filter);
}

async function agents(ctx: Context) {
  const token = tokenOf(ctx); if (!token) return home(ctx);
  try {
    const w = await wsOf(ctx, token);
    const data = await aac(token, "GET", "/api/agents", { workspaceId: w });
    const arr: any[] = Array.isArray(data) ? data : data?.agents ?? data?.data ?? [];
    const kb = new InlineKeyboard();
    arr.slice(0, 12).forEach((a) => kb.text(`💬  ${cut(a.name, 34)}`, `chat:${a.id}`).row());
    backBtn(kb);
    await panel(ctx, head("Агенты", arr.length ? "Нажмите, чтобы начать диалог" : "Агентов пока нет"), kb);
  } catch (e) { await panel(ctx, "⚠️ " + esc(errMsg(e)), new InlineKeyboard().text("‹ Назад", "nav:home")); }
}

async function workspaces(ctx: Context) {
  const token = tokenOf(ctx); if (!token) return home(ctx);
  try {
    const data = await aac(token, "GET", "/api/workspaces");
    const arr: any[] = Array.isArray(data) ? data : data?.workspaces ?? data?.data ?? [];
    arr.forEach((w) => wsName.set(w.id, w.name));
    const active = await wsOf(ctx, token).catch(() => "");
    const kb = new InlineKeyboard();
    arr.forEach((w) => kb.text(`${active === w.id ? "● " : "○ "}${cut(w.name, 34)}`, `setws:${w.id}`).row());
    backBtn(kb);
    await panel(ctx, head("Компании", "Активная отмечена ●"), kb);
  } catch (e) { await panel(ctx, "⚠️ " + esc(errMsg(e)), new InlineKeyboard().text("‹ Назад", "nav:home")); }
}

async function me(ctx: Context) {
  const token = tokenOf(ctx); if (!token) return home(ctx);
  try {
    const u = await aac(token, "GET", "/api/me"); const ws = await wsLabel(ctx, token);
    const text = head("Профиль") + "\n\n" + b(u?.name ?? "—") + `\n${esc(u?.email ?? "")}\n` + dim(`Компания: ${ws}`);
    const kb = new InlineKeyboard().text("🏢 Сменить компанию", "nav:ws").row().text("🚪 Отключить ключ", "ask:logout").row().text("‹ Назад", "nav:home");
    await panel(ctx, text, kb);
  } catch (e) { await panel(ctx, "⚠️ " + esc(errMsg(e)), new InlineKeyboard().text("‹ Назад", "nav:home")); }
}

// ── Prompts ─────────────────────────────────────────────────────────────
async function promptNewTask(ctx: Context) { if (ctx.from) pending.set(ctx.from.id, { kind: "newtask" }); await panel(ctx, head("Новая задача") + "\n\n" + quote("Отправьте название задачи одним сообщением."), new InlineKeyboard().text("Отмена", "nav:tasks:0:open")); }
async function promptLogin(ctx: Context) { if (ctx.from) pending.set(ctx.from.id, { kind: "login" }); await panel(ctx, head("Подключение ключа") + "\n\n" + quote(`Отправьте ключ (mul_…) одним сообщением.\n${serverUrl} → Settings → Tokens`), new InlineKeyboard().text("Отмена", "nav:home")); }
async function promptSearch(ctx: Context) { if (ctx.from) pending.set(ctx.from.id, { kind: "search" }); await panel(ctx, head("Поиск задач") + "\n\n" + quote("Отправьте текст для поиска."), new InlineKeyboard().text("Отмена", "nav:home")); }
async function promptComment(ctx: Context, id: string, bk: number) { if (ctx.from) pending.set(ctx.from.id, { kind: "comment", id, back: bk }); await panel(ctx, head("Комментарий") + "\n\n" + quote("Отправьте текст комментария."), new InlineKeyboard().text("Отмена", `task:${id}:${bk}:open`)); }

async function doSearch(ctx: Context, q: string) {
  const token = tokenOf(ctx); if (!token) return home(ctx);
  try {
    const w = await wsOf(ctx, token);
    const data = await aac(token, "GET", "/api/issues/search", { workspaceId: w, query: { q } });
    const arr: any[] = Array.isArray(data) ? data : data?.issues ?? data?.results ?? data?.data ?? [];
    const kb = new InlineKeyboard();
    arr.slice(0, 12).forEach((i) => kb.text(`${dot(i.status)} ${cut(i.title, 40)}`, `task:${i.id}:0:all`).row());
    backBtn(kb);
    await panel(ctx, head("Поиск", `«${cut(q, 30)}» · найдено ${arr.length}`) + (arr.length ? "" : "\n\n" + quote("Ничего не найдено.")), kb);
  } catch (e) { await panel(ctx, "⚠️ " + esc(errMsg(e)), new InlineKeyboard().text("‹ Назад", "nav:home")); }
}
async function addComment(ctx: Context, id: string, bk: number, content: string) {
  const token = tokenOf(ctx); if (!token) return home(ctx);
  try { await aac(token, "POST", `/api/issues/${id}/comments`, { workspaceId: await wsOf(ctx, token), body: { content, type: "comment" } }); } catch (e) { void e; }
  await task(ctx, id, bk, "open");
}

// ── Commands ────────────────────────────────────────────────────────────
bot.command(["start", "menu"], (ctx) => home(ctx));
bot.command("tasks", (ctx) => tasks(ctx, 0, "open"));
bot.command("agents", (ctx) => agents(ctx));
bot.command("whoami", (ctx) => me(ctx));
bot.command("login", (ctx) => { const t = (ctx.match ?? "").trim(); return t ? saveToken(ctx, t) : promptLogin(ctx); });
bot.command("newtask", (ctx) => { const t = (ctx.match ?? "").trim(); return t ? createTask(ctx, t) : promptNewTask(ctx); });
bot.command("logout", (ctx) => { if (ctx.from) { clearUser(ctx.from.id); panelId.delete(ctx.from.id); } return home(ctx); });
bot.command("stop", (ctx) => { if (ctx.from) setChat(ctx.from.id, undefined); return ctx.reply("Чат завершён.").then(() => home(ctx)); });
bot.command("help", (ctx) => ctx.reply("Управление — кнопками. /menu — меню."));

// ── Button taps ─────────────────────────────────────────────────────────
bot.on("callback_query:data", async (ctx) => {
  const d = ctx.callbackQuery.data; const uid = ctx.from?.id; const p = d.split(":");
  try {
    if (d === "nav:home") await home(ctx);
    else if (p[0] === "nav" && p[1] === "tasks") await tasks(ctx, Number(p[2]) || 0, p[3] || "open");
    else if (d === "nav:agents") await agents(ctx);
    else if (d === "nav:ws") await workspaces(ctx);
    else if (d === "nav:me") await me(ctx);
    else if (d === "nav:new") await promptNewTask(ctx);
    else if (d === "nav:login") await promptLogin(ctx);
    else if (d === "nav:search") await promptSearch(ctx);
    else if (p[0] === "task") await task(ctx, p[1], Number(p[2]) || 0, p[3] || "open");
    else if (p[0] === "edit") await editTask(ctx, p[1], p[2], Number(p[3]) || 0, p[4] || "open");
    else if (p[0] === "set") { await applyEdit(ctx, p[1], p[2], p[3], Number(p[4]) || 0, p[5] || "open"); await ctx.answerCallbackQuery({ text: "Готово ✓" }); return; }
    else if (p[0] === "cmt") await promptComment(ctx, p[1], Number(p[2]) || 0);
    else if (p[0] === "setws") { if (uid) setWorkspace(uid, p[1]); await home(ctx); }
    else if (p[0] === "chat") { if (p[1] === "exit") { if (uid) setChat(uid, undefined); await home(ctx); } else await startChat(ctx, p[1]); }
    else if (d === "ask:logout") await panel(ctx, head("Отключить ключ") + "\n\n" + quote("Ключ будет удалён с этого устройства. Продолжить?"), new InlineKeyboard().text("Да, отключить", "do:logout").text("Отмена", "nav:me"));
    else if (d === "do:logout") { if (uid) clearUser(uid); await home(ctx); }
    await ctx.answerCallbackQuery();
  } catch (e) { try { await ctx.answerCallbackQuery({ text: errMsg(e).slice(0, 190), show_alert: true }); } catch { /* */ } }
});

// ── Free text → pending input or active chat ─────────────────────────────
bot.on("message:text", async (ctx) => {
  const id = ctx.from?.id; if (!id) return;
  const act = pending.get(id);
  if (act) {
    pending.delete(id); const text = ctx.message.text.trim();
    try { await ctx.deleteMessage(); } catch { /* */ }
    if (act.kind === "login") return saveToken(ctx, text);
    if (act.kind === "newtask") return createTask(ctx, text);
    if (act.kind === "search") return doSearch(ctx, text);
    if (act.kind === "comment") return addComment(ctx, act.id, act.back, text);
  }
  if (getUser(id)?.chat) return chatSend(ctx, ctx.message.text);
  return home(ctx);
});

// ── Actions ─────────────────────────────────────────────────────────────
async function saveToken(ctx: Context, token: string) {
  if (!token.startsWith("mul_")) return panel(ctx, head("Подключение ключа") + "\n\n" + quote("Нужен формат mul_…"), new InlineKeyboard().text("Повторить", "nav:login").text("Отмена", "nav:home"));
  try { await aac(token, "GET", "/api/me"); if (ctx.from) setToken(ctx.from.id, token); await home(ctx); }
  catch (e) { await panel(ctx, head("Подключение ключа") + "\n\n❌ " + esc(errMsg(e)), new InlineKeyboard().text("Повторить", "nav:login")); }
}
async function createTask(ctx: Context, title: string) {
  const token = tokenOf(ctx); if (!token) return home(ctx); if (!title) return promptNewTask(ctx);
  try { await aac(token, "POST", "/api/issues", { workspaceId: await wsOf(ctx, token), body: { title } }); await tasks(ctx, 0, "open"); }
  catch (e) { await panel(ctx, "⚠️ " + esc(errMsg(e)), new InlineKeyboard().text("‹ К задачам", "nav:tasks:0:open")); }
}

// ── Chat with streaming reply ───────────────────────────────────────────
async function startChat(ctx: Context, agentId: string) {
  const token = tokenOf(ctx); if (!token) return home(ctx);
  try {
    const w = await wsOf(ctx, token); let name = "Агент";
    try { const a = await aac(token, "GET", `/api/agents/${agentId}`, { workspaceId: w }); name = a?.name ?? name; } catch { /* */ }
    const s = await aac(token, "POST", "/api/chat/sessions", { workspaceId: w, body: { agent_id: agentId, title: "Telegram" } });
    if (ctx.from) setChat(ctx.from.id, { agentId, sessionId: s.id, agentName: name });
    await panel(ctx, `💬 ${b(name)}\n` + dim("Напишите сообщение. /stop — выйти."), new InlineKeyboard().text("‹ Выйти из чата", "chat:exit"));
  } catch (e) { await panel(ctx, "⚠️ " + esc(errMsg(e)), new InlineKeyboard().text("‹ Назад", "nav:home")); }
}
async function chatSend(ctx: Context, text: string) {
  const id = ctx.from?.id; const u = id ? getUser(id) : undefined;
  if (!u?.chat || !u.token) return home(ctx);
  const { token } = u; const chat = u.chat; const w = await wsOf(ctx, token);
  let since = new Date().toISOString();
  try { const s = await aac(token, "POST", `/api/chat/sessions/${chat.sessionId}/messages`, { workspaceId: w, body: { content: text } }); if (s?.created_at) since = s.created_at; }
  catch (e) { await ctx.reply("⚠️ " + errMsg(e)); return; }
  const live = await ctx.reply(`💬 ${chat.agentName} печатает…`);
  let shown = ""; let stable = 0;
  for (let i = 0; i < 48 && stable < 2; i++) {
    try { await ctx.api.sendChatAction(ctx.chat!.id, "typing"); } catch { /* */ }
    await sleep(2200);
    try {
      const msgs = await aac(token, "GET", `/api/chat/sessions/${chat.sessionId}/messages`, { workspaceId: w });
      const arr: any[] = Array.isArray(msgs) ? msgs : [];
      const failed = arr.find((m) => m.failure_reason && (m.created_at ?? "") >= since);
      if (failed) { await editPlain(ctx, live, "⚠️ Агент не смог ответить: " + (failed.failure_reason ?? "")); return; }
      const reply = arr.filter((m) => m.role === "assistant" && (m.created_at ?? "") > since).map((m) => m.content ?? "").join("\n\n").trim();
      if (reply && reply === shown) stable++;
      else if (reply) { shown = reply; stable = 0; await editPlain(ctx, live, `🤖 ${chat.agentName}:\n\n${cut(shown, 3900)}`); }
    } catch { /* keep polling */ }
  }
  if (!shown) await editPlain(ctx, live, "⌛ Агент пока не ответил. Напишите ещё раз или /stop.");
}
async function editPlain(ctx: Context, msg: { chat: { id: number }; message_id: number }, text: string) {
  try { await ctx.api.editMessageText(msg.chat.id, msg.message_id, text); } catch { /* */ }
}

bot.catch((e) => console.error("[tg-bot] error:", e.error));
await bot.api.setMyCommands([
  { command: "menu", description: "Меню" }, { command: "tasks", description: "Задачи" },
  { command: "agents", description: "Агенты" }, { command: "newtask", description: "Новая задача" },
  { command: "whoami", description: "Профиль" }, { command: "stop", description: "Выйти из чата" },
  { command: "logout", description: "Отключить ключ" },
]);
await bot.api.setChatMenuButton({ menu_button: { type: "commands" } });
console.error("[tg-bot] starting (long polling) →", serverUrl);
await bot.start();
