// /diff as an explorer: one row per changed file with +/− counts and a bar. Tap a file to read its
// diff, colored, a page at a time: each page comes in the answer to the tap (≤1 KB), so the card's
// state only holds the file list. Untracked files are shown as new, their whole content as added.
import { execFile } from 'child_process'
import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { page, fit, onCard, sendCard, editCard, editError, setCaption, exclusive } from './kit.ts'
import type { Dest } from '../rich.ts'

export type DiffFile = { path: string; add: number; del: number; flag: '' | 'n' | 'b' } // n = untracked (new), b = binary
export type DiffList = { cwd: string; files: DiffFile[] }

function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise(resolve => execFile('git', args, { cwd, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (err: any, stdout) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout ?? '') })))
}
/** The changed files in `cwd` (against HEAD), or null if it is not a git repository. */
export async function diffList(cwd: string): Promise<DiffList | null> {
  const num = await git(['diff', 'HEAD', '--numstat', '-z'], cwd)
  if (num.code !== 0) {
    // A repository without commits has no HEAD: compare with the empty tree.
    const top = await git(['rev-parse', '--is-inside-work-tree'], cwd)
    if (top.code !== 0) return null
  }
  const files: DiffFile[] = []
  // -z: "add\tdel\tpath\0", renames as "add\tdel\t\0old\0new\0"
  const parts = num.out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]!)
    if (!m) continue
    let path = m[3]!
    if (!path) { const from = parts[++i] ?? '', to = parts[++i] ?? ''; path = `${from} → ${to}` }
    files.push({ path, add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]), flag: m[1] === '-' ? 'b' : '' })
  }
  const un = await git(['ls-files', '--others', '--exclude-standard', '-z'], cwd)
  for (const path of un.out.split('\0').filter(Boolean).slice(0, 200)) {
    let add = 0, flag: DiffFile['flag'] = 'n'
    try {
      const full = join(cwd, path)
      if (statSync(full).size > 2_000_000) flag = 'b'
      else { const b = readFileSync(full); if (b.includes(0)) flag = 'b'; else add = b.toString('utf8').split('\n').length - (b.at(-1) === 10 ? 1 : 0) }
    } catch {}
    files.push({ path, add, del: 0, flag: flag === 'b' ? 'b' : 'n' })
  }
  return { cwd, files }
}

/** A file's diff as pages of at most ~24 lines and ~850 bytes (so a page fits in one answer). */
export async function diffPages(cwd: string, f: DiffFile): Promise<string[]> {
  if (f.flag === 'b') return ['(binary file)']
  const paths = f.path.split(' → ') // a rename: both paths, so git pairs them
  const r = f.flag === 'n'
    ? await git(['diff', '--no-index', '--', '/dev/null', f.path], cwd) // exits 1 when there are differences
    : await git(['diff', 'HEAD', '-M', '--', ...paths], cwd)
  const lines = r.out.replace(/\r/g, '').split('\n')
  const start = lines.findIndex(l => l.startsWith('@@'))
  const body = start < 0 ? [] : lines.slice(start).filter((l, i, a) => i < a.length - 1 || l !== '')
  if (!body.length) return ['(no textual changes)']
  const pages: string[] = []
  let cur: string[] = [], bytes = 0
  for (let l of body) {
    if (l.length > 160) l = l.slice(0, 159) + '…'
    const b = Buffer.byteLength(JSON.stringify(l)) // as it will be escaped in the answer
    if (cur.length && (cur.length >= 24 || bytes + b > 850)) { pages.push(cur.join('\n')); cur = []; bytes = 0 }
    cur.push(l); bytes += b
  }
  if (cur.length) pages.push(cur.join('\n'))
  return pages.slice(0, 99)
}

const short = (cwd: string) => cwd.replace(homedir(), '~')
export function diffState(d: DiffList, note?: string): string {
  const A = d.files.reduce((s, f) => s + f.add, 0), D = d.files.reduce((s, f) => s + f.del, 0)
  return fit(level => {
    const keep = level === 0 ? d.files.length : Math.max(1, Math.floor(d.files.length / (level + 1)))
    let files = d.files.slice(0, keep)
    // Keep under 1 KB: drop files from the end until it fits.
    const build = (fs: DiffFile[]) => ({ u: Date.now(), d: short(d.cwd).slice(-60), A, D, f: fs.map(f => [f.path.length > 70 ? '…' + f.path.slice(-69) : f.path, f.add, f.del, f.flag]), x: d.files.length - fs.length, ...(note ? { s: note } : {}) })
    while (files.length > 1 && Buffer.byteLength(JSON.stringify(build(files))) > 1024) files = files.slice(0, -1)
    return build(files)
  })
}
export const diffCaption = (d: DiffList) => {
  const A = d.files.reduce((s, f) => s + f.add, 0), D = d.files.reduce((s, f) => s + f.del, 0)
  return `📝 ${d.files.length} file${d.files.length === 1 ? '' : 's'} changed · +${A} −${D} · ${short(d.cwd)}`
}
export async function sendDiffCard(dest: Dest, key: string, d: DiffList): Promise<void> {
  await sendCard(dest, 'diff', key, DIFF_HTML, diffState(d), diffCaption(d), { cwd: d.cwd, files: d.files })
}

const pageCache = new Map<string, { at: number; pages: string[] }>()
export function registerDiff(): void {
  onCard('diff', async ({ data, id, card }) => {
    const ex = card.extra as DiffList | undefined
    if (!ex?.cwd) return 'e:This card is too old. Send /diff again.'
    if (data === 'r') {
      void exclusive(id, async () => {
        try {
          const d = await diffList(ex.cwd)
          if (!d) throw new Error(`Not a git repository any more: ${ex.cwd}`)
          card.extra = { cwd: d.cwd, files: d.files }
          for (const k of pageCache.keys()) if (k.startsWith(id + '|')) pageCache.delete(k)
          await editCard(id, diffState(d, d.files.length ? undefined : 'No uncommitted changes.'))
          await setCaption(id, diffCaption(d))
        } catch (e) { await editError(id, e instanceof Error ? e.message : String(e)) }
      })
      return
    }
    const m = /^f:(\d+):(\d+)$/.exec(data)
    if (!m) return 'e:Unknown request.'
    const f = ex.files[Number(m[1])]
    if (!f) return 'e:That file is not in the list any more. Tap ↻.'
    const ck = `${id}|${f.path}`
    let c = pageCache.get(ck)
    if (!c || Date.now() - c.at > 60_000) { c = { at: Date.now(), pages: await diffPages(ex.cwd, f) }; pageCache.set(ck, c) }
    if (pageCache.size > 50) pageCache.delete(pageCache.keys().next().value!)
    const p = Math.min(Number(m[2]), c.pages.length - 1)
    return JSON.stringify({ p, n: c.pages.length, t: c.pages[p] })
  })
}

export const DIFF_HTML = page(`.tot{font-variant-numeric:tabular-nums}.ad{color:#2ea043}.dl{color:var(--tg-theme-destructive-text-color)}
.rw{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:5px 8px;margin-top:4px;border-radius:10px;font-size:.9em}
.rw .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rw .nm i{font-style:normal;color:var(--tg-theme-hint-color)}
.rw .cn{font-variant-numeric:tabular-nums;font-size:.85em;flex:none}
.br{display:flex;width:40px;height:6px;border-radius:3px;overflow:hidden;background:var(--tg-theme-secondary-bg-color);flex:none}
.br b{background:#2ea043}.br s{background:var(--tg-theme-destructive-text-color)}
.tg{font-size:.7em;padding:0 5px;border-radius:6px;background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-hint-color)}
pre{margin:8px 0 0;font:11px/1.35 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all}
pre .a{color:#2ea043}pre .d{color:var(--tg-theme-destructive-text-color)}pre .k{color:var(--tg-theme-accent-text-color)}
.pg{display:flex;align-items:center;gap:8px;margin-top:8px}.pg span{flex:1;text-align:center}`,
`<div class="h"><b id="hd">📝 Changes</b><button id="rb" onclick="req('r',null,1)"><span class="sp">↻</span></button></div><div id="v"></div>`,
`var st=null,vw=null,lp=0,PER=8;
function nm(p){var i=p.lastIndexOf('/');return i<0?'<b>'+esc(p)+'</b>':'<i>'+esc(p.slice(0,i+1))+'</i><b>'+esc(p.slice(i+1))+'</b>'}
function cnt(a,d){return'<span class="ad">+'+a+'</span> <span class="dl">−'+d+'</span>'}
function fopen(i,p){req('f:'+i+':'+p,function(r){var d=JSON.parse(r);vw={i:i,p:d.p,n:d.n,t:d.t}})}
function render(){var h='';
if(!st)h='<div class="mu">'+(W.isForward?'Open the bot and send /diff.':'Loading…')+'</div>';
else if(vw){var f=st.f[vw.i];
h+='<div class="pg"><button onclick="vw=null;render()">‹ Files</button><span class="mu">'+(vw.n>1?'page '+(vw.p+1)+'/'+vw.n:'')+'</span>'+(vw.n>1?'<button onclick="fopen('+vw.i+','+(vw.p-1)+')"'+(vw.p<1||busy?' disabled':'')+'>‹</button><button onclick="fopen('+vw.i+','+(vw.p+1)+')"'+(vw.p>=vw.n-1||busy?' disabled':'')+'>›</button>':'')+'</div>';
h+='<div style="margin-top:6px">'+nm(f[0])+' <span class="cn">'+cnt(f[1],f[2])+'</span></div><pre>';
vw.t.split('\\n').forEach(function(l){var c=l[0]=='+'?'a':l[0]=='-'?'d':l.slice(0,2)=='@@'?'k':'';h+=(c?'<span class="'+c+'">':'<span>')+esc(l)+'</span>\\n'});h+='</pre>'}
else{
h+='<div class="mu">📁 '+esc(st.d)+'</div><div class="tot" style="margin-top:2px">'+st.f.length+(st.x?'+'+st.x:'')+' file'+(st.f.length+st.x==1?'':'s')+' · '+cnt(st.A,st.D)+'</div>';
if(!st.f.length)h+='<div class="mu" style="margin-top:8px">No uncommitted changes.</div>';
var mx=1;st.f.forEach(function(f){mx=Math.max(mx,f[1]+f[2])});
var pages=Math.ceil(st.f.length/PER);lp=Math.min(lp,Math.max(0,pages-1));
st.f.slice(lp*PER,lp*PER+PER).forEach(function(f,j){var i=lp*PER+j,t=f[1]+f[2],w=Math.max(4,Math.round(40*t/mx));
h+='<button class="rw" onclick="fopen('+i+',0)"'+(busy?' disabled':'')+'><span class="nm">'+nm(f[0])+'</span>'+(f[3]=='n'?'<span class="tg">new</span>':f[3]=='b'?'<span class="tg">bin</span>':'')+'<span class="cn">'+cnt(f[1],f[2])+'</span><span class="br" style="width:'+w+'px"><b style="flex:'+f[1]+'"></b><s style="flex:'+f[2]+'"></s></span></button>'});
if(pages>1)h+='<div class="pg"><button onclick="lp--;render()"'+(lp<1?' disabled':'')+'>‹</button><span class="mu">'+(lp+1)+'/'+pages+'</span><button onclick="lp++;render()"'+(lp>=pages-1?' disabled':'')+'>›</button></div>';
if(st.x)h+='<div class="mu" style="margin-top:6px">+'+st.x+' more (see /legacy_diff)</div>';
if(st.s)h+='<div class="nt">'+esc(st.s)+'</div>'}
if(err)h+='<div class="e">⚠️ '+esc(err)+'</div>';
document.getElementById('v').innerHTML=h;
var b=document.getElementById('rb');b.disabled=!!busy||W.isForward;b.className=busy?'busy':''}
function load(){var d=J();if(d){if(d.f)st=d;err=d.e||''}}
W.onEvent('chatDataChanged',function(){vw=null;load();done()});
load();render();`)
