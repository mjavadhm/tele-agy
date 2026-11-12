// Telegram Rich Messages (Bot API 10.1+): standard Markdown rendered natively.
// Adapted from the claude-telegram plugin (Apache-2.0).
import type { Bot, InlineKeyboard } from 'grammy'

export const RICH_LIMIT = 30000 // Telegram allows 32768 chars per rich message
export const MAX_CHUNK_LIMIT = 4096
export const RICH_TAGS = /^<\/?(u|ins|sup|sub|tg-spoiler|tg-collage|tg-slideshow|tg-emoji|tg-time|details|summary|b|i|s|em|strong|del|code|pre|a|br)\b/i

// Unknown <tags> are dropped by Telegram; single newlines merge. Escape and keep line breaks.
export function richEscape(md: string): string {
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((seg, i) => (i % 2 === 1 ? seg : seg
      .replace(/<[^<]{0,40}/g, m => (RICH_TAGS.test(m) ? m : '&lt;' + m.slice(1)))
      // Telegram joins single newlines into one line (CommonMark); keep them as hard breaks.
      .replace(/([^\n])\n(?=[^\n])/g, (_m, c) => (c === ' ' || c === '\\' ? c + '\n' : c + '  \n'))))
    .join('')
}


export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      // Prefer the last double-newline (paragraph), then single newline,
      // then space. Fall back to hard cut.
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

/** Where a message goes: a chat, and optionally one topic in it. */
export type Dest = { chat_id: string; thread?: number }
export const threadOpt = (d: Dest | string) => typeof d !== 'string' && d.thread ? { message_thread_id: d.thread } : {}
const chatOf = (d: Dest | string) => typeof d === 'string' ? d : d.chat_id

/** Run a Telegram call; if Telegram says "too many requests", wait as long as it asks and try again. */
export async function patient<T>(call: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await call() } catch (e: any) {
      const wait = e?.error_code === 429 ? Number(e.parameters?.retry_after ?? 1) : 0
      if (!wait || i >= 3 || wait > 60) throw e
      await new Promise(r => setTimeout(r, wait * 1000 + 250))
    }
  }
}

export async function sendRich(
  bot: Bot,
  dest: Dest | string,
  md: string,
  opts: { reply_to?: number; reply_markup?: InlineKeyboard } = {},
): Promise<number[]> {
  const ids: number[] = []
  const chat_id = chatOf(dest)
  const parts = chunk(md, RICH_LIMIT, 'newline')
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1
    const extra = {
      ...threadOpt(dest),
      ...(i === 0 && opts.reply_to != null ? { reply_parameters: { message_id: opts.reply_to } } : {}),
      ...(last && opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
    }
    try {
      const m = await patient(() => (bot.api.raw as any).sendRichMessage({ chat_id, rich_message: { markdown: richEscape(parts[i]!) }, ...extra })) as any
      ids.push(m.message_id)
    } catch (err) {
      console.error(`rich send failed, falling back to plain: ${err}`)
      const plain = chunk(parts[i]!, MAX_CHUNK_LIMIT, 'newline')
      for (let j = 0; j < plain.length; j++) {
        const m = await patient(() => bot.api.sendMessage(chat_id, plain[j]!, {
          ...threadOpt(dest),
          ...(i === 0 && j === 0 && opts.reply_to != null ? { reply_parameters: { message_id: opts.reply_to } } : {}),
          ...(last && j === plain.length - 1 && opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
        }))
        ids.push(m.message_id)
      }
    }
  }
  return ids
}

export async function sendDraft(bot: Bot, dest: Dest, draft_id: number, md: string): Promise<void> {
  await (bot.api.raw as any).sendRichMessageDraft({
    chat_id: Number(dest.chat_id), ...threadOpt(dest), draft_id, rich_message: { markdown: richEscape(md) }, can_stop: true,
  })
}

export const fence = (s: string, lang = '') => '```' + lang + '\n' + s.replace(/```/g, "'''") + '\n```'
export const clip = (s: string, n: number, fromEnd = false) =>
  s.length <= n ? s : fromEnd ? '…' + s.slice(-n) : s.slice(0, n) + '…'
