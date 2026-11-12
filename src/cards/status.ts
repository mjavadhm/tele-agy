// /status as a control panel: agy's state, folder, chat, and chips to change the model, thinking level,
// agent mode, tool permission and live mode with a tap. A mini ring shows the quota of this chat's
// model group from the last reading (no agy terminal is started for it). The card refreshes itself
// when it comes on screen.
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { page, fit, onCard, sendCard, editCard, editError, exclusive } from './kit.ts'
import { latestQuota, groupOf } from './usage.ts'
import { PERMISSIONS, type SessionManager, type AgentSession } from '../session.ts'
import { saveAccount } from '../store.ts'
import type { Dest } from '../rich.ts'

const clip = (s: string, n: number) => { s = s.replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n - 1) + '…' }
const clipLeft = (s: string, n: number) => s.length <= n ? s : '…' + s.slice(-(n - 1))
const LIVE = ['off', 'on', 'widget'] as const
const liveOf = (v: boolean | 'widget' | undefined) => v === false ? 'off' : v === 'widget' ? 'widget' : 'on'
function rssMb(pid?: number): number | undefined {
  if (!pid) return undefined
  try { return Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]) / 1024) || undefined } catch { return undefined }
}

let mgr: SessionManager
export function statusState(s: AgentSession, note?: string): string {
  const st = s.state
  const lq = latestQuota()
  const g = lq ? lq.q.groups[groupOf(lq.q, s.modelName)] : undefined
  const pct = (name: string) => g?.limits.find(l => l.name === name)?.pct ?? -1
  return fit(level => ({
    u: Date.now(),
    a: s.busy ? 'work' : s.running ? 'idle' : 'stop',
    ...(s.running ? { mb: rssMb(s.acp?.pid) } : {}),
    f: clipLeft((s.cwd || st.cwd).replace(homedir(), '~'), 60 - level * 15),
    c: clip(s.title || (st.sessionId ? st.sessionId.slice(0, 8) : '(new chat)'), 60 - level * 20),
    m: clip(s.modelName, 40),
    th: s.configName('thought_level') || st.thought || 'default',
    md: s.configName('mode') || st.mode || 'Default',
    pm: Math.max(0, PERMISSIONS.findIndex(p => p.value === (st.permission ?? 'request-review'))),
    lv: liveOf(st.live),
    k: [s.tokens.input, s.tokens.output, s.tokens.turns],
    ...(g ? { q: [g.name.split(' ').map(w => w === 'AND' ? '&' : w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase()).join(' '), pct('Five Hour'), pct('Weekly'), Math.round((Date.now() / 1000 - lq!.t) / 60)] } : {}),
    ...(note ? { s: clip(note, 100) } : {}),
  }))
}
export async function sendStatusCard(dest: Dest, s: AgentSession): Promise<void> {
  await sendCard(dest, 'status', s.key, STATUS_HTML, statusState(s), `📊 ${s.modelName} · ${clipLeft(s.cwd || s.state.cwd, 60)}`)
}
const same = (a: string, b: string) => a.replace(/"u":\d+,?/, '') === b.replace(/"u":\d+,?/, '')
/** Start agy if needed, but give up after `ms` (a query must be answered within 15 s). */
async function ensureWithin(s: AgentSession, ms: number): Promise<boolean> {
  if (s.running && s.config.length) return true
  return Promise.race([s.ensure().then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), ms))])
}
async function cycle(s: AgentSession, id: string, title: string): Promise<string> {
  await s.ensure()
  const c = s.config.find(x => x.id === id)
  if (!c?.options.length) throw new Error(`agy did not report a ${title} setting.`)
  const o = c.options[(c.options.findIndex(x => x.value === c.currentValue) + 1) % c.options.length]!
  await s.setConfig(id, o.value)
  return `${title}: ${o.name}`
}

export function registerStatus(m: SessionManager): void {
  mgr = m
  onCard('status', async ({ data, id, card }) => {
    const s = mgr.get(card.key)
    if (data === 'b') { // in the background, when the card comes on screen: rewrite only if something changed
      const st = statusState(s)
      if (!same(st, card.state)) void editCard(id, st).catch(() => {})
      return
    }
    if (data === 'lm') { // the model picker's list, in the answer
      if (!await ensureWithin(s, 11_000)) return 'e:agy is starting. Tap again in a moment.'
      const c = s.config.find(x => x.id === 'model')
      if (!c?.options.length) return 'e:agy did not report any models.'
      const cur = c.options.findIndex(o => o.value === c.currentValue)
      for (const n of [36, 24, 16]) {
        const r = JSON.stringify({ c: cur, o: c.options.map(o => clip(o.name, n)) })
        if (Buffer.byteLength(r) <= 1024) return r
      }
      return 'e:Too many models to list here. Use /model.'
    }
    let job: (() => Promise<string | undefined>) | null = null
    let mm: RegExpExecArray | null
    if (data === 'r') job = async () => undefined
    else if (data === 'ct') job = () => cycle(s, 'thought_level', 'Thinking')
    else if (data === 'cm') job = () => cycle(s, 'mode', 'Mode')
    else if ((mm = /^sm:(\d+)$/.exec(data))) job = async () => {
      await s.ensure()
      const o = s.config.find(x => x.id === 'model')?.options[Number(mm![1])]
      if (!o) throw new Error('That model is gone. Open the list again.')
      await s.setConfig('model', o.value)
      return `Model: ${o.name}`
    }
    else if ((mm = /^sp:(\d)$/.exec(data))) job = async () => {
      const p = PERMISSIONS[Number(mm![1])]
      if (!p) throw new Error('Unknown option.')
      if ((s.state.permission ?? 'request-review') === p.value) return `Already: ${p.label}`
      if (s.busy) throw new Error('agy is working. Stop it first.')
      saveAccount(s.key, { permission: p.value })
      if (s.running) await s.restart() // agy reads it when it starts
      return `Tool permission: ${p.label}`
    }
    else if ((mm = /^sl:(off|on|widget)$/.exec(data))) job = async () => {
      const v = mm![1] as typeof LIVE[number]
      saveAccount(s.key, { live: v === 'off' ? false : v === 'on' ? true : 'widget' })
      return `Live progress: ${v === 'off' ? 'off (final reply only)' : v === 'on' ? 'on (streaming text)' : 'widget (live run card)'}`
    }
    if (!job) return 'e:Unknown request.'
    const run = job
    // Answered now; the change is made, then the card's state is rewritten (the card waits for that).
    void exclusive(id, async () => {
      try { await editCard(id, statusState(s, await run())) } catch (e) { await editError(id, e instanceof Error ? e.message : String(e)) }
    })
  })
}

export const STATUS_HTML = page(`.st{display:flex;align-items:center;gap:6px}.dot{width:8px;height:8px;border-radius:50%;background:var(--tg-theme-hint-color)}
.dot.idle{background:#3bb54a}.dot.work{background:light-dark(#c77c00,#f0a830)}
.fo{overflow-wrap:anywhere;margin-top:2px}
.gr{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px}
.gr button,.pk button{display:block;width:100%;text-align:left;padding:6px 10px;border-radius:10px;font-size:1em}
.gr button span{display:block;font-size:.75em;opacity:.75}.gr button b{display:block;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lv{display:flex;gap:4px;margin-top:8px;align-items:center}.lv button{flex:1;border-radius:10px;padding:5px 0}
.lv button.on{background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color)}
.lv button.of{background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-text-color)}
.pk{margin-top:8px;display:flex;flex-direction:column;gap:4px}.pk button.on{font-weight:600}
.q{display:flex;align-items:center;gap:8px;margin-top:10px}.q svg{width:36px;height:36px;flex:none}
.q circle{fill:none;stroke-width:5}.q .t{stroke:var(--tg-theme-secondary-bg-color)}.q .a{stroke-linecap:round}`,
`<div class="h"><b>⚙️ agy</b><button id="rb" onclick="req('r',null,1)"><span class="sp">↻</span></button></div><div id="v"></div>`,
`var st=null,pk=null,PM=['🛡 Ask me','⚡ Turbo','📦 Sandbox','🔒 Strict'],LV=['off','on','widget'],LN={off:'Off',on:'Text',widget:'Card'};
function col(p){return p<20?'var(--tg-theme-destructive-text-color)':p<50?'light-dark(#c77c00,#f0a830)':'var(--tg-theme-button-color)'}
function ring(p){return'<svg viewBox="0 0 36 36"><circle class="t" cx="18" cy="18" r="15"/>'+(p>0?'<circle class="a" cx="18" cy="18" r="15" transform="rotate(-90 18 18)" style="stroke:'+col(p)+';stroke-dasharray:'+Math.max(.01,Math.min(100,p)*.9425-5).toFixed(2)+' 200;stroke-dashoffset:-2.5"/>':'')+'</svg>'}
function pc(p){return p<0?'?':(p>=10?Math.round(p):p.toFixed(1))+'%'}
function chip(l,v,f){return'<button onclick="'+f+'"'+(busy?' disabled':'')+'><span>'+l+'</span><b>'+esc(v)+'</b></button>'}
function render(){var h='';
if(!st)h='<div class="mu">'+(W.isForward?'Open the bot and send /status.':'Loading…')+'</div>';
else{
h+='<div class="st"><i class="dot '+st.a+'"></i><span>'+{work:'Working',idle:'Idle',stop:'Stopped (starts on your next message)'}[st.a]+'</span>'+(st.mb?'<span class="mu">· '+st.mb+' MB</span>':'')+'</div>';
h+='<div class="mu fo">📁 '+esc(st.f)+'</div><div class="mu fo">💬 '+esc(st.c)+'</div>';
if(pk){h+='<div class="pk"><div class="mu">'+(pk.t=='m'?'Model':'Tool permission')+'</div>';pk.o.forEach(function(o,i){h+='<button class="'+(i==pk.c?'on':'')+'" onclick="pick('+i+')">'+(i==pk.c?'• ':'')+esc(o)+'</button>'});h+='<button onclick="pk=null;render()">Cancel</button></div>'}
else{
h+='<div class="gr">'+chip('Model ▾',st.m,'models()')+chip('Thinking ↻',st.th,"req('ct',null,1)")+chip('Mode ↻',st.md,"req('cm',null,1)")+chip('Tools ▾',PM[st.pm],'perms()')+'</div>';
h+='<div class="lv"><span class="mu">Live</span>';LV.forEach(function(l){h+='<button class="'+(st.lv==l?'on':'of')+'" onclick="req(\\'sl:'+l+'\\',null,1)"'+(busy?' disabled':'')+'>'+LN[l]+'</button>'});h+='</div>'}
if(st.q)h+='<div class="q">'+ring(st.q[1])+'<div><div>'+esc(st.q[0])+'</div><div class="mu">5h '+pc(st.q[1])+' · week '+pc(st.q[2])+(st.q[3]>2?' · '+dur(st.q[3]*60)+' ago':'')+'</div></div></div>';
h+='<div class="f mu">This run: '+n(st.k[0])+' in · '+n(st.k[1])+' out · '+st.k[2]+' turns</div>';
if(st.s)h+='<div class="nt">✓ '+esc(st.s)+'</div>'}
if(err)h+='<div class="e">⚠️ '+esc(err)+'</div>';
document.getElementById('v').innerHTML=h;
var b=document.getElementById('rb');b.disabled=!!busy||W.isForward;b.className=busy?'busy':''}
function models(){req('lm',function(r){var d=JSON.parse(r);pk={t:'m',o:d.o,c:d.c}})}
function perms(){pk={t:'p',o:PM,c:st.pm};render()}
function pick(i){var t=pk.t;pk=null;req((t=='m'?'sm:':'sp:')+i,null,1)}
function load(){var d=J();if(d){if(d.a)st=d;err=d.e||''}}
W.onEvent('chatDataChanged',function(){load();done()});
W.onEvent('activated',function(){bg('b')});
load();render();bg('b');`)
