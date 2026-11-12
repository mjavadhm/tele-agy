// /import: how many messages the user sent in a saved agy chat, read from agy's own store.
// agy keeps one SQLite file per chat; each row of `steps` is one step, and type 14 is a user message.
import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'

const CONVERSATIONS = join(process.env.HOME ?? '/root', '.gemini', 'antigravity-cli', 'conversations')
const USER_INPUT_STEP = 14

/** Number of user messages in the chat, or -1 if it can't be read (no file, or agy changed its format). */
export function userMessages(sessionId: string): number {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return -1
  const path = join(CONVERSATIONS, `${sessionId}.db`)
  if (!existsSync(path)) return -1
  let db: Database | null = null
  try {
    db = new Database(path, { readonly: true })
    const r = db.query('select count(*) as n from steps where step_type = ?').get(USER_INPUT_STEP) as { n: number } | null
    return r?.n ?? 0
  } catch { return -1 } finally { try { db?.close() } catch {} }
}
