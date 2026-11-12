// Some agy commands (/usage, /credits, /skills …) exist only in its terminal UI, not over ACP.
// Run them in a short-lived hidden agy terminal (tmux), read the screen, and close it.
import { execFileSync } from 'child_process'
import { mkdirSync } from 'fs'
import { AGY_BIN } from './session.ts'

const DIR = '/tmp/agy-tui'
const NAME = 'agy-tg-tui'
const tmux = (...a: string[]) => { try { return execFileSync('tmux', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return '' } }
const capture = (ansi = false) => tmux('capture-pane', '-p', ...(ansi ? ['-e'] : []), '-t', NAME)
let busy: Promise<unknown> = Promise.resolve()

/** The part of the screen below the input box, without the key hints and status line. */
export function commandOutput(screen: string): string {
  const lines = screen.split('\n')
  const seps = lines.map((l, i) => (/^─{20,}/.test(l.trim()) ? i : -1)).filter(i => i >= 0)
  const start = seps.length >= 2 ? seps[1]! + 1 : 0
  const body = lines.slice(start)
  while (body.length && (!body.at(-1)!.trim() || /(esc|enter) (Close|Cancel|to|Select)|·\s*(high|medium|low)\s*$|↑\/↓/.test(body.at(-1)!))) body.pop()
  const min = Math.min(...body.filter(l => l.trim()).map(l => l.match(/^ */)![0].length))
  return body.map(l => l.slice(Number.isFinite(min) ? min : 0).replace(/\s+$/, '')).join('\n').replace(/^\n+/, '').trim()
}

export function runTuiCommand(cmd: string): Promise<{ text: string; ansi: string }> {
  const run = busy.then(() => doRun(cmd))
  busy = run.catch(() => {})
  return run
}

async function doRun(cmd: string): Promise<{ text: string; ansi: string }> {
  mkdirSync(DIR, { recursive: true })
  tmux('kill-session', '-t', NAME)
  tmux('new-session', '-d', '-s', NAME, '-x', '110', '-y', '60', '-c', DIR, AGY_BIN)
  try {
    // Wait for the input prompt (accept the folder-trust question on first use).
    let ready = false
    for (let i = 0; i < 60 && !ready; i++) {
      await Bun.sleep(500)
      const s = capture()
      if (/Do you trust the contents/.test(s)) { tmux('send-keys', '-t', NAME, 'Enter'); continue }
      if (/not signed in|Select login method/.test(s)) throw new Error('agy is not signed in on the server')
      ready = /^─{20,}\s*\n>/m.test(s)
    }
    if (!ready) throw new Error('agy terminal did not start')
    tmux('send-keys', '-t', NAME, 'Escape') // dismiss any banner
    await Bun.sleep(300)
    tmux('send-keys', '-t', NAME, '-l', cmd)
    await Bun.sleep(800)
    tmux('send-keys', '-t', NAME, 'Enter')
    await Bun.sleep(700)
    // First Enter may only pick the command from the completion list.
    if (new RegExp(`^>\\s*${cmd.replace(/[/\\-]/g, m => '\\' + m)}\\s*$`, 'm').test(capture())) tmux('send-keys', '-t', NAME, 'Enter')
    let last = '', stableSince = Date.now()
    const t0 = Date.now()
    while (Date.now() - t0 < 25_000) {
      await Bun.sleep(500)
      const s = capture()
      if (s !== last) { last = s; stableSince = Date.now() }
      else if (Date.now() - stableSince > 2000 && Date.now() - t0 > 3000) break
    }
    return { text: commandOutput(last), ansi: capture(true) }
  } finally {
    tmux('kill-session', '-t', NAME)
  }
}
