# agy-telegram

Use Google's **Antigravity CLI (`agy`)** from Telegram, as if you were in a terminal on your server.

The bot talks to agy through its built-in **Agent Client Protocol** server (`agy acp`), the same
way an editor does, so it gets real streaming reply text, thinking, every tool call with its
output, plans and permission requests.

## Features

- **One agy session per Telegram account.** Accounts work in parallel, like separate terminals
  on the same machine. At most `MAX_SESSIONS` (default 3) run at once; the session idle longest is
  stopped when another one is needed, and its chat reopens on that account's next message.
- **Live progress.** The reply streams word by word into a Telegram draft, together with the
  plan checklist and each tool step, which you can tap open to see its input and output. The
  draft has Telegram's Stop button.
- **Permission prompts as buttons.** You get the Allow/Deny options agy itself offers.
- **Terminal controls:**
  - `/model`, `/think` (thinking level) and `/mode` (default, accept edits, plan, or auto with no
    prompts)
  - `/new`, `/resume` (`/resume all` covers every folder) and `/project`
  - `/restart` and `/config` (agy's `settings.json`)
- **agy's own commands** (`/goal`, `/compact`, `/plan`, `/browser`, `/teamwork` …) are sent to agy
  as typed. They are also added to your `/` menu.
- **agy management:** `/mcp`, `/plugins`, `/agents`, `/models`, `/changelog`. Arguments are passed
  on, for example `/mcp disable github`.
- **Extras:**
  - `/steps` (everything the last turn did), `/diff` (uncommitted git changes), `/status`,
    `/sessions`, `/usage`, `/live`
  - `!command` runs a shell command in your folder; it is logged, and an admin can turn it off
    with `/shell off`
- **Attachments:** photos are sent to agy as images. Other files are saved on the server and their
  path is passed on.
- **Accounts:** admins come from `ADMIN_IDS`. An admin's `/invite` makes a 15-minute link, and
  `/users` removes accounts or makes them admins.

## Setup

**Requirements:** [Bun](https://bun.sh), and agy installed and signed in on the server.

1. Install agy:

   ```bash
   curl -fsSL https://antigravity.google/cli/install.sh | bash
   agy   # sign in once
   ```

2. Install and configure the bot:

   ```bash
   git clone <this repo> /root/agy-telegram && cd /root/agy-telegram
   bun install
   cp .env.example .env   # set TELEGRAM_BOT_TOKEN and ADMIN_IDS
   ```

3. Run it as a service:

   ```bash
   cp deploy/agy-telegram.service /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now agy-telegram
   ```

**Logs:** `journalctl -u agy-telegram -f`. State (accounts, chats, inbox) lives in `./data/`,
which is not tracked by git.

## Layout

| File | What it does |
|---|---|
| `src/bot.ts` | Telegram commands, buttons, messages, accounts |
| `src/session.ts` | One agy process and chat per account; streaming, steps, permissions, session cap |
| `src/acp.ts` | Small ACP (JSON-RPC over stdio) client for `agy acp` |
| `src/rich.ts` | Telegram Rich Messages (Markdown), adapted from the claude-telegram plugin |
| `src/store.ts` | JSON state in `./data` |

## Security

- Anyone you invite can make agy run commands on your server, and can use `!` shell directly.
- In auto mode agy runs everything without asking.
- Only invite people you trust with that access.

## License

Apache-2.0. Parts are adapted from Anthropic's Telegram channel plugin for Claude Code
(Apache-2.0).
