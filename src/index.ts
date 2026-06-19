#!/usr/bin/env node
/**
 * AACWorkflow Telegram bot.
 *
 * Multi-tenant: every Telegram user connects with their OWN aacworkflow.com
 * token (/login mul_…) and manages their own tasks & agents. The bot stores
 * each user's token locally and never shares it.
 */
import { Bot, type Context } from "grammy";
import { aac, resolveWorkspace, serverUrl } from "./aac.js";
import { getUser, setToken, setWorkspace, clearUser } from "./store.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
if (!BOT_TOKEN) {
  console.error("[tg-bot] TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and set TELEGRAM_BOT_TOKEN.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

/** Get the caller's token or reply with a hint. Returns null if not logged in. */
function tokenOf(ctx: Context): string | null {
  const u = ctx.from ? getUser(ctx.from.id) : undefined;
  return u?.token ?? null;
}
async function ws(ctx: Context, token: string): Promise<string> {
  const u = ctx.from ? getUser(ctx.from.id) : undefined;
  return resolveWorkspace(token, u?.workspaceId);
}
const notLoggedIn = "Сначала подключи свой ключ AACWorkflow:\n`/login mul_ВАШ_КЛЮЧ`\n\nКлюч создаётся в " + serverUrl + " → Settings → Tokens.";

bot.command("start", (ctx) =>
  ctx.reply(
    "👋 *AACWorkflow бот*\n\nЯ работаю с твоими задачами и агентами в AACWorkflow. Каждый пользователь подключает *свой* ключ.\n\n" +
      "1️⃣ Создай ключ: " + serverUrl + " → Settings → Tokens\n" +
      "2️⃣ Подключи: `/login mul_ВАШ_КЛЮЧ`\n\n" +
      "Затем: /tasks, /agents, /newtask, /whoami. Команды — /help.",
    { parse_mode: "Markdown" },
  ),
);

bot.command("help", (ctx) =>
  ctx.reply(
    "*Команды:*\n" +
      "`/login <ключ>` — подключить свой ключ AACWorkflow\n" +
      "`/logout` — отключить ключ\n" +
      "`/whoami` — кто я\n" +
      "`/workspaces` — мои компании · `/use <id>` — выбрать\n" +
      "`/agents` — мои агенты\n" +
      "`/tasks` — мои задачи\n" +
      "`/newtask <текст>` — создать задачу\n",
    { parse_mode: "Markdown" },
  ),
);

bot.command("login", async (ctx) => {
  const token = (ctx.match ?? "").trim();
  if (!token.startsWith("mul_")) { await ctx.reply("Укажи ключ: `/login mul_…`", { parse_mode: "Markdown" }); return; }
  // Validate against the API before saving.
  try {
    const me = await aac(token, "GET", "/api/me");
    if (ctx.from) setToken(ctx.from.id, token);
    // Remove the message so the token doesn't linger in chat history.
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    await ctx.reply(`✅ Подключено как *${me?.name ?? me?.email ?? "?"}*.\nПопробуй /workspaces или /tasks.`, { parse_mode: "Markdown" });
  } catch (e) {
    await ctx.reply("❌ Ключ не принят: " + String(e instanceof Error ? e.message : e));
  }
});

bot.command("logout", (ctx) => { if (ctx.from) clearUser(ctx.from.id); return ctx.reply("Ключ удалён. /login чтобы подключить снова."); });

bot.command("whoami", async (ctx) => {
  const token = tokenOf(ctx); if (!token) return ctx.reply(notLoggedIn, { parse_mode: "Markdown" });
  try { const me = await aac(token, "GET", "/api/me"); await ctx.reply(`👤 *${me?.name ?? "?"}*\n${me?.email ?? ""}`, { parse_mode: "Markdown" }); }
  catch (e) { await ctx.reply("Ошибка: " + String(e)); }
});

bot.command("workspaces", async (ctx) => {
  const token = tokenOf(ctx); if (!token) return ctx.reply(notLoggedIn, { parse_mode: "Markdown" });
  try {
    const data = await aac(token, "GET", "/api/workspaces");
    const arr: any[] = Array.isArray(data) ? data : data?.workspaces ?? data?.data ?? [];
    if (!arr.length) return ctx.reply("Нет рабочих пространств.");
    await ctx.reply("🏢 *Твои компании:*\n" + arr.map((w) => `• ${w.name} — \`${w.id}\``).join("\n") + "\n\nВыбрать: `/use <id>`", { parse_mode: "Markdown" });
  } catch (e) { await ctx.reply("Ошибка: " + String(e)); }
});

bot.command("use", async (ctx) => {
  const token = tokenOf(ctx); if (!token) return ctx.reply(notLoggedIn, { parse_mode: "Markdown" });
  const id = (ctx.match ?? "").trim(); if (!id) return ctx.reply("Укажи id: `/use <workspace-id>`", { parse_mode: "Markdown" });
  if (ctx.from) setWorkspace(ctx.from.id, id);
  await ctx.reply("✅ Активная компания: `" + id + "`", { parse_mode: "Markdown" });
});

bot.command("agents", async (ctx) => {
  const token = tokenOf(ctx); if (!token) return ctx.reply(notLoggedIn, { parse_mode: "Markdown" });
  try {
    const w = await ws(ctx, token);
    const data = await aac(token, "GET", "/api/agents", { workspaceId: w });
    const arr: any[] = Array.isArray(data) ? data : data?.agents ?? data?.data ?? [];
    if (!arr.length) return ctx.reply("Агентов пока нет.");
    await ctx.reply("🤖 *Агенты:*\n" + arr.map((a) => `• ${a.name} — ${a.status ?? "?"}`).join("\n"), { parse_mode: "Markdown" });
  } catch (e) { await ctx.reply("Ошибка: " + String(e instanceof Error ? e.message : e)); }
});

bot.command("tasks", async (ctx) => {
  const token = tokenOf(ctx); if (!token) return ctx.reply(notLoggedIn, { parse_mode: "Markdown" });
  try {
    const w = await ws(ctx, token);
    const data = await aac(token, "GET", "/api/issues", { workspaceId: w });
    const arr: any[] = Array.isArray(data) ? data : data?.issues ?? data?.data ?? [];
    if (!arr.length) return ctx.reply("Задач нет. Создай: `/newtask текст`", { parse_mode: "Markdown" });
    await ctx.reply("📋 *Задачи:*\n" + arr.slice(0, 30).map((i) => `• [${i.status ?? "?"}] ${i.title}`).join("\n"), { parse_mode: "Markdown" });
  } catch (e) { await ctx.reply("Ошибка: " + String(e instanceof Error ? e.message : e)); }
});

bot.command("newtask", async (ctx) => {
  const token = tokenOf(ctx); if (!token) return ctx.reply(notLoggedIn, { parse_mode: "Markdown" });
  const title = (ctx.match ?? "").trim(); if (!title) return ctx.reply("Текст задачи: `/newtask Сделать X`", { parse_mode: "Markdown" });
  try {
    const w = await ws(ctx, token);
    const issue = await aac(token, "POST", "/api/issues", { workspaceId: w, body: { title } });
    await ctx.reply(`✅ Задача создана: *${issue?.title ?? title}*` + (issue?.identifier ? ` (${issue.identifier})` : ""), { parse_mode: "Markdown" });
  } catch (e) { await ctx.reply("Ошибка: " + String(e instanceof Error ? e.message : e)); }
});

bot.catch((err) => console.error("[tg-bot] error:", err.error));

await bot.api.setMyCommands([
  { command: "login", description: "Подключить свой ключ AACWorkflow" },
  { command: "tasks", description: "Мои задачи" },
  { command: "newtask", description: "Создать задачу" },
  { command: "agents", description: "Мои агенты" },
  { command: "workspaces", description: "Мои компании" },
  { command: "whoami", description: "Кто я" },
  { command: "logout", description: "Отключить ключ" },
  { command: "help", description: "Помощь" },
]);

console.error("[tg-bot] starting (long polling) →", serverUrl);
await bot.start();
