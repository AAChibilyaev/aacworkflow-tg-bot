#!/usr/bin/env node
/**
 * AACWorkflow Telegram bot — mobile-first, button-driven.
 *
 * Multi-tenant: every Telegram user connects their OWN aacworkflow.com token
 * (/login or the 🔑 button) and manages their own tasks & agents. Tokens are
 * stored locally (0600), never shared.
 *
 * UX: inline keyboards (tap, don't type), a persistent reply keyboard, guided
 * prompts for input (new task / key), and in-place message editing.
 */
import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";
import { aac, resolveWorkspace, serverUrl } from "./aac.js";
import { getUser, setToken, setWorkspace, setChat, clearUser } from "./store.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
if (!BOT_TOKEN) { console.error("[tg-bot] TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather."); process.exit(1); }

const bot = new Bot(BOT_TOKEN);

// Lightweight per-user "awaiting next message" state (lost on restart — fine).
const pending = new Map<number, "newtask" | "login">();

const tokenOf = (ctx: Context) => (ctx.from ? getUser(ctx.from.id)?.token ?? null : null);
const wsOf = (ctx: Context, token: string) => resolveWorkspace(token, ctx.from ? getUser(ctx.from.id)?.workspaceId : undefined);

const homeKb = () =>
  new InlineKeyboard()
    .text("📋 Задачи", "m:tasks").text("🤖 Агенты", "m:agents").row()
    .text("➕ Новая задача", "m:new").text("🏢 Компании", "m:ws").row()
    .text("👤 Профиль", "m:me").text("🔄 Обновить", "m:home");

const replyKb = () =>
  new Keyboard().text("📋 Задачи").text("➕ Новая задача").row().text("🤖 Агенты").text("☰ Меню").resized().persistent();

const loginKb = () => new InlineKeyboard().text("🔑 Подключить ключ", "m:login");

/** Reply (for commands/typed text) or edit-in-place (for button taps). */
async function show(ctx: Context, text: string, kb?: InlineKeyboard, edit = false) {
  const opts = { parse_mode: "Markdown" as const, reply_markup: kb };
  try {
    if (edit && ctx.callbackQuery) await ctx.editMessageText(text, opts);
    else await ctx.reply(text, opts);
  } catch { await ctx.reply(text, opts); }
}

const NEED_LOGIN = "Подключи свой ключ AACWorkflow — нажми кнопку ниже или отправь `/login mul_…`.\n\nКлюч: " + serverUrl + " → Settings → Tokens.";

// ── Views (shared by commands and buttons) ──────────────────────────────
async function viewHome(ctx: Context, edit = false) {
  if (!tokenOf(ctx)) return show(ctx, "👋 *AACWorkflow*\n\n" + NEED_LOGIN, loginKb(), edit);
  await show(ctx, "🏠 *Главное меню*\nВыбери действие:", homeKb(), edit);
}
async function viewTasks(ctx: Context, edit = false) {
  const token = tokenOf(ctx); if (!token) return viewHome(ctx, edit);
  try {
    const w = await wsOf(ctx, token);
    const data = await aac(token, "GET", "/api/issues", { workspaceId: w });
    const arr: any[] = Array.isArray(data) ? data : data?.issues ?? data?.data ?? [];
    const kb = new InlineKeyboard();
    arr.slice(0, 12).forEach((i) => kb.text(`${statusDot(i.status)} ${truncate(i.title, 38)}`, `t:open:${i.id}`).row());
    kb.text("➕ Новая", "m:new").text("🔄", "m:tasks").row().text("⬅️ Меню", "m:home");
    await show(ctx, arr.length ? `📋 *Задачи* (${arr.length})` : "📋 Задач нет. Создай новую 👇", kb, edit);
  } catch (e) { await show(ctx, "⚠️ " + errText(e), homeKb(), edit); }
}
async function viewTask(ctx: Context, id: string, edit = true) {
  const token = tokenOf(ctx); if (!token) return viewHome(ctx, edit);
  try {
    const w = await wsOf(ctx, token);
    const i = await aac(token, "GET", `/api/issues/${id}`, { workspaceId: w });
    const txt =
      `${statusDot(i.status)} *${escape(i.title)}*\n` +
      (i.identifier ? `\`${i.identifier}\`  ` : "") + `статус: ${i.status ?? "?"} · приоритет: ${i.priority ?? "—"}\n\n` +
      (i.description ? escape(String(i.description)).slice(0, 500) : "_без описания_");
    const kb = new InlineKeyboard();
    if (i.status !== "done") kb.text("✅ Готово", `t:done:${id}`);
    kb.text("🔄", `t:open:${id}`).row().text("⬅️ К задачам", "m:tasks");
    await show(ctx, txt, kb, edit);
  } catch (e) { await show(ctx, "⚠️ " + errText(e), new InlineKeyboard().text("⬅️ К задачам", "m:tasks"), edit); }
}
async function viewAgents(ctx: Context, edit = false) {
  const token = tokenOf(ctx); if (!token) return viewHome(ctx, edit);
  try {
    const w = await wsOf(ctx, token);
    const data = await aac(token, "GET", "/api/agents", { workspaceId: w });
    const arr: any[] = Array.isArray(data) ? data : data?.agents ?? data?.data ?? [];
    const kb = new InlineKeyboard();
    arr.slice(0, 12).forEach((a) => kb.text(`💬 ${truncate(a.name, 34)}`, `a:chat:${a.id}`).row());
    kb.text("🔄", "m:agents").text("⬅️ Меню", "m:home");
    await show(ctx, arr.length ? "🤖 *Агенты* — нажми, чтобы начать чат:" : "🤖 Агентов пока нет.", kb, edit);
  } catch (e) { await show(ctx, "⚠️ " + errText(e), homeKb(), edit); }
}
async function viewWorkspaces(ctx: Context, edit = false) {
  const token = tokenOf(ctx); if (!token) return viewHome(ctx, edit);
  try {
    const data = await aac(token, "GET", "/api/workspaces");
    const arr: any[] = Array.isArray(data) ? data : data?.workspaces ?? data?.data ?? [];
    const active = ctx.from ? getUser(ctx.from.id)?.workspaceId : undefined;
    const kb = new InlineKeyboard();
    arr.forEach((wk) => kb.text(`${active === wk.id ? "✅ " : ""}${truncate(wk.name, 36)}`, `ws:${wk.id}`).row());
    kb.text("⬅️ Меню", "m:home");
    await show(ctx, "🏢 *Твои компании* — нажми, чтобы выбрать активную:", kb, edit);
  } catch (e) { await show(ctx, "⚠️ " + errText(e), homeKb(), edit); }
}
async function viewMe(ctx: Context, edit = false) {
  const token = tokenOf(ctx); if (!token) return viewHome(ctx, edit);
  try {
    const me = await aac(token, "GET", "/api/me");
    await show(ctx, `👤 *${escape(me?.name ?? "?")}*\n${escape(me?.email ?? "")}`,
      new InlineKeyboard().text("🚪 Отключить ключ", "m:logout").row().text("⬅️ Меню", "m:home"), edit);
  } catch (e) { await show(ctx, "⚠️ " + errText(e), homeKb(), edit); }
}

// ── Commands (power users keep typing) ──────────────────────────────────
bot.command("start", (ctx) => viewHome(ctx));
bot.command("menu", (ctx) => viewHome(ctx));
bot.command("help", (ctx) =>
  ctx.reply("*Команды:* /menu, /tasks, /newtask <текст>, /agents, /workspaces, /whoami, /login mul_…, /logout.\nИли просто пользуйся кнопками 👇",
    { parse_mode: "Markdown", reply_markup: replyKb() }));
bot.command("tasks", (ctx) => viewTasks(ctx));
bot.command("agents", (ctx) => viewAgents(ctx));
bot.command("workspaces", (ctx) => viewWorkspaces(ctx));
bot.command("whoami", (ctx) => viewMe(ctx));
bot.command("logout", (ctx) => { if (ctx.from) clearUser(ctx.from.id); return ctx.reply("Ключ удалён.", { reply_markup: loginKb() }); });
bot.command("login", (ctx) => handleToken(ctx, (ctx.match ?? "").trim()));
bot.command("newtask", async (ctx) => {
  const title = (ctx.match ?? "").trim();
  if (!title) { if (ctx.from) pending.set(ctx.from.id, "newtask"); return ctx.reply("✍️ Напиши текст новой задачи одним сообщением:"); }
  await createTask(ctx, title);
});
bot.command("stop", (ctx) => { if (ctx.from) setChat(ctx.from.id, undefined); return ctx.reply("💬 Чат с агентом завершён.", { reply_markup: replyKb() }); });
bot.command("use", (ctx) => { const id = (ctx.match ?? "").trim(); if (id && ctx.from) { setWorkspace(ctx.from.id, id); return ctx.reply("✅ Активная компания: `" + id + "`", { parse_mode: "Markdown" }); } return ctx.reply("Лучше выбери кнопкой: /workspaces"); });

// ── Reply-keyboard buttons ──────────────────────────────────────────────
bot.hears("📋 Задачи", (ctx) => viewTasks(ctx));
bot.hears("🤖 Агенты", (ctx) => viewAgents(ctx));
bot.hears("☰ Меню", (ctx) => viewHome(ctx));
bot.hears("➕ Новая задача", (ctx) => { if (ctx.from) pending.set(ctx.from.id, "newtask"); return ctx.reply("✍️ Напиши текст новой задачи одним сообщением:"); });

// ── Inline button taps ──────────────────────────────────────────────────
bot.on("callback_query:data", async (ctx) => {
  const d = ctx.callbackQuery.data;
  try {
    if (d === "m:home") await viewHome(ctx, true);
    else if (d === "m:tasks") await viewTasks(ctx, true);
    else if (d === "m:agents") await viewAgents(ctx, true);
    else if (d === "m:ws") await viewWorkspaces(ctx, true);
    else if (d === "m:me") await viewMe(ctx, true);
    else if (d === "m:login") { if (ctx.from) pending.set(ctx.from.id, "login"); await ctx.reply("🔑 Пришли свой ключ AACWorkflow одним сообщением (`mul_…`).", { parse_mode: "Markdown" }); }
    else if (d === "m:logout") { if (ctx.from) clearUser(ctx.from.id); await show(ctx, "Ключ удалён.", undefined, true); await ctx.reply("Подключить заново:", { reply_markup: loginKb() }); }
    else if (d === "m:new") { if (ctx.from) pending.set(ctx.from.id, "newtask"); await ctx.reply("✍️ Напиши текст новой задачи одним сообщением:"); }
    else if (d.startsWith("t:open:")) await viewTask(ctx, d.slice(7), true);
    else if (d.startsWith("t:done:")) { await completeTask(ctx, d.slice(7)); await viewTasks(ctx, true); }
    else if (d.startsWith("ws:")) { if (ctx.from) setWorkspace(ctx.from.id, d.slice(3)); await viewWorkspaces(ctx, true); }
    else if (d.startsWith("a:chat:")) await startChat(ctx, d.slice(7));
    else if (d === "m:stop") { if (ctx.from) setChat(ctx.from.id, undefined); await show(ctx, "💬 Чат завершён.", undefined, true); await viewHome(ctx); }
    await ctx.answerCallbackQuery();
  } catch (e) { await ctx.answerCallbackQuery({ text: errText(e).slice(0, 190), show_alert: true }); }
});

// ── Free text → pending action (login / new task). Runs after the above. ─
bot.on("message:text", async (ctx) => {
  const id = ctx.from?.id; if (!id) return;
  const act = pending.get(id);
  if (act) {
    pending.delete(id);
    if (act === "login") return handleToken(ctx, ctx.message.text.trim());
    if (act === "newtask") return createTask(ctx, ctx.message.text.trim());
  }
  if (getUser(id)?.chat) return chatSend(ctx, ctx.message.text);
  return viewHome(ctx);
});

// ── Actions ─────────────────────────────────────────────────────────────
async function handleToken(ctx: Context, token: string) {
  if (!token.startsWith("mul_")) return ctx.reply("Это не похоже на ключ. Нужен `mul_…`.", { parse_mode: "Markdown", reply_markup: loginKb() });
  try {
    const me = await aac(token, "GET", "/api/me");
    if (ctx.from) setToken(ctx.from.id, token);
    try { await ctx.deleteMessage(); } catch { /* keep token out of history */ }
    await ctx.reply(`✅ Подключено как *${escape(me?.name ?? me?.email ?? "?")}*.`, { parse_mode: "Markdown", reply_markup: replyKb() });
    await viewHome(ctx);
  } catch (e) { await ctx.reply("❌ Ключ не принят: " + errText(e), { reply_markup: loginKb() }); }
}
async function createTask(ctx: Context, title: string) {
  const token = tokenOf(ctx); if (!token) return viewHome(ctx);
  if (!title) return ctx.reply("Пустой текст. Попробуй ещё раз кнопкой ➕.");
  try {
    const w = await wsOf(ctx, token);
    const i = await aac(token, "POST", "/api/issues", { workspaceId: w, body: { title } });
    await ctx.reply(`✅ Создано: *${escape(i?.title ?? title)}*` + (i?.identifier ? ` (${i.identifier})` : ""),
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("📋 К задачам", "m:tasks") });
  } catch (e) { await ctx.reply("⚠️ " + errText(e)); }
}
async function startChat(ctx: Context, agentId: string) {
  const token = tokenOf(ctx); if (!token) return viewHome(ctx, true);
  try {
    const w = await wsOf(ctx, token);
    let name = "агент";
    try { const a = await aac(token, "GET", `/api/agents/${agentId}`, { workspaceId: w }); name = a?.name ?? name; } catch { /* ignore */ }
    const session = await aac(token, "POST", "/api/chat/sessions", { workspaceId: w, body: { agent_id: agentId, title: "Telegram" } });
    if (ctx.from) setChat(ctx.from.id, { agentId, sessionId: session.id, agentName: name });
    await show(ctx, `💬 *Чат с ${escape(name)}*\nПиши сообщение — он ответит. /stop — выйти.`, new InlineKeyboard().text("🛑 Выйти из чата", "m:stop"), true);
  } catch (e) { await show(ctx, "⚠️ " + errText(e), homeKb(), true); }
}

async function chatSend(ctx: Context, text: string) {
  const id = ctx.from?.id; const u = id ? getUser(id) : undefined;
  if (!u?.chat || !u.token) return viewHome(ctx);
  const { token } = u; const chat = u.chat;
  let since = new Date().toISOString();
  try {
    const send = await aac(token, "POST", `/api/chat/sessions/${chat.sessionId}/messages`, { workspaceId: await wsOf(ctx, token), body: { content: text } });
    if (send?.created_at) since = send.created_at;
  } catch (e) { await ctx.reply("⚠️ " + errText(e)); return; }
  const thinking = await ctx.reply(`⏳ ${chat.agentName} печатает…`);
  const w = await wsOf(ctx, token);
  for (let i = 0; i < 40; i++) {
    await sleep(2500);
    try {
      const msgs = await aac(token, "GET", `/api/chat/sessions/${chat.sessionId}/messages`, { workspaceId: w });
      const arr: any[] = Array.isArray(msgs) ? msgs : [];
      const fresh = arr.filter((m) => m.role === "assistant" && (m.created_at ?? "") > since && (m.content ?? "").trim());
      const failed = arr.find((m) => m.failure_reason && (m.created_at ?? "") >= since);
      if (fresh.length) {
        const reply = fresh.map((m) => m.content).join("\n\n").slice(0, 3800);
        await ctx.api.editMessageText(thinking.chat.id, thinking.message_id, `🤖 ${chat.agentName}:\n\n${reply}`);
        return;
      }
      if (failed) { await ctx.api.editMessageText(thinking.chat.id, thinking.message_id, "⚠️ Агент не смог ответить: " + (failed.failure_reason ?? "")); return; }
    } catch { /* keep polling */ }
  }
  await ctx.api.editMessageText(thinking.chat.id, thinking.message_id, "⌛ Агент пока не ответил. Напиши ещё раз или /stop.");
}

async function completeTask(ctx: Context, id: string) {
  const token = tokenOf(ctx); if (!token) return;
  const w = await wsOf(ctx, token);
  await aac(token, "PUT", `/api/issues/${id}`, { workspaceId: w, body: { status: "done" } });
}

// ── Helpers ─────────────────────────────────────────────────────────────
const truncate = (s: string, n: number) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s ?? "");
const escape = (s: string) => String(s ?? "").replace(/([_*`\[])/g, "\\$1");
const errText = (e: unknown) => String(e instanceof Error ? e.message : e);
function statusDot(s?: string) {
  return s === "done" ? "✅" : s === "in_progress" || s === "started" ? "🔵" : s === "cancelled" ? "⚪️" : "🟡";
}

bot.catch((err) => console.error("[tg-bot] error:", err.error));

await bot.api.setMyCommands([
  { command: "menu", description: "Главное меню" },
  { command: "tasks", description: "Мои задачи" },
  { command: "newtask", description: "Создать задачу" },
  { command: "agents", description: "Мои агенты" },
  { command: "workspaces", description: "Мои компании" },
  { command: "whoami", description: "Профиль" },
  { command: "login", description: "Подключить ключ" },
  { command: "logout", description: "Отключить ключ" },
]);
await bot.api.setChatMenuButton({ menu_button: { type: "commands" } });

console.error("[tg-bot] starting (long polling) →", serverUrl);
await bot.start();
