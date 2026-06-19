# aacworkflow-tg-bot

Telegram bot for [AACWorkflow](https://aacworkflow.com). **Multi-tenant:** every
Telegram user connects with their **own** aacworkflow.com token and manages
their own tasks & agents. Tokens are stored locally (0600), never shared.

## Setup
1. Create a bot: Telegram → **@BotFather** → `/newbot` → copy the token.
2. Run:
   ```bash
   npm install && npm run build
   TELEGRAM_BOT_TOKEN=123:ABC npm start
   ```
   or Docker: `docker build -t aacworkflow-tg-bot . && docker run -e TELEGRAM_BOT_TOKEN=123:ABC -v aacwtg:/data aacworkflow-tg-bot`

## Customer flow (in Telegram)
- `/login mul_…` — connect your AACWorkflow key (created at Settings → Tokens). The message is auto-deleted.
- `/tasks`, `/newtask <text>`, `/agents`, `/whoami`
- `/workspaces` + `/use <id>` — pick a company if you have several
- `/logout`

## Config
| Env | Default | |
|-----|---------|---|
| `TELEGRAM_BOT_TOKEN` | — | **required** (BotFather) |
| `AACWORKFLOW_SERVER_URL` | `https://aacworkflow.com` | |
| `DATA_FILE` | `./data/users.json` | per-user token store |
