// /usage as a Telegram widget (Bot API 10.4): a small HTML card drawn inside the message, with a
// refresh button. The HTML is fixed when sent; what changes is its chat state (chat_data, ≤1024
// bytes of JSON), which the bot rewrites with editMessageWidgetData. See core.telegram.org/bots/widgets.

export type QuotaLimit = { name: string; pct: number; resetsIn?: number } // resetsIn: seconds
export type QuotaGroup = { name: string; models: string; limits: QuotaLimit[] }
export type Quota = { account?: string; groups: QuotaGroup[] }

const secs = (s: string) => {
  const d = /(\d+)\s*d/.exec(s), h = /(\d+)\s*h/.exec(s), m = /(\d+)\s*m/.exec(s)
  return (Number(d?.[1] ?? 0) * 24 + Number(h?.[1] ?? 0)) * 3600 + Number(m?.[1] ?? 0) * 60
}

/** Parse agy's /usage screen ("GEMINI MODELS … Weekly Limit Remaining … [███░] 98.66% … Refreshes in 158h 41m"). */
export function parseQuota(text: string): Quota | null {
  const groups: QuotaGroup[] = []
  let limit = ''
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    if (/^[A-Z][A-Z &]+$/.test(l)) { groups.push({ name: l.replace(/\s*\bMODELS\b\s*/, ' ').trim(), models: '', limits: [] }); continue }
    const g = groups.at(-1)
    if (!g) continue
    const models = /^Models within this group:\s*(.+)$/.exec(l)
    if (models) { g.models = models[1]!; continue }
    if (/Limit Remaining$/.test(l)) { limit = l.replace(/ Limit Remaining$/, ''); continue }
    const pct = /\]\s*([\d.]+)%/.exec(l)
    if (pct && limit) { g.limits.push({ name: limit, pct: Number(pct[1]) }); continue }
    const lim = g.limits.at(-1)
    if (lim && /^Refreshes in/.test(l)) lim.resetsIn = secs(l)
  }
  const out = groups.filter(g => g.limits.length)
  if (!out.length) return null
  return { account: /Account:\s*(\S+)/.exec(text)?.[1], groups: out }
}

const pretty = (g: string) => g.split(' ').map(w => w === 'AND' ? '&' : w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase()).join(' ')
const fmtIn = (s: number) => s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.max(0, Math.round(s / 60))}m`

/** The old /usage: a rich-text table. */
export function quotaMd(q: Quota, tokens?: string): string {
  const rows = q.groups.flatMap(g => g.limits.map(l => `| ${pretty(g.name)} | ${l.name} | **${l.pct}%** left | ${l.resetsIn != null ? fmtIn(l.resetsIn) : ''} |`))
  return [`## 📊 agy quota${q.account ? ` · ${q.account}` : ''}`, '', '| Models | Limit | Remaining | Refreshes |', '|:--|:--|:--|:--|', ...rows, '',
    `_Each group shares a weekly and a 5-hour limit.${tokens ? ` This run: ${tokens}.` : ''}_`].join('\n')
}

/** One line per group, for the widget's caption (what old apps, the chat list and notifications show). */
export function quotaCaption(q: Quota): string {
  const p = (n: number) => n >= 10 ? Math.round(n) : n.toFixed(1)
  return '📊 agy quota · ' + q.groups.map(g => `${pretty(g.name)}: ${[...g.limits].reverse().map(l => `${l.name === 'Five Hour' ? '5h' : l.name.toLowerCase()} ${p(l.pct)}%`).join(', ')}`).join(' · ')
}

/** The widget's chat state. Short keys: it must stay under 1024 bytes. */
export function widgetState(q: Quota, tokens?: [number, number, number], error?: string): string {
  const fit = (n: number) => {
    const d = {
      t: Math.floor(Date.now() / 1000),
      ...(q.account ? { a: q.account } : {}),
      g: q.groups.map(g => ({ n: pretty(g.name), m: g.models.slice(0, n), l: g.limits.map(l => [l.name === 'Five Hour' ? '5-hour' : l.name, l.pct, l.resetsIn ?? -1]) })),
      ...(tokens ? { k: tokens } : {}),
      ...(error ? { e: error.slice(0, 120) } : {}),
    }
    return JSON.stringify(d)
  }
  let s = fit(80)
  if (Buffer.byteLength(s) > 1024) s = fit(0)
  return s
}
export const errorState = (msg: string) => JSON.stringify({ e: msg.slice(0, 200) })

// The widget itself. Keep it small: ≤4096 bytes after zlib -9 (checked in sendUsageWidget's caller
// by Telegram; `bun src/widget.ts` prints the size). Colors come from the chat theme.
export const USAGE_HTML = `<style>
body{margin:0;padding:10px 12px max(10px,env(safe-area-inset-bottom));font:14px/1.35 system-ui,sans-serif}
.h{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.h b{font-size:1.05em;flex:1}
.mu{color:var(--tg-theme-hint-color);font-size:.82em}
button{padding:4px 10px;font-size:.85em;border-radius:14px;flex:none}
.sp{display:inline-block}.busy .sp{animation:r 1s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
.g{margin-top:10px}
.gn{font-weight:600}
.pies{display:flex;gap:10px;margin-top:6px}
.c{flex:1;display:flex;align-items:center;gap:8px;min-width:0}
.pie{position:relative;width:64px;height:64px;border-radius:50%;flex:none;background:conic-gradient(var(--k) calc(var(--p)*1%),var(--tg-theme-secondary-bg-color) 0)}
.in{position:absolute;top:7px;left:7px;right:7px;bottom:7px;border-radius:50%;background:var(--tg-theme-bg-color);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;line-height:1.1;font-size:.72em;font-variant-numeric:tabular-nums}
.in b{font-size:1.15em}
.ok{--k:var(--tg-theme-button-color)}.mid{--k:light-dark(#c77c00,#f0a830)}.low{--k:var(--tg-theme-destructive-text-color)}
.p{font-variant-numeric:tabular-nums;font-weight:600;font-size:1.15em}
.e{color:var(--tg-theme-destructive-text-color);font-size:.85em;margin-top:8px}
.f{margin-top:10px;padding-top:6px;border-top:1px solid var(--tg-theme-section-separator-color)}
</style>
<div class="h"><b>📊 agy quota</b><button id="rb" onclick="refresh()"><span class="sp">↻</span> Refresh</button></div>
<div id="v"></div>
<script>
var W=window.TelegramWidget,st=null,err='',busy=0,bt=0;
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return'&#'+c.charCodeAt(0)+';'})}
function dur(s){if(s<0)return'';s=Math.max(0,s);var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?d+'d '+h+'h':h?h+'h '+m+'m':m+'m'}
function n(x){return x>=1e6?(x/1e6).toFixed(1)+'M':x>=1e4?Math.round(x/1e3)+'k':x>=1e3?(x/1e3).toFixed(1)+'k':''+x}
function load(){var d=null;try{d=JSON.parse(W.chatData)}catch(e){}if(!d)return;if(d.g)st=d;err=d.e||''}
function render(){
var h='',now=Date.now()/1e3;
if(!st)h='<div class="mu">'+(W.isForward?'Open the bot and send /usage.':'No data yet. Tap Refresh.')+'</div>';
else{
var el=now-st.t;
if(st.a)h+='<div class="mu">'+esc(st.a)+'</div>';
st.g.forEach(function(g){
h+='<div class="g"><div class="gn">'+esc(g.n)+'</div>'+(g.m?'<div class="mu">'+esc(g.m)+'</div>':'')+'<div class="pies">';
g.l.slice().reverse().forEach(function(l){
var p=l[1],c=p<20?'low':p<50?'mid':'ok';
h+='<div class="c"><div class="pie '+c+'" style="--p:'+Math.max(0,Math.min(100,p))+'"><div class="in">'+(l[2]>=0?'<span class="mu">resets</span><b>'+dur(l[2]-el)+'</b>':'<b>—</b>')+'</div></div><div><div class="mu">'+esc(l[0])+'</div><div class="p">'+(p>=10?Math.round(p):p.toFixed(1))+'%</div><div class="mu">left</div></div></div>'});
h+='</div>';
h+='</div>'});
var a=el<90?'just now':el<5400?Math.round(el/60)+' min ago':Math.round(el/3600)+' h ago';
h+='<div class="f mu">'+(st.k?'This run: '+n(st.k[0])+' in · '+n(st.k[1])+' out · '+st.k[2]+' turns<br>':'')+'Updated '+a+'</div>'}
if(err)h+='<div class="e">⚠️ '+esc(err)+'</div>';
document.getElementById('v').innerHTML=h;
var b=document.getElementById('rb');b.disabled=!!busy||W.isForward;b.className=busy?'busy':'';
b.lastChild.nodeValue=busy?' Refreshing…':' Refresh'}
function done(e){busy=0;clearTimeout(bt);if(e!=null)err=e;render()}
function refresh(){
if(busy)return;busy=1;err='';render();
bt=setTimeout(function(){done('No answer from the bot.')},90000);
W.request('r').then(function(a){var r=a.result||'';if(r.indexOf('e:')==0)done(r.slice(2))},function(e){done({RATE_LIMITED:'Too many taps, wait a few seconds.',TIMEOUT:'The bot did not answer.',NOT_ALLOWED:'Refresh is not available here.'}[e.code]||'Request failed ('+e.code+').')})}
if(!W)W={chatData:null,isForward:false,onEvent:function(){},request:function(){return Promise.reject({code:'NOT_ALLOWED'})}};
W.onEvent('chatDataChanged',function(){load();done()});
load();render();setInterval(render,30000);
</script>`

if (import.meta.main) {
  const { deflateSync } = await import('zlib')
  console.log(`USAGE_HTML: ${Buffer.byteLength(USAGE_HTML)} bytes, ${deflateSync(USAGE_HTML, { level: 9 }).length} compressed (limit 4096; Python's zlib is exact)`)
}
