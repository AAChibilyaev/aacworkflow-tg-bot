#!/usr/bin/env node
/**
 * AACWorkflow Telegram bot — strict, single-panel, mobile-first UX.
 *
 * Design rules:
 *  - One evolving "panel" message per user: navigation edits it in place
 *    (no message spam). Transient inputs (key, task title) and their prompts
 *    are removed after use.
 *  - Chat with an agent is the one exception: it flows as a normal dialogue
 *    (your message → agent reply) with a typing indicator.
 *  - Minimal, consistent iconography; clean typography; confirmations for
 *    destructive actions.
 *
 * Multi-tenant: each user connects their OWN aacworkflow.com token.
 */
import { Bot, InlineKeyboard, type Context } from "grammy";
import { aac, resolveWorkspace, serverUrl } from "./aac.js";
import { getUser, setToken, setWorkspace, setChat, clearUser } from "./store.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
if (!BOT_TOKEN) { console.error("[tg-bot] TELEGRAM_BOT_TOKEN is not set."); process.exit(1); }
const bot = new Bot(BOT_TOKEN);

const PAGE = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pending = new Map<number, "newtask" | "login">();
const panelId = new Map<number, number>();   // user → current panel message_id
const wsName = new Map<string, string>();     // workspace id → name (cache)

const tokenOf = (ctx: Context) => (ctx.from ? getUser(ctx.from.id)?.token ?? null : null);
const wsOf = (ctx: Context, token: string) => resolveWorkspace(token, ctx.from ? getUser(ctx.from.id)?.workspaceId : undefined);

// ── Rendering primitives ────────────────────────────────────────────────
const md = (s: string) => String(s ?? "").replace(/([_*`\[\]])/g, "\\$1");
const cut = (s: string, n: number) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s ?? "");
const err = (e: unknown) => String(e instanceof Error ? e.message : e);
const dot = (s?: string) => (s === "done" ? "✅" : s === "in_progress" || s === "started" ? "🔵" : s === "cancelled" ? "⚪️" : "🟡");
const H = (title: string, sub?: string) => `*${md(title)}*` + (sub ? `\n_${md(sub)}_` : "");

/** Render the single panel: edit in place on callbacks, else reuse/replace the stored panel. */
async function panel(ctx: Context, text: string, kb: InlineKeyboard) {
  const opts = { parse_mode: "Markdown" as const, reply_markup: kb, link_preview_options: { is_disabled: true } };
  const uid = ctx.from?.id;
  if (ctx.callbackQuery?.message) {
    try { const m = await ctx.editMessageText(text, opts); if (uid && typeof m === "object") panelId.set(uid, m.message_id); return; } catch { /* fall through */ }
  }
  if (uid && panelId.has(uid)) {
    try { await ctx.api.editMessageText(uid, panelId.get(uid)!, text, opts); return; } catch { /* stale → send fresh */ }
  }
  const m = await ctx.reply(text, opts);
  if (uid) panelId.set(uid, m.message_id);
}

async function workspaceLabel(ctx: Context, token: string): Promise<string> {
  try {
    const id = await wsOf(ctx, token);
    if (wsName.has(id)) return wsName.get(id)!;
    const data = await aac(token, "GET", "/api/workspaces");
    const arr: any[] = Array.isArray(data) ? data : data?.workspaces ?? data?.data ?? [];
    arr.forEach((w) => wsName.set(w.id, w.name));
    return wsName.get(id) ?? "—";
  } catch { return "—"; }
}

const backRow = (kb: InlineKeyboard, to = "nav:home", label = "‹ Назад") => kb.text(label, to);

// ── Screens ─────────────────────────────────────────────────────────────
async function home(ctx: Context) {
  const token = tokenOf(ctx);
  if (!token) {
    return panel(ctx, H("AACWorkflow") + "\n\nПодключите ключ доступа, чтобы управлять задачами и агентами.",
      new InlineKeyboard().text("Подключить ключ", "nav:login"));
  }
  const ws = await workspaceLabel(ctx, token);
  const kb = new InlineKeyboard()
    .text("Задачи", "nav:tasks:0").text("Агенты", "nav:agents").row()
    .text("＋ Новая задача", "nav:new").row()
    .text(`🏢 ${cut(ws, 22)}`, "nav:ws").text("Профиль", "nav:me");
  await panel(ctx, H("AACWorkflow", ws), kb);
}

async function tasks(ctx: Context, page = 0) {
  const token = tokenOf(ctx); if (!token) return home(ctx);
  try {
    const w = await wsOf(ctx, token);
    const data = await aac(token, "GET", "/api/issues", { workspaceId: w });
    const all: any[] = Array.isArray(data) ? data : data?.issues ?? data?.data ?? [];
    const open = all.filter((i) => i.status !== "done" && i.status !== "cancelled").length;
    const pages = Math.max(1, Math.ceil(all.length / PAGE));
    page = Math.min(Math.max(0, page), pages - 1);
    const slice = all.slice(page * PAGE, page * PAGE + PAGE);
    const kb = new InlineKeyboard();
    slice.forEach((i) => kb.text(`${dot(i.status)} ${cut(i.title, 40)}`, `task:${i.id}:${page}`).row());
    if (pages > 1) {
      const nav: [string, string][] = [];
      if (page > 0) nav.push(["‹", `nav:tasks:${page - 1}`]);
      nav.push([`${page + 1}/${pages}`, `nav:tasks:${page}`]);
      if (page < pages - 1) nav.push(["›", `nav:tasks:${page + 1}`]);
      nav.forEach(([t, d]) => kb.text(t, d)); kb.row();
    }
    kb.text("＋ Новая", "nav:new").text("⟳", `nav:tasks:${page}`).row();
    backRow(kb);
    await panel(ctx, H("Задачи", `${all.length} всего · ${open} в работе`) + (all.length ? "" : "\n\nПока пусто."), kb);
  } catch (e) { await panel(ctx, "⚠️ " + err(e), new InlineKeyboard().text("‹ Назад", "nav:home")); }
}

async function task(ctx: Context, id: string, back = 0) {
  const token = tokenOf(ctx); if (!token) return home(ctx);
  try {
    const w = await wsOf(ctx, token);
    const i = await aac(token, "GET", `/api/issues/${id}`, { workspaceId: w });
    const meta = [i.identifier && `\`${md(i.identifier)}\``, `статус: ${i.status ?? "—"}`, `приоритет: ${i.priority ?? "—"}`].filter(Boolean).join("  ·  ");
    const body = i.description ? "\n\n" + md(String(i.description)).slice(0, 600) : "";
    const kb = new InlineKeyboard();
    if (i.status !== "done") kb.text("✓ Завершить", `done:${id}:${back}`);
    kb.text("⟳", `task:${id}:${back}`).row();
    backRow(kb, `nav:tasks:${back}`, "‹ К задачам");
    await panel(ctx, `${dot(i.status)} *${md(i.title)}*\n${meta}${body}`, kb);
  } catch (e) { await panel(ctx, "⚠️ " + err(e), new InlineKeyboard().text("‹ К задачам", `nav:tasks:${back}`)); }
}

async function agents(ctx: Context) {
  const token = tokenOf(ctx); if (!token) return home(ctx);
  try {
    const w = await wsOf(ctx, token);
    const data = await aac(token, "GET", "/api/agents", { workspaceId: w });
    const arr: any[] = Array.isArray(data) ? data : data?.agents ?? data?.data ?? [];
    const kb = new InlineKeyboard();
    arr.slice(0, 12).forEach((a) => kb.text(`💬  ${cut(a.name, 34)}`, `chat:${a.id}`).row());
    backRow(kb);
    await panel(ctx, H("Агенты", arr.length ? "Выберите собеседника" : "Агентов пока нет"), kb);
  } catch (e) { await panel(ctx, "⚠️ " + err(e), new InlineKeyboard().text("‹ Назад", "nav:home")); }
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
    backRow(kb);
    await panel(ctx, H("Компании", "Активная отмечена ●"), kb);
  } catch (e) { await panel(ctx, "⚠️ " + err(e), new InlineKeyboard().text("‹ Назад", "nav:home")); }
}

async function me(ctx: Context) {
  const token = tokenOf(ctx); if (!token) return home(ctx);
  try {
    const u = await aac(token, "GET", "/api/me");
    const ws = await workspaceLabel(ctx, token);
    const kb = new InlineKeyboard().text("Сменить компанию", "nav:ws").row().text("Отключить ключ", "ask:logout").row().text("‹ Назад", "nav:home");
    await panel(ctx, H("Профиль") + `\n\n${md(u?.name ?? "—")}\n${md(u?.email ?? "")}\nКомпания: ${md(ws)}`, kb);
  } catch (e) { await panel(ctx, "⚠️ " + err(e), new InlineKeyboard().text("‹ Назад", "nav:home")); }
}

// ── Input prompts (shown inside the panel, no extra messages) ────────────
async function promptNewTask(ctx: Context) {
  if (ctx.from) pending.set(ctx.from.id, "newtask");
  await panel(ctx, H("Новая задача") + "\n\nОтправьте название задачи одним сообщением.", new InlineKeyboard().text("Отмена", "nav:tasks:0"));
}
async function promptLogin(ctx: Context) {
  if (ctx.from) pending.set(ctx.from.id, "login");
  await panel(ctx, H("Подключение ключа") + `\n\nОтправьте ваш ключ AACWorkflow (\`mul_…\`) одним сообщением.\nКлюч: ${serverUrl} → Settings → Tokens.`,
    new InlineKeyboard().text("Отмена", "nav:home"));
}

// ── Commands ────────────────────────────────────────────────────────────
bot.command(["start", "menu"], (ctx) => home(ctx));
bot.command("tasks", (ctx) => tasks(ctx, 0));
bot.command("agents", (ctx) => agents(ctx));
bot.command("whoami", (ctx) => me(ctx));
bot.command("login", (ctx) => { const t = (ctx.match ?? "").trim(); return t ? saveToken(ctx, t) : promptLogin(ctx); });
bot.command("newtask", (ctx) => { const t = (ctx.match ?? "").trim(); return t ? createTask(ctx, t) : promptNewTask(ctx); });
bot.command("logout", (ctx) => { if (ctx.from) { clearUser(ctx.from.id); panelId.delete(ctx.from.id); } return home(ctx); });
bot.command("stop", (ctx) => { if (ctx.from) setChat(ctx.from.id, undefined); return ctx.reply("Чат завершён.").then(() => home(ctx)); });
bot.command("help", (ctx) => ctx.reply("Управление — кнопками. /menu — открыть меню."));

// ── Button taps ─────────────────────────────────────────────────────────
bot.on("callback_query:data", async (ctx) => {
  const d = ctx.callbackQuery.data;
  const uid = ctx.from?.id;
  try {
    if (d === "nav:home") await home(ctx);
    else if (d.startsWith("nav:tasks:")) await tasks(ctx, Number(d.split(":")[2]) || 0);
    else if (d === "nav:agents") await agents(ctx);
    else if (d === "nav:ws") await workspaces(ctx);
    else if (d === "nav:me") await me(ctx);
    else if (d === "nav:new") await promptNewTask(ctx);
    else if (d === "nav:login") await promptLogin(ctx);
    else if (d.startsWith("task:")) { const [, id, b] = d.split(":"); await task(ctx, id, Number(b) || 0); }
    else if (d.startsWith("done:")) { const [, id, b] = d.split(":"); await completeTask(ctx, id); await ctx.answerCallbackQuery({ text: "Завершено ✓" }); await tasks(ctx, Number(b) || 0); return; }
    else if (d.startsWith("setws:")) { if (uid) { setWorkspace(uid, d.slice(6)); } await home(ctx); }
    else if (d.startsWith("chat:")) await startChat(ctx, d.slice(5));
    else if (d === "ask:logout") await panel(ctx, H("Отключить ключ") + "\n\nКлюч будет удалён с этого устройства. Продолжить?", new InlineKeyboard().text("Да, отключить", "do:logout").text("Отмена", "nav:me"));
    else if (d === "do:logout") { if (uid) clearUser(uid); await home(ctx); }
    else if (d === "chat:exit") { if (uid) setChat(uid, undefined); await home(ctx); }
    await ctx.answerCallbackQuery();
  } catch (e) { try { await ctx.answerCallbackQuery({ text: err(e).slice(0, 190), show_alert: true }); } catch { /* */ } }
});

// ── Free text → pending input or active chat ─────────────────────────────
bot.on("message:text", async (ctx) => {
  const id = ctx.from?.id; if (!id) return;
  const act = pending.get(id);
  if (act) {
    pending.delete(id);
    const text = ctx.message.text.trim();
    try { await ctx.deleteMessage(); } catch { /* reduce noise / hide secrets */ }
    if (act === "login") return saveToken(ctx, text);
    if (act === "newtask") return createTask(ctx, text);
  }
  if (getUser(id)?.chat) return chatSend(ctx, ctx.message.text);
  return home(ctx);
});

// ── Actions ─────────────────────────────────────────────────────────────
async function saveToken(ctx: Context, token: string) {
  if (!token.startsWith("mul_")) return panel(ctx, H("Подключение ключа") + "\n\nЭто не похоже на ключ. Нужен формат `mul_…`.", new InlineKeyboard().text("Повторить", "nav:login").text("Отмена", "nav:home"));
  try {
    await aac(token, "GET", "/api/me");
    if (ctx.from) setToken(ctx.from.id, token);
    await home(ctx);
  } catch (e) { await panel(ctx, H("Подключение ключа") + "\n\n❌ Ключ не принят:\n" + md(err(e)), new InlineKeyboard().text("Повторить", "nav:login")); }
}
async function createTask(ctx: Context, title: string) {
  const token = tokenOf(ctx); if (!token) return home(ctx);
  if (!title) return promptNewTask(ctx);
  try { await aac(token, "POST", "/api/issues", { workspaceId: await wsOf(ctx, token), body: { title } }); await tasks(ctx, 0); }
  catch (e) { await panel(ctx, "⚠️ " + err(e), new InlineKeyboard().text("‹ К задачам", "nav:tasks:0")); }
}
async function completeTask(ctx: Context, id: string) {
  const token = tokenOf(ctx); if (!token) return;
  await aac(token, "PUT", `/api/issues/${id}`, { workspaceId: await wsOf(ctx, token), body: { status: "done" } });
}

async function startChat(ctx: Context, agentId: string) {
  const token = tokenOf(ctx); if (!token) return home(ctx);
  try {
    const w = await wsOf(ctx, token);
    let name = "Агент";
    try { const a = await aac(token, "GET", `/api/agents/${agentId}`, { workspaceId: w }); name = a?.name ?? name; } catch { /* */ }
    const s = await aac(token, "POST", "/api/chat/sessions", { workspaceId: w, body: { agent_id: agentId, title: "Telegram" } });
    if (ctx.from) setChat(ctx.from.id, { agentId, sessionId: s.id, agentName: name });
    await panel(ctx, `💬 *${md(name)}*\n_Напишите сообщение. /stop — выйти._`, new InlineKeyboard().text("‹ Выйти из чата", "chat:exit"));
  } catch (e) { await panel(ctx, "⚠️ " + err(e), new InlineKeyboard().text("‹ Назад", "nav:home")); }
}
async function chatSend(ctx: Context, text: string) {
  const id = ctx.from?.id; const u = id ? getUser(id) : undefined;
  if (!u?.chat || !u.token) return home(ctx);
  const { token } = u; const chat = u.chat; const w = await wsOf(ctx, token);
  let since = new Date().toISOString();
  try { const send = await aac(token, "POST", `/api/chat/sessions/${chat.sessionId}/messages`, { workspaceId: w, body: { content: text } }); if (send?.created_at) since = send.created_at; }
  catch (e) { await ctx.reply("⚠️ " + err(e)); return; }
  for (let i = 0; i < 40; i++) {
    try { await ctx.api.sendChatAction(ctx.chat!.id, "typing"); } catch { /* */ }
    await sleep(2500);
    try {
      const msgs = await aac(token, "GET", `/api/chat/sessions/${chat.sessionId}/messages`, { workspaceId: w });
      const arr: any[] = Array.isArray(msgs) ? msgs : [];
      const fresh = arr.filter((m) => m.role === "assistant" && (m.created_at ?? "") > since && (m.content ?? "").trim());
      const failed = arr.find((m) => m.failure_reason && (m.created_at ?? "") >= since);
      if (fresh.length) { await ctx.reply(fresh.map((m) => m.content).join("\n\n").slice(0, 4000)); return; }
      if (failed) { await ctx.reply("⚠️ Агент не смог ответить: " + (failed.failure_reason ?? "")); return; }
    } catch { /* keep polling */ }
  }
  await ctx.reply("⌛ Агент пока не ответил. Напишите ещё раз или /stop.");
}

bot.catch((e) => console.error("[tg-bot] error:", e.error));

await bot.api.setMyCommands([
  { command: "menu", description: "Меню" },
  { command: "tasks", description: "Задачи" },
  { command: "agents", description: "Агенты" },
  { command: "newtask", description: "Новая задача" },
  { command: "whoami", description: "Профиль" },
  { command: "stop", description: "Выйти из чата" },
  { command: "logout", description: "Отключить ключ" },
]);
await bot.api.setChatMenuButton({ menu_button: { type: "commands" } });
console.error("[tg-bot] starting (long polling) →", serverUrl);
await bot.start();
