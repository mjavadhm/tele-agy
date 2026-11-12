// The live run card (/live widget): one silent card per turn instead of the streaming draft. It shows
// what agy is doing (thinking / working / writing, the current step, counters, plan progress, the last
// steps) with the elapsed time ticking inside the card, and a Stop button. The session rewrites its
// state at most every few seconds; at the end it turns into "✓ Done in 42s · 7 steps".
import { page, fit, onCard } from './kit.ts'
import type { SessionManager } from '../session.ts'

/** Icons for agy's tool kinds (also used by the text steps in session.ts). */
export const KIND_ICON: Record<string, string> = {
  execute: '⚙️', read: '📄', edit: '✏️', delete: '🗑', move: '📦', search: '🔍', fetch: '🌐', think: '💭', other: '🔧',
}
type StepLike = { label: string; kind: string; status: string }
type PlanLike = { content: string; status: string }
export type LiveStatus = 'think' | 'work' | 'write' | 'done' | 'stop' | 'err'
export type LiveInput = {
  started: number // ms
  status: LiveStatus
  model: string
  steps: StepLike[]
  plan: PlanLike[]
  secs?: number // when finished
  tokens?: [number, number] // this turn, when finished
  note?: string
}
const clip = (s: string, n: number) => { s = s.replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n - 1) + '…' }
const finished = (s: StepLike) => s.status === 'completed' || s.status === 'failed'

export function liveState(x: LiveInput): string {
  const { steps, plan } = x
  const open = [...steps].reverse().find(s => !finished(s))
  const running = x.status === 'think' || x.status === 'work' || x.status === 'write'
  const now = plan.find(p => p.status === 'in_progress')
  return fit(level => ({
    t0: Math.floor(x.started / 1000),
    s: x.status,
    ...(x.model ? { m: clip(x.model, 40) } : {}),
    n: [steps.length, steps.filter(s => s.kind === 'edit').length, steps.filter(s => s.kind === 'execute').length],
    ...(plan.length ? { p: [plan.filter(p => p.status === 'completed').length, plan.length], ...(now && level < 2 ? { pc: clip(now.content, 70 - level * 20) } : {}) } : {}),
    ...(running && open ? { c: [KIND_ICON[open.kind] ?? '🔧', clip(open.label, 80 - level * 20)] } : {}),
    l: steps.slice(-(3 - Math.min(level, 2))).map(s => [KIND_ICON[s.kind] ?? '🔧', clip(s.label, 56 - level * 14), s.status === 'failed' ? 'x' : finished(s) ? 'v' : 'r']),
    ...(x.secs != null ? { d: x.secs } : {}),
    ...(x.tokens ? { k: x.tokens } : {}),
    ...(x.note ? { e: clip(x.note, 120) } : {}),
  }))
}

export const LIVE_HTML = page(`.h b{font-variant-numeric:tabular-nums}
.cs{margin-top:6px;display:flex;gap:6px;align-items:baseline}.cs b{font-weight:500;min-width:0;overflow-wrap:anywhere}
.ct{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.ct span{background:var(--tg-theme-secondary-bg-color);border-radius:10px;padding:2px 8px;font-size:.82em;font-variant-numeric:tabular-nums}
.pb{height:6px;border-radius:3px;background:var(--tg-theme-secondary-bg-color);overflow:hidden;margin-top:8px}
.pb i{display:block;height:100%;border-radius:3px;background:var(--tg-theme-button-color)}
.ls{margin-top:8px}.ls div{display:flex;gap:6px;font-size:.85em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ls .x{color:var(--tg-theme-destructive-text-color)}
.ok{color:var(--tg-theme-accent-text-color)}`,
`<div class="h"><b id="hd"></b><button id="sb" onclick="stop()">■ Stop</button></div><div id="v"></div>`,
`var st=null,T={think:'💭 Thinking',work:'⏳ Working',write:'✍️ Writing',done:'✓ Done',stop:'⏹ Stopped',err:'⚠️ Stopped'};
function live(){return st&&(st.s=='think'||st.s=='work'||st.s=='write')}
function head(){var e=document.getElementById('hd');if(!st){e.textContent='agy';return}
e.textContent=T[st.s]+(live()?'… '+secs(Date.now()/1e3-st.t0):' in '+secs(st.d||0))}
function render(){var h='';
if(!st)h='<div class="mu">'+(W.isForward?'A run of agy.':'Starting…')+'</div>';
else{
if(st.m)h+='<div class="mu">'+esc(st.m)+'</div>';
if(st.c)h+='<div class="cs"><span>'+st.c[0]+'</span><b>'+esc(st.c[1])+'</b></div>';
h+='<div class="ct"><span>🔧 '+st.n[0]+' tool'+(st.n[0]==1?'':'s')+'</span><span>✏️ '+st.n[1]+' edit'+(st.n[1]==1?'':'s')+'</span><span>⚙️ '+st.n[2]+' command'+(st.n[2]==1?'':'s')+'</span>'+(st.k?'<span>'+n(st.k[0])+' in · '+n(st.k[1])+' out</span>':'')+'</div>';
if(st.p)h+='<div class="pb"><i style="width:'+Math.round(100*st.p[0]/Math.max(1,st.p[1]))+'%"></i></div><div class="mu">Plan '+st.p[0]+'/'+st.p[1]+(st.pc?' · '+esc(st.pc):'')+'</div>';
if(st.l.length){h+='<div class="ls">';st.l.forEach(function(l){h+='<div class="'+(l[2]=='x'?'x':'mu')+'"><span>'+(l[2]=='v'?'✓':l[2]=='x'?'✗':'▸')+'</span><span>'+l[0]+'</span><span>'+esc(l[1])+'</span></div>'});h+='</div>'}
if(!live()&&st.s=='done')h+='<div class="nt ok">Reply below ↓</div>'}
if(st&&st.e)h+='<div class="e">'+esc(st.e)+'</div>';
if(err)h+='<div class="e">⚠️ '+esc(err)+'</div>';
document.getElementById('v').innerHTML=h;head();
var b=document.getElementById('sb');b.hidden=!live()||W.isForward;b.disabled=!!busy;b.textContent=busy?'Stopping…':'■ Stop'}
function stop(){req('s',null,1)}
W.onEvent('chatDataChanged',function(){st=J()||st;done()});
st=J();render();setInterval(function(){if(live())head()},1000);`)

export function registerLive(mgr: SessionManager): void {
  onCard('live', async ({ data, card }) => {
    if (data !== 's') return 'e:Unknown request.'
    const s = mgr.get(card.key)
    if (!s.turn || s.turn.started !== card.extra?.started) return 'e:Already finished.'
    void s.cancel()
  })
}
