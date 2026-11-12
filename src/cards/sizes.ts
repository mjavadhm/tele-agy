// `bun src/cards/sizes.ts`: each card's HTML size as Telegram counts it (≤32768 bytes, ≤4096 after zlib -9).
import { packedSize } from './kit.ts'
import { USAGE_HTML } from './usage.ts'
import { LIVE_HTML } from './live.ts'
import { STATUS_HTML } from './status.ts'
import { DIFF_HTML } from './diff.ts'

let bad = false
for (const [name, html] of Object.entries({ usage: USAGE_HTML, live: LIVE_HTML, status: STATUS_HTML, diff: DIFF_HTML })) {
  const raw = Buffer.byteLength(html), packed = packedSize(html)
  const ok = raw <= 32768 && packed <= 4096 && !html.includes('\0')
  bad ||= !ok
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(7)} ${String(raw).padStart(6)} bytes, ${String(packed).padStart(5)} compressed`)
}
process.exit(bad ? 1 : 0)
