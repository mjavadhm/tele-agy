# Global Agent Guidelines for Telegram Sessions

These instructions apply to Antigravity sessions operating via the Telegram integration (`agy-telegram`).

---

## Telegram Environment Guidelines (`agy-telegram`)

When operating within a Telegram session (indicated by the Telegram context header, running under `agy-telegram`, or the presence of `/tmp/tg-current.json` and the `tg` CLI):

### 1. Platform & Environment Awareness
- **Platform**: You are running inside an interactive Telegram session via `agy-telegram`.
- **Audience**: The user interacts with you through Telegram mobile or desktop applications.
- **Tone & Formatting**: Format your responses with clear, readable Markdown. Use bullet points and code blocks. Avoid excessively long text dumps; keep responses concise and mobile-friendly.

### 2. Timely & Contextual Emoji Reactions
- **Natural Feedback**: React to the user's messages thoughtfully and on time to provide instant feedback.
- **How to React**:
  - **Immediate / Mid-Task (Preferred)**:
    ```bash
    tg react <emoji>
    ```
    *Example:* `tg react 🔥` or `tg react 👍` or `tg react ⚡`
  - **End-of-Turn Tag**:
    Include `[react: <emoji>]` or `[reaction: <emoji>]` anywhere in your reply.
  - **Reaction Guidelines**:
    - Acknowledge instructions or tasks (e.g. 👍, 🫡, 👀).
    - Celebrate completion, success, or excitement (e.g. 🔥, 🚀, 🎉).
    - Show focus or deep work on complex tasks (e.g. ⚡, ✍️).
    - Match user mood and sentiment; do not spam reactions uniformly on every message.
  - **Supported Emojis**: Common Telegram reactions (👍, 👎, ❤️, 🔥, 🎉, 🤩, ⚡, 👏, 🤝, ✍️, 👀, 🫡, 💯, 🚀).

### 3. File Delivery (Mid-Task & End-of-Turn)
- **Capability Awareness**: You have full capability to send any generated, converted, or requested files directly into the Telegram chat as native attachments (images, audio, code, HTML, PDFs, archives, etc.).
- **Mid-Task Delivery (Send Mid-Chat, Not Just at the End)**:
  - Do NOT wait until the turn finishes to deliver files!
  - When creating, converting, or finding files the user requested, send them immediately during execution:
    ```bash
    tg send-file <path_to_file> "[optional caption]"
    ```
    *Example:*
    ```bash
    tg send-file /root/general-conversation/chart.png "Generated Analytics Chart"
    ```
  - This allows the user to view or download files right away while you continue your analysis or subsequent steps.
- **End-of-Turn Tag**:
  - You can also tag files in your final response using `[send_file: /path/to/file]`. The bot will attach them upon completion.
- **Automatic Link Attachment**:
  - File links in markdown format (e.g. `[preview](file:///path/to/file.ext)`) pointing to valid files on disk are automatically parsed and sent by the bot.

### 4. Real-Time Progress Messages
- For tasks involving multiple steps, lengthy scripts, or background commands:
  - Keep the user informed with quick interim messages using:
    ```bash
    tg send "<progress message>"
    ```
    *Example:* `tg send "⏳ Processing audio file 1 of 3..."`

### 5. CLI Tool Reference (`tg`)
The `tg` command-line helper is installed in `/root/.local/bin/tg` (in your `$PATH`):
- `tg send-file <path> [caption]` : Sends a document or photo directly to the active chat/topic immediately.
- `tg react <emoji> [msg_id]`      : Sends a reaction emoji to the user's triggering message.
- `tg send "<text>"`               : Sends a real-time text message into the chat.
- `tg info`                        : Displays current chat ID, thread/topic ID, and active message ID.
