// Adapted from the claude-telegram plugin (Apache-2.0).
// Terminal screenshot: tmux `capture-pane -e` output (text + ANSI colours) → SVG → PNG.
// Rendering uses resvg (prebuilt, no system deps) with fonts bundled in ./fonts.
import { Resvg } from '@resvg/resvg-js'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fonts')
const FONTS = ['DejaVuSansMono.ttf', 'DejaVuSansMono-Bold.ttf', 'DejaVuSans.ttf', 'Vazirmatn-Regular.ttf', 'Vazirmatn-Bold.ttf']
  .map(f => join(FONT_DIR, f))

const FG = '#d4d4d4'
const BG = '#1e1e1e'
// xterm-style 16-colour palette (dark theme).
const BASE16 = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
]
function color256(n: number): string {
  if (n < 16) return BASE16[n]!
  if (n < 232) {
    const v = [0, 95, 135, 175, 215, 255]
    const i = n - 16
    return rgb(v[Math.floor(i / 36)]!, v[Math.floor(i / 6) % 6]!, v[i % 6]!)
  }
  const g = 8 + (n - 232) * 10
  return rgb(g, g, g)
}
const rgb = (r: number, g: number, b: number) => '#' + [r, g, b].map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('')

type Style = { fg: string | null; bg: string | null; bold: boolean; dim: boolean; italic: boolean; underline: boolean; strike: boolean; inverse: boolean }
type Cell = { ch: string; st: Style; wide: boolean }
const plain = (): Style => ({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false })

function applySgr(st: Style, params: number[]): Style {
  const s = { ...st }
  if (params.length === 0) params = [0]
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!
    if (p === 0) Object.assign(s, plain())
    else if (p === 1) s.bold = true
    else if (p === 2) s.dim = true
    else if (p === 3) s.italic = true
    else if (p === 4) s.underline = true
    else if (p === 7) s.inverse = true
    else if (p === 9) s.strike = true
    else if (p === 22) { s.bold = false; s.dim = false }
    else if (p === 23) s.italic = false
    else if (p === 24) s.underline = false
    else if (p === 27) s.inverse = false
    else if (p === 29) s.strike = false
    else if (p >= 30 && p <= 37) s.fg = BASE16[p - 30]!
    else if (p >= 90 && p <= 97) s.fg = BASE16[p - 90 + 8]!
    else if (p >= 40 && p <= 47) s.bg = BASE16[p - 40]!
    else if (p >= 100 && p <= 107) s.bg = BASE16[p - 100 + 8]!
    else if (p === 39) s.fg = null
    else if (p === 49) s.bg = null
    else if (p === 38 || p === 48) {
      let c: string | null = null
      if (params[i + 1] === 5) { c = color256(params[i + 2] ?? 0); i += 2 }
      else if (params[i + 1] === 2) { c = rgb(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0); i += 4 }
      if (p === 38) s.fg = c; else s.bg = c
    }
  }
  return s
}

// Characters a terminal draws two cells wide (CJK, Hangul, fullwidth forms, most emoji).
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u
// Glyphs Claude Code uses that the bundled fonts lack → closest look-alike.
const SUBST: Record<string, string> = { '⏵': '▸', '⏴': '◂', '⏸': '‖', '⏺': '●', '⏹': '■', '⎿': '└', '⏳': '⧗' }
const ZERO = /[̀-ͯ​-‏︀-️]/u

export function parseAnsi(text: string): Cell[][] {
  const rows: Cell[][] = []
  let st = plain()
  for (const line of text.replace(/\n$/, '').split('\n')) {
    const row: Cell[] = []
    const re = /\x1b\[([\d;:]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g
    let last = 0
    const pushText = (s: string) => {
      for (const ch of s) {
        if (ZERO.test(ch) && row.length) { row[row.length - 1]!.ch += ch; continue }
        if (ch < ' ') continue
        const wide = WIDE.test(ch)
        row.push({ ch: SUBST[ch] ?? ch, st, wide })
        if (wide) row.push({ ch: '', st, wide: false }) // placeholder for the 2nd cell
      }
    }
    let m: RegExpExecArray | null
    while ((m = re.exec(line))) {
      pushText(line.slice(last, m.index))
      last = re.lastIndex
      if (m[2] === 'm') st = applySgr(st, m[1] ? m[1].split(/[;:]/).map(x => Number(x) || 0) : [])
    }
    pushText(line.slice(last))
    rows.push(row)
  }
  return rows
}

const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/
const RTL_OR_NEUTRAL = /^[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u200C\u200D\d\s.,:;!?؟،«»()\-]+$|[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/
const cellText = (row: Cell[], a: number, b: number) => row.slice(a, b).map(c => c.ch).join('')
const sameStyle = (a: Style, b: Style) =>
  a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic &&
  a.underline === b.underline && a.strike === b.strike && a.inverse === b.inverse
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const isBlank = (c: Cell) => c.ch === '' || c.ch === ' '
// Rule lines span the full pane width; ignore them when deciding how wide the picture must be.
const isFiller = (c: Cell) => isBlank(c) || /^[─━▔▁═\-]$/.test(c.ch)

/** Crop: drop trailing blank rows, keep the last `maxRows`, cut columns past the last real text. */
export function cropRows(rows: Cell[][], maxRows = 60, minCols = 80): Cell[][] {
  let end = rows.length
  while (end > 0 && rows[end - 1]!.every(isBlank)) end--
  let start = Math.max(0, end - maxRows)
  while (start < end && rows[start]!.every(isBlank)) start++
  const kept = rows.slice(start, end)
  let cols = minCols
  for (const r of kept) {
    let n = r.length
    while (n > 0 && isFiller(r[n - 1]!)) n--
    cols = Math.max(cols, n + 2)
  }
  return kept.map(r => r.slice(0, cols))
}

export function toSvg(rows: Cell[][], fontSize = 15): { svg: string; width: number; height: number } {
  const cw = fontSize * 0.602 // DejaVu Sans Mono advance width
  const lh = Math.round(fontSize * 1.2) // tall enough to read, short enough that box lines join
  const pad = 14
  const cols = Math.max(1, ...rows.map(r => r.length))
  const width = Math.ceil(cols * cw + pad * 2)
  const height = Math.ceil(rows.length * lh + pad * 2)
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="${BG}"/>`,
    `<g font-family="DejaVu Sans Mono, Vazirmatn, DejaVu Sans" font-size="${fontSize}" xml:space="preserve">`,
  ]
  rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const st = row[x]!.st
      let end = x + 1
      while (end < row.length && sameStyle(row[end]!.st, st)) end++
      let fg = st.fg ?? FG, bg = st.bg
      if (st.inverse) { const f = fg; fg = bg ?? BG; bg = f }
      const px = pad + x * cw, py = pad + y * lh
      if (bg) out.push(`<rect x="${px.toFixed(1)}" y="${py}" width="${((end - x) * cw).toFixed(1)}" height="${lh}" fill="${bg}"/>`)
      // One <text> per word-ish chunk, positioned by cell, so proportional glyphs (Persian, symbols) can't drift far.
      let i = x
      while (i < end) {
        while (i < end && isBlank(row[i]!)) i++
        if (i >= end) break
        let j = i
        while (j < end && !(row[j]!.ch === ' ')) j++
        // Right-to-left text (Persian/Arabic/Hebrew): keep the whole phrase in one run so the
        // renderer's bidi puts the words in reading order, as a terminal with bidi would.
        if (RTL.test(cellText(row, i, j))) {
          for (;;) {
            let k = j
            while (k < end && row[k]!.ch === ' ') k++
            let e = k
            while (e < end && row[e]!.ch !== ' ') e++
            if (k >= end || !RTL_OR_NEUTRAL.test(cellText(row, k, e))) break
            j = e
          }
        }
        const txt = row.slice(i, j).map(c => c.ch).join('')
        if (txt) {
          const attrs = [
            `x="${(pad + i * cw).toFixed(1)}"`, `y="${py + Math.round(lh * 0.78)}"`, `fill="${fg}"`,
            st.bold ? 'font-weight="bold"' : '', st.italic ? 'font-style="italic"' : '', st.dim ? 'fill-opacity="0.6"' : '',
            st.underline || st.strike ? `text-decoration="${st.underline ? 'underline' : 'line-through'}"` : '',
          ].filter(Boolean).join(' ')
          out.push(`<text ${attrs}>${xml(txt)}</text>`)
        }
        i = j
      }
      x = end
    }
  })
  out.push('</g></svg>')
  return { svg: out.join('\n'), width, height }
}

export function renderScreen(ansi: string): { png: Buffer; width: number; height: number } {
  const { svg, width, height } = toSvg(cropRows(parseAnsi(ansi)))
  const r = new Resvg(svg, {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans Mono' },
    background: BG,
  })
  return { png: Buffer.from(r.render().asPng()), width, height }
}
