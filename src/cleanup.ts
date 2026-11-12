// /cleanup: delete files the bot saved (things users sent, and files it made to send back).
import { readdirSync, statSync, rmSync } from 'fs'
import { join } from 'path'

export type Found = { path: string; size: number; mtime: number }
export function scan(dirs: string[]): Found[] {
  const out: Found[] = []
  for (const d of dirs) {
    let names: string[] = []
    try { names = readdirSync(d) } catch { continue }
    for (const n of names) {
      try { const st = statSync(join(d, n)); if (st.isFile()) out.push({ path: join(d, n), size: st.size, mtime: st.mtimeMs }) } catch {}
    }
  }
  return out
}
export const older = (f: Found[], days: number) => f.filter(x => Date.now() - x.mtime > days * 86_400_000)
export const totalSize = (f: Found[]) => f.reduce((a, x) => a + x.size, 0)
export function human(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`
}
export function remove(f: Found[]): { count: number; bytes: number } {
  let count = 0, bytes = 0
  for (const x of f) { try { rmSync(x.path); count++; bytes += x.size } catch {} }
  return { count, bytes }
}
export function summary(dirs: string[]): string {
  const all = scan(dirs)
  if (!all.length) return '🧹 Nothing to clean: no saved files.'
  const old = older(all, 7)
  const oldest = Math.round((Date.now() - Math.min(...all.map(x => x.mtime))) / 86_400_000)
  return `🧹 Saved files (what people sent, and files the bot made to send back):\n${all.length} files, ${human(totalSize(all))}, oldest ${oldest} day${oldest === 1 ? '' : 's'} old.\nOlder than 7 days: ${old.length} files, ${human(totalSize(old))}.\n\nFiles copied into a project are not touched.`
}
