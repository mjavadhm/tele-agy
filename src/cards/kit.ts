// Telegram widgets (Bot API 10.4): small HTML cards drawn inside a message. A card's HTML is fixed when
// it is sent; what changes is its chat state (chat_data, ≤1024 bytes), which the bot rewrites with
// editMessageWidgetData. Taps arrive as widget_query updates, answered within 15 s with ≤1024 bytes.
// See core.telegram.org/bots/widgets. This module holds what every card shares: the registry of sent
// cards, sending and editing, the query router, and the CSS/JS each card's page starts with.
import type { Bot } from 'grammy'
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { deflateSync } from 'zlib'
import { DATA } from '../store.ts'
import { patient, threadOpt, type Dest } from '../rich.ts'

export type CardKind = 'usage' | 'status' | 'live' | 'diff'
/** A sent card. `key` is the session (account or account:topic) it belongs to; `extra` is server-side data. */
export type Card = { kind: CardKind; key: string; state: string; caption?: string; extra?: any; running?: boolean }
export type CardQuery = { qid: string; data: string; from: string; id: string; card: Card }
/** Returns the answer's data (≤1024 bytes; "e:…" is shown as an error), or nothing. Must finish well within 15 s. */
type Handler = (q: CardQuery) => Promise<string | void>

const FILE = join(DATA, 'cards.json')
const MAX_KEPT = 300
const log = (...a: unknown[]) => console.error(new Date().toISOString(), ...a)
let bot: Bot
export function initCards(b: Bot): void { bot = b }
const raw = () => bot.api.raw as any

function load(): [string, Card][] {
  try { return Object.entries(JSON.parse(readFileSync(FILE, 'utf8'))) } catch {}
  // Before the shared registry, usage cards had their own file.
  try { return Object.entries(JSON.parse(readFileSync(join(DATA, 'usage-cards.json'), 'utf8'))).map(([k, c]: [string, any]) => [k, { kind: 'usage', ...c }]) } catch {}
  return []
}
/** Sent cards by "chat:message". */
export const cards = new Map<string, Card>(load())
let saveTimer: ReturnType<typeof setTimeout> | null = null
export function saveCards(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const keep = [...cards].slice(-MAX_KEPT).map(([k, { running: _r, ...c }]) => [k, c])
    try { writeFileSync(`${FILE}.tmp`, JSON.stringify(Object.fromEntries(keep))); renameSync(`${FILE}.tmp`, FILE) } catch (e) { log('save cards', e) }
  }, 500)
}
export const cardId = (chat: number | string, message: number) => `${chat}:${message}`
const split = (id: string) => { const [c, m] = id.split(':'); return { chat_id: Number(c), message_id: Number(m) } }
const errText = (e: unknown) => e instanceof Error ? e.message : String(e)

/** Send a card; returns its id ("chat:message"). Throws if Telegram refuses it (callers fall back to text). */
export async function sendCard(dest: Dest, kind: CardKind, key: string, html: string, state: string, caption: string, extra?: any, silent = false): Promise<string> {
  const m: any = await patient(() => raw().sendWidget({
    chat_id: Number(dest.chat_id), ...threadOpt(dest), html, chat_data: state, caption: caption.slice(0, 1000), allow_queries: true,
    ...(silent ? { disable_notification: true } : {}),
  }))
  const id = cardId(dest.chat_id, m.message_id)
  cards.set(id, { kind, key, state, caption, extra })
  saveCards()
  return id
}
/** Rewrite a card's state (skipped if unchanged). */
export async function editCard(id: string, state: string): Promise<void> {
  const c = cards.get(id)
  if (c?.state === state) return
  await patient(() => raw().editMessageWidgetData({ ...split(id), chat_data: state }))
    .catch((e: any) => { if (!/not modified/.test(String(e))) throw e })
  if (c) { c.state = state; saveCards() }
}
export async function setCaption(id: string, caption: string): Promise<void> {
  const c = cards.get(id)
  if (c?.caption === caption) return
  const { chat_id, message_id } = split(id)
  await bot.api.editMessageCaption(chat_id, message_id, { caption: caption.slice(0, 1000) }).catch(e => { if (!/not modified/.test(String(e))) log('card caption', e) })
  if (c) { c.caption = caption; saveCards() }
}
/** Run `job` for a card unless one is already running for it (one at a time per card). */
export async function exclusive(id: string, job: () => Promise<void>): Promise<void> {
  const c = cards.get(id)
  if (!c || c.running) return
  c.running = true
  try { await job() } catch (e) { log(`card ${c.kind} ${id}`, errText(e)) } finally { c.running = false }
}
/** Rewrite the state with an error shown on it, keeping what the card already shows. */
export async function editError(id: string, msg: string): Promise<void> {
  let prev: any = {}
  try { prev = JSON.parse(cards.get(id)?.state ?? '{}') ?? {} } catch {}
  await editCard(id, JSON.stringify({ ...prev, u: Date.now(), s: undefined, e: msg.slice(0, 200) })).catch(e => log('card error edit', e))
}

const handlers = new Map<CardKind, Handler>()
export function onCard(kind: CardKind, h: Handler): void { handlers.set(kind, h) }
/** Handle a widget_query update. `allowed` says whether this Telegram user may use the bot. */
export async function routeQuery(q: any, allowed: (uid: string) => boolean): Promise<void> {
  const answer = (data?: string) => raw().answerWidgetQuery({ widget_query_id: q.id, ...(data ? { data: data.slice(0, 1024) } : {}) })
    .catch((e: any) => log('answerWidgetQuery', e))
  const from = String(q.from?.id ?? '')
  if (!allowed(from)) { await answer('e:Not authorized.'); return }
  if (!q.chat || !q.message_id) { await answer('e:Not available here.'); return }
  const id = cardId(q.chat.id, q.message_id)
  const card = cards.get(id)
  if (!card) { await answer('e:This card is too old. Send the command again.'); return }
  if (card.key.split(':')[0] !== from) { await answer('e:Not your card.'); return }
  const h = handlers.get(card.kind)
  if (!h) { await answer('e:Unknown card.'); return }
  try { await answer((await h({ qid: q.id, data: String(q.data ?? ''), from, id, card })) ?? undefined) } catch (e) { await answer(`e:${errText(e).slice(0, 200)}`) }
}

/** Bytes after zlib -9, as Telegram counts them (limit 4096). */
export const packedSize = (html: string) => deflateSync(html, { level: 9 }).length
/** Trim `build(level)` until it fits in 1024 bytes (higher level = less detail). */
export function fit(build: (level: number) => unknown, levels = 4): string {
  let s = ''
  for (let i = 0; i < levels; i++) { s = JSON.stringify(build(i)); if (Buffer.byteLength(s) <= 1024) return s }
  return s
}

// --- the page every card starts with ------------------------------------------------------------
// Theme colors only (the bubble's palette), system fonts, no network. `render()` is each card's own.
export const BASE_CSS = `body{margin:0;padding:10px 12px max(10px,env(safe-area-inset-bottom));font:14px/1.35 system-ui,sans-serif}
.h{display:flex;align-items:center;gap:8px;margin-bottom:6px}.h b{font-size:1.05em;flex:1;min-width:0}
.mu{color:var(--tg-theme-hint-color);font-size:.82em}
button{padding:4px 10px;font-size:.85em;border-radius:14px;flex:none}
.sp{display:inline-block}.busy .sp{animation:r 1s linear infinite}@keyframes r{to{transform:rotate(360deg)}}
.e{color:var(--tg-theme-destructive-text-color);font-size:.85em;margin-top:8px}
.nt{color:var(--tg-theme-accent-text-color);font-size:.85em;margin-top:8px}
.f{margin-top:10px;padding-top:6px;border-top:1px solid var(--tg-theme-section-separator-color)}
`
// busy: a request is waiting (for its answer, or with keep=1 for the new state). err: shown under the card.
export const KIT_JS = `var W=window.TelegramWidget;if(!W)W={chatData:null,isForward:false,onEvent:function(){},request:function(){return Promise.reject({code:'NOT_ALLOWED'})}};
var busy=0,bt=0,err='',bgo=0;
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return'&#'+c.charCodeAt(0)+';'})}
function dur(s){if(s<0)return'';s=Math.max(0,s);var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?d+'d '+h+'h':h?h+'h '+m+'m':m+'m'}
function secs(s){s=Math.max(0,Math.round(s));return s<60?s+'s':s<3600?Math.floor(s/60)+'m '+s%60+'s':dur(s)}
function n(x){return x>=1e6?(x/1e6).toFixed(1)+'M':x>=1e4?Math.round(x/1e3)+'k':x>=1e3?(x/1e3).toFixed(1)+'k':''+x}
function J(){try{return JSON.parse(W.chatData)}catch(e){return null}}
var ERR={RATE_LIMITED:'Too many taps, wait a few seconds.',TIMEOUT:'The bot did not answer.',NOT_ALLOWED:'Not available here.',BUSY:'One moment…'};
function done(e){busy=0;clearTimeout(bt);if(e!=null)err=e;render()}
function req(d,ok,keep){if(busy)return;busy=1;err='';render();bt=setTimeout(function(){done('No answer from the bot.')},90000);
W.request(d).then(function(a){var r=a.result||'';if(r.indexOf('e:')==0)done(r.slice(2));else{if(ok)ok(r);if(!keep)done()}},function(e){done(ERR[e.code]||'Request failed ('+e.code+').')})}
function bg(d){if(busy||bgo||W.isForward)return;bgo=1;W.request(d).then(function(){bgo=0},function(){bgo=0})}
`
export const page = (css: string, body: string, js: string) => `<style>${BASE_CSS}${css}</style>${body}<script>${KIT_JS}${js}</script>`
