// One agy ACP process + session per Telegram account, or per topic when the bot has topics on. Streams each turn into a live Telegram
// draft (reply text, thinking, tool steps, plan) and sends the final answer as a rich message.
import { Bot, InlineKeyboard, InputFile } from 'grammy'
import { randomBytes } from 'crypto'
import { Acp, type PermissionRequest, type SessionUpdate } from './acp.ts'
import { sendRich, sendDraft, fence, clip, threadOpt, type Dest } from './rich.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { loadAccount, saveAccount, loadShared, splitKey, DEFAULT_CWD, type AccountState } from './store.ts'
import { KIND_ICON, LIVE_HTML, liveState, type LiveStatus } from './cards/live.ts'
import { sendCard, editCard, setCaption } from './cards/kit.ts'

export const AGY_BIN = process.env.AGY_BIN ?? `${process.env.HOME ?? '/root'}/.local/bin/agy`
export const AGY_SETTINGS = join(process.env.HOME ?? '/root', '.gemini', 'antigravity-cli', 'settings.json')
/** agy's "Tool Permission" setting (same values as its /config panel). */
export const PERMISSIONS = [
  { value: 'request-review', label: '🛡 Ask me (request review)', short: 'ask' },
  { value: 'always-proceed', label: '⚡ Turbo (always proceed)', short: 'turbo' },
  { value: 'proceed-in-sandbox', label: '📦 Run in sandbox', short: 'sandbox' },
  { value: 'strict-mode', label: '🔒 Strict (read-only)', short: 'strict' },
]
// agy has no per-session flag for this; it reads settings.json when it starts, so we write the
// account's choice there just before starting that account's agy process.
function writeToolPermission(value: string): void {
  let cur: any = {}
  try { cur = JSON.parse(readFileSync(AGY_SETTINGS, 'utf8')) } catch {}
  if (cur.toolPermission === value) return
  cur.toolPermission = value
  mkdirSync(join(AGY_SETTINGS, '..'), { recursive: true })
  writeFileSync(AGY_SETTINGS, JSON.stringify(cur, null, 2) + '\n')
}
const DRAFT_EVERY_MS = 1200
const DRAFT_REFRESH_MS = 20_000 // drafts expire after ~30 s; keep them alive
const CARD_EVERY_MS = 3000 // live card edits count as sent messages: at most one per 3 s

export type Step = { id: string; label: string; kind: string; input: string; output: string | null; status: string }
export type PlanEntry = { content: string; status: string }
export type ConfigOption = { id: string; name: string; currentValue: string; options: { value: string; name: string }[] }
export type Command = { name: string; description: string }

type Turn = {
  prompt: string
  draftId: number
  started: number
  text: string
  thought: string
  thinking: boolean
  steps: Step[]
  stepById: Map<string, Step>
  plan: PlanEntry[]
  lastDraft: string
  lastDraftAt: number
  timer: ReturnType<typeof setInterval>
  usage?: [number, number] // this turn's tokens, when agy reports them
  msgId?: number
  // The live card (/live widget): its id once sent, the state last written, and when.
  card?: string
  cardState?: string
  cardAt?: number
  cardBusy?: Promise<void>
  cardFailed?: boolean // could not send it: this turn uses the draft
}
type Queued = { blocks: any[]; msgId?: number }

const log = (...a: unknown[]) => console.error(new Date().toISOString(), ...a)

function stepInput(u: any): string {
  const i = u.rawInput ?? u.args ?? {}
  if (typeof i === 'string') return i
  const pick = i.CommandLine ?? i.command ?? i.cmd ?? i.AbsolutePath ?? i.TargetFile ?? i.Path ?? i.file_path ?? i.path ?? i.Query ?? i.query ?? i.Url ?? i.url
  if (typeof pick === 'string') {
    const extra = i.CodeContent ?? i.Content ?? i.content ?? i.ReplacementContent ?? ''
    return extra ? `${pick}\n\n${String(extra)}` : pick
  }
  const { toolSummary: _t, WaitMsBeforeAsync: _w, ...rest } = i
  return JSON.stringify(rest, null, 1)
}
function stepOutput(u: any): string | null {
  const parts: string[] = []
  for (const c of u.content ?? []) {
    if (c?.type === 'content' && c.content?.type === 'text') parts.push(c.content.text)
    else if (c?.type === 'diff') parts.push(`--- ${c.path}\n${String(c.newText ?? '').slice(0, 4000)}`)
  }
  if (parts.length) return parts.join('\n')
  if (u.rawOutput != null) return typeof u.rawOutput === 'string' ? u.rawOutput : (u.rawOutput.output ?? JSON.stringify(u.rawOutput, null, 1))
  return null
}

export function stepMd(st: Step, inN = 600, outN = 800): string {
  const mark = st.status === 'failed' ? '❌ ' : st.status === 'completed' ? '' : '▸ '
  const out = st.output === null ? '(running…)' : st.output.replace(/\r/g, '').trim() || '(no output)'
  const label = `${KIND_ICON[st.kind] ?? '🔧'} ${clip(st.label.replace(/\s+/g, ' '), 90)}`.replace(/</g, '&lt;')
  return `<details><summary>${mark}${label}</summary>\n\n${fence(clip(st.input.trim() || '(no input)', inN))}\n\n${fence(clip(out, outN, st.kind !== 'read'))}\n\n</details>`
}
export function stepsMd(steps: Step[], budget: number, hiddenBefore = 0): string {
  const parts: string[] = []
  let used = 0, hidden = hiddenBefore
  for (let i = steps.length - 1; i >= 0; i--) {
    let md = stepMd(steps[i]!)
    if (used + md.length > budget) md = stepMd(steps[i]!, 150, 200)
    if (used + md.length > budget) { hidden += i + 1; break }
    parts.unshift(md); used += md.length
  }
  if (hidden > 0) parts.unshift(`_… ${hidden} earlier step${hidden > 1 ? 's' : ''} (/steps shows all)_`)
  return parts.join('\n\n')
}
function planMd(plan: PlanEntry[]): string {
  if (!plan.length) return ''
  return plan.map(e => e.status === 'completed' ? `- [x] ${e.content}` : e.status === 'in_progress' ? `- [ ] ▸ **${e.content}**` : `- [ ] ${e.content}`).join('\n')
}

export class AgentSession {
  acp: Acp | null = null
  sessionId = ''
  cwd = ''
  title = ''
  config: ConfigOption[] = []
  commands: Command[] = []
  turn: Turn | null = null
  queue: Queued[] = []
  lastSteps: Step[] = []
  lastTurn: { prompt: string; text: string; steps: Step[]; plan: PlanEntry[]; note: string; secs: number } | null = null
  lastUsed = 0
  tokens = { input: 0, output: 0, turns: 0 }
  private starting: Promise<void> | null = null
  private replaying = false
  replay = { user: '', agent: '' } // last exchange of the chat that was loaded most recently
  private permissions = new Map<string, { resolve: (id: string | null) => void; options: PermissionRequest['options']; chat_id: string; message_id?: number; text: string }>()
  onCommands: (s: AgentSession) => void = () => {}
  /** The chat's folder or title changed (the topic name follows them). */
  onRename: (s: AgentSession) => void = () => {}
  /** Telegram account (= private chat id) and, for a topic session, its thread id. */
  readonly account: string
  readonly thread?: number
  readonly dest: Dest

  constructor(readonly key: string, private bot: Bot, private mgr: SessionManager) {
    const k = splitKey(key)
    this.account = k.account
    this.thread = k.thread
    this.dest = { chat_id: k.account, thread: k.thread }
  }

  get busy(): boolean { return this.turn !== null }
  get state(): AccountState { return loadAccount(this.key) }
  get running(): boolean { return Boolean(this.acp?.running) }
  configValue(id: string): string { return this.config.find(c => c.id === id)?.currentValue ?? '' }
  /** The display name of a setting's current value (model, thought_level, mode), if agy reported it. */
  configName(id: string): string {
    const c = this.config.find(x => x.id === id)
    return c?.options.find(o => o.value === c.currentValue)?.name ?? c?.currentValue ?? ''
  }
  get modelName(): string { return this.configName('model') || this.state.model || 'default' }

  /** Start agy (if needed) and open the account's chat. */
  ensure(): Promise<void> {
    if (this.running && this.sessionId) return Promise.resolve()
    if (!this.starting) this.starting = this.boot().finally(() => { this.starting = null })
    return this.starting
  }

  private async boot(): Promise<void> {
    await this.mgr.makeRoom(this)
    const st = this.state
    const cwd = existsSync(st.cwd) ? st.cwd : DEFAULT_CWD
    writeToolPermission(st.permission ?? 'request-review')
    const acp = new Acp(AGY_BIN, [], s => log(`[${this.key}]`, s), cwd)
    acp.onUpdate = (sid, u) => this.onUpdate(sid, u)
    acp.onPermission = p => this.askPermission(p)
    acp.onExit = code => {
      log(`[${this.key}] agy exited (${code})`)
      this.acp = null
      this.sessionId = ''
      this.cancelPermissions()
      if (this.turn) void this.finishTurn(`⚠️ agy stopped unexpectedly (exit ${code}). Send your message again.`)
    }
    this.acp = acp
    await acp.start()
    log(`[${this.key}] agy acp started (pid ${acp.pid})`)
    await this.open(st.sessionId, cwd, st.title)
  }

  /** Open an existing chat (load) or start a new one in `cwd`. Returns the last exchange of a loaded chat. */
  async open(sessionId: string | undefined, cwd: string, title = ''): Promise<{ user: string; agent: string } | null> {
    if (this.acp && this.acp.cwd !== cwd) {
      // Different folder: restart agy there (its tools work in the process folder).
      saveAccount(this.key, { cwd, sessionId: sessionId ?? '', title })
      this.stop()
      if (!sessionId) saveAccount(this.key, { sessionId: undefined })
      await this.ensure()
      return sessionId ? { ...this.replay } : null
    }
    const acp = this.acp!
    let res: any = null
    let loaded = false
    this.title = title // a title agy reports while loading replaces it
    if (sessionId) {
      this.replaying = true
      this.replay = { user: '', agent: '' }
      try {
        res = await acp.request('session/load', { sessionId, cwd, mcpServers: [] })
        loaded = true
      } catch (e) {
        log(`[${this.key}] load ${sessionId} failed: ${e}`)
      } finally { this.replaying = false }
    }
    if (!loaded) {
      res = await acp.request('session/new', { cwd, mcpServers: [] })
      sessionId = res.sessionId
      this.title = ''
    }
    this.sessionId = sessionId!
    this.cwd = cwd
    if (res?.configOptions) this.config = res.configOptions
    saveAccount(this.key, { sessionId: this.sessionId, cwd, title: this.title })
    this.onRename(this)
    await this.applyPrefs()
    return loaded ? { ...this.replay } : null
  }

  /** Re-apply the account's saved model / thinking level / mode to the open session. */
  private async applyPrefs(): Promise<void> {
    const st = this.state
    for (const [id, want] of [['model', st.model], ['thought_level', st.thought], ['mode', st.mode]] as const) {
      if (want && this.configValue(id) && this.configValue(id) !== want) {
        await this.setConfig(id, want).catch(e => log(`[${this.key}] set ${id}=${want}: ${e}`))
      }
    }
  }

  async setConfig(id: string, value: string): Promise<void> {
    const r: any = await this.acp!.request('session/set_config_option', { sessionId: this.sessionId, configId: id, value })
    if (r?.configOptions) this.config = r.configOptions
    const key = id === 'thought_level' ? 'thought' : id
    saveAccount(this.key, { [key]: value } as any)
  }

  async newChat(cwd?: string): Promise<void> {
    await this.ensure()
    await this.open(undefined, cwd ?? this.cwd)
  }

  async listChats(): Promise<{ sessionId: string; cwd: string; title?: string; updatedAt?: string }[]> {
    await this.ensure()
    const r: any = await this.acp!.request('session/list', {})
    return r?.sessions ?? []
  }

  stop(): void {
    this.cancelPermissions()
    this.acp?.stop()
    this.acp = null
    this.sessionId = ''
  }

  async restart(): Promise<void> {
    if (this.turn) await this.cancel()
    this.stop()
    await this.ensure()
  }

  // --- turns -----------------------------------------------------------------
  async prompt(blocks: any[], msgId?: number): Promise<void> {
    this.lastUsed = Date.now()
    if (this.turn || this.starting) {
      this.queue.push({ blocks, msgId })
      if (this.turn) await this.bot.api.sendMessage(this.account, `⏳ Queued (${this.queue.length}). agy is still working; it runs next. /stop cancels the current turn.`, threadOpt(this.dest)).catch(() => {})
      if (this.turn) return
      await this.starting
      return this.drain()
    }
    this.queue.push({ blocks, msgId })
    return this.drain()
  }

  private async drain(): Promise<void> {
    while (!this.turn && this.queue.length) {
      const q = this.queue.shift()!
      try {
        if (!this.running || !this.sessionId) {
          await this.bot.api.sendChatAction(this.account, 'typing', threadOpt(this.dest)).catch(() => {})
          await this.ensure()
        }
      } catch (e) {
        await this.bot.api.sendMessage(this.account, `⚠️ Couldn't start agy: ${e instanceof Error ? e.message : e}`, threadOpt(this.dest)).catch(() => {})
        continue
      }
      await this.runTurn(q)
    }
  }

  private async runTurn(q: Queued): Promise<void> {
    const t: Turn = {
      prompt: q.blocks.map(b => b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '').join(' ').trim(),
      draftId: 1 + Math.floor(Math.random() * 2_000_000_000), started: Date.now(),
      text: '', thought: '', thinking: true, steps: [], stepById: new Map(), plan: [], lastDraft: '', lastDraftAt: 0,
      timer: setInterval(() => void this.pushDraft(), DRAFT_EVERY_MS),
      msgId: q.msgId,
    }
    this.turn = t
    void this.pushDraft(true)
    let stop = ''
    try {
      const r: any = await this.acp!.request('session/prompt', { sessionId: this.sessionId, prompt: q.blocks })
      stop = r?.stopReason ?? ''
      const u = r?.usage
      if (u) { this.tokens.input += u.inputTokens ?? 0; this.tokens.output += u.outputTokens ?? 0; t.usage = [u.inputTokens ?? 0, u.outputTokens ?? 0] }
      this.tokens.turns++
    } catch (e) {
      if (this.turn === t) await this.finishTurn(`⚠️ ${e instanceof Error ? e.message : e}`)
      return
    }
    if (this.turn !== t) return
    const note = stop === 'cancelled' ? '⏹ Stopped.' : stop === 'max_tokens' ? '⚠️ Reply cut off (output limit).'
      : stop === 'max_turn_requests' ? '⚠️ Stopped: too many steps in one turn.' : stop === 'refusal' ? '⚠️ The model refused.' : ''
    await this.finishTurn(note)
  }

  private async finishTurn(note: string): Promise<void> {
    const t = this.turn
    if (!t) return
    clearInterval(t.timer)
    this.turn = null
    if (t.card || t.cardBusy) await this.closeCard(t, note)
    this.lastUsed = Date.now()
    if (t.steps.length) this.lastSteps = t.steps
    this.lastTurn = { prompt: t.prompt, text: t.text, steps: t.steps, plan: t.plan, note, secs: Math.round((Date.now() - t.started) / 1000) }

    // 1. Reactions on the user's message (only if explicitly requested by the agent)
    const reactMatch = /(?:\[reaction:\s*([^\s\]]+)\]|\[react:\s*([^\s\]]+)\])/i.exec(t.text)
    if (t.msgId && reactMatch) {
      const emoji = reactMatch[1] || reactMatch[2]
      void this.bot.api.setMessageReaction(this.account, t.msgId, [{ type: 'emoji', emoji: emoji as any }]).catch(() => {})
    }

    // 2. Scan and send any attached / referenced files
    const toSend = new Set<string>()
    const sendFileRe = /(?:\[send_file:\s*([^\s\]]+)\]|<send_file>([^<]+)<\/send_file>|send_file:\s*(\/[^\s\n\r]+))/gi
    let match: RegExpExecArray | null
    while ((match = sendFileRe.exec(t.text)) !== null) {
      const p = (match[1] || match[2] || match[3] || '').trim()
      if (p) toSend.add(p)
    }

    const linkRe = /\[[^\]]*\]\((?:file:\/\/)?(\/[^\)\s]+\.(?:png|jpg|jpeg|gif|webp|svg|pdf|zip|tar|gz|txt|csv|json|xlsx|docx|py|sh|html|mp4|mp3|ogg))\)/gi
    while ((match = linkRe.exec(t.text)) !== null) {
      const p = (match[1] || '').trim()
      if (p && existsSync(p)) toSend.add(p)
    }

    for (const filePath of toSend) {
      try {
        if (!existsSync(filePath) || !statSync(filePath).isFile()) continue
        const name = basename(filePath)
        const ext = name.split('.').pop()?.toLowerCase() ?? ''
        if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
          await this.bot.api.sendPhoto(this.account, new InputFile(filePath), {
            caption: name,
            ...threadOpt(this.dest),
          })
        } else {
          await this.bot.api.sendDocument(this.account, new InputFile(filePath, name), {
            caption: name,
            ...threadOpt(this.dest),
          })
        }
      } catch (err) {
        log(`[${this.key}] failed to send file ${filePath}:`, err)
      }
    }

    // Clean up [send_file: ...] and [reaction: ...] tags from the text
    const cleanText = t.text.replace(sendFileRe, '').replace(/(?:\[reaction:\s*[^\s\]]+\]|\[react:\s*[^\s\]]+\])/gi, '').trim()

    const parts: string[] = []
    if (cleanText) parts.push(cleanText)
    if (t.plan.length && !cleanText) parts.push(planMd(t.plan))
    const meta: string[] = []
    if (t.steps.length) meta.push(`🔧 ${t.steps.length} step${t.steps.length > 1 ? 's' : ''} · /steps`)
    meta.push(`${Math.round((Date.now() - t.started) / 1000)}s`)
    if (note) parts.push(note)
    if (!parts.length) parts.push('_(agy finished without a text reply)_')
    parts.push(`<sub>${meta.join(' · ')}</sub>`)
    await sendRich(this.bot, this.dest, parts.join('\n\n')).catch(e => log('final send failed', e))
    void this.drain()
  }

  async cancel(): Promise<boolean> {
    if (!this.turn || !this.acp) return false
    this.cancelPermissions()
    this.acp.notify('session/cancel', { sessionId: this.sessionId })
    // The pending session/prompt resolves with stopReason "cancelled".
    for (let i = 0; i < 40 && this.turn; i++) await Bun.sleep(250)
    if (this.turn) await this.finishTurn('⏹ Stopped (agy did not confirm; it may still be finishing).')
    this.queue.length = 0
    return true
  }

  private renderLive(t: Turn): string {
    const secs = Math.round((Date.now() - t.started) / 1000)
    const model = this.config.find(c => c.id === 'model')
    const modelName = model?.options.find(o => o.value === model.currentValue)?.name ?? model?.currentValue ?? ''
    const head = `**${t.thinking && !t.text ? '💭 Thinking' : t.text ? '✍️ Writing' : '⏳ Working'}… ${secs}s**${modelName ? ` · ${modelName}` : ''}`
    const out: string[] = [head]
    const plan = planMd(t.plan)
    if (plan) out.push(plan)
    if (t.steps.length) out.push(stepsMd(t.steps.slice(-6), 9000, Math.max(0, t.steps.length - 6)))
    if (t.thinking && t.thought && !t.text) out.push(`> 💭 ${clip(t.thought.replace(/\s+/g, ' ').trim(), 400, true)}`)
    if (t.text) out.push(clip(t.text, 12000, true))
    return out.join('\n\n')
  }

  private liveStatus(t: Turn): LiveStatus { return t.thinking && !t.text ? 'think' : t.text ? 'write' : 'work' }
  private liveInput(t: Turn) { return { started: t.started, model: this.configName('model'), steps: t.steps, plan: t.plan } }

  /** The live card: sent when the turn starts, then rewritten at most every 3 s when something changed. */
  private async pushCard(t: Turn): Promise<void> {
    if (t.cardBusy) return
    const state = liveState({ ...this.liveInput(t), status: this.liveStatus(t) })
    if (t.card && (state === t.cardState || Date.now() - (t.cardAt ?? 0) < CARD_EVERY_MS)) return
    t.cardBusy = (async () => {
      t.cardAt = Date.now()
      try {
        if (!t.card) t.card = await sendCard(this.dest, 'live', this.key, LIVE_HTML, state, `▶ ${clip(t.prompt.replace(/\s+/g, ' '), 300) || 'agy is working'}`, { started: t.started }, true)
        else await editCard(t.card, state)
        t.cardState = state
      } catch (e) {
        log(`[${this.key}] live card failed`, String(e))
        if (!t.card) { t.cardFailed = true; void this.pushDraft(true) } // fall back to the draft for this turn
      }
    })().finally(() => { t.cardBusy = undefined })
  }
  /** The card's last state: done, stopped or failed, with the time, steps and tokens. */
  private async closeCard(t: Turn, note: string): Promise<void> {
    if (t.cardBusy) await t.cardBusy
    if (!t.card) return
    const secs = Math.round((Date.now() - t.started) / 1000)
    const status: LiveStatus = /^⏹/.test(note) ? 'stop' : /^⚠️/.test(note) ? 'err' : 'done'
    await editCard(t.card, liveState({ ...this.liveInput(t), status, secs, tokens: t.usage, note: status === 'err' ? note.replace(/^\S+\s*/, '') : status === 'done' ? note : undefined }))
      .catch(e => log(`[${this.key}] live card close failed`, String(e)))
    const what = status === 'done' ? '✓ Done' : status === 'stop' ? '⏹ Stopped' : '⚠️ Stopped'
    await setCaption(t.card, `${what} in ${secs}s${t.steps.length ? ` · ${t.steps.length} step${t.steps.length > 1 ? 's' : ''}` : ''} · ${clip(t.prompt.replace(/\s+/g, ' '), 200)}`)
  }

  private async pushDraft(force = false): Promise<void> {
    const t = this.turn
    const live = this.state.live
    if (!t || live === false) return
    if (live === 'widget' && !t.cardFailed) return this.pushCard(t)
    if (this.mgr.liveBroken) return
    const md = this.renderLive(t)
    const now = Date.now()
    if (!force && md === t.lastDraft && now - t.lastDraftAt < DRAFT_REFRESH_MS) return
    t.lastDraft = md
    t.lastDraftAt = now
    try { await sendDraft(this.bot, this.dest, t.draftId, md) } catch (e) {
      const msg = String(e)
      log('draft failed', msg)
      if (/not found|unknown method/i.test(msg)) this.mgr.liveBroken = true
    }
  }

  // --- agent → us ------------------------------------------------------------
  private onUpdate(sid: string, u: SessionUpdate): void {
    if (sid && this.sessionId && sid !== this.sessionId && !this.replaying) return
    const kind = u.sessionUpdate
    if (kind === 'available_commands_update') { this.commands = u.availableCommands ?? []; this.onCommands(this); return }
    if (kind === 'config_option_update') { if (u.configOptions) this.config = u.configOptions; return }
    if (kind === 'session_info_update') {
      if (u.title && u.title !== this.title) { this.title = u.title; saveAccount(this.key, { title: u.title }); this.onRename(this) }
      return
    }
    if (kind === 'current_mode_update') {
      const m = this.config.find(c => c.id === 'mode')
      if (m && u.currentModeId) m.currentValue = u.currentModeId
      return
    }
    if (this.replaying) {
      const txt = u.content?.type === 'text' ? String(u.content.text ?? '') : ''
      // Keep only the last exchange: a user message after an agent reply starts a new one.
      if (kind === 'user_message_chunk') { if (this.replay.agent) this.replay = { user: '', agent: '' }; this.replay.user += txt }
      else if (kind === 'agent_message_chunk') this.replay.agent += txt
      return
    }
    const t = this.turn
    if (!t) return
    switch (kind) {
      case 'agent_message_chunk':
        if (u.content?.type === 'text') { t.text += u.content.text; t.thinking = false }
        break
      case 'agent_thought_chunk':
        if (u.content?.type === 'text') { t.thought += u.content.text; t.thinking = true }
        break
      case 'tool_call': {
        const intermediate = t.text.trim()
        if (intermediate.length >= 20 && !intermediate.startsWith('⚠️')) {
          void sendRich(this.bot, this.dest, intermediate).catch(e => log('intermediate send failed', e))
          t.text = ''
          t.lastDraft = ''
          void this.pushDraft(true)
        } else if (t.text && !t.text.endsWith('\n\n')) {
          t.text += '\n\n'
        }
        const st: Step = {
          id: u.toolCallId, label: u.title || u.name || 'tool', kind: u.kind ?? 'other',
          input: stepInput(u), output: null, status: u.status ?? 'pending',
        }
        t.steps.push(st)
        t.stepById.set(st.id, st)
        t.thinking = false
        break
      }
      case 'tool_call_update': {
        const st = t.stepById.get(u.toolCallId)
        if (!st) break
        if (u.status) st.status = u.status
        if (u.title) st.label = u.title
        const o = stepOutput(u)
        if (o !== null && (u.status === 'completed' || u.status === 'failed' || o)) st.output = o
        break
      }
      case 'plan':
        t.plan = (u.entries ?? []).map((e: any) => ({ content: String(e.content ?? ''), status: String(e.status ?? 'pending') }))
        break
    }
  }

  private async askPermission(p: PermissionRequest): Promise<string | null> {
    const chat_id = this.account
    const tc = p.toolCall ?? ({} as any)
    const key = randomBytes(3).toString('hex')
    const input = stepInput(tc)
    const text = `🔐 **agy wants to ${tc.kind === 'execute' ? 'run a command' : tc.kind === 'edit' ? 'edit a file' : tc.kind === 'delete' ? 'delete a file' : `use ${tc.name ?? 'a tool'}`}**\n\n${fence(clip(input || tc.title || '', 1500))}`
    const kb = new InlineKeyboard()
    p.options.forEach((o, i) => kb.text(`${o.kind.startsWith('allow') ? '✅' : '❌'} ${o.name}`, `pm:${key}:${i}`))
    return new Promise<string | null>(resolve => {
      const entry: { resolve: (id: string | null) => void; options: PermissionRequest['options']; chat_id: string; message_id?: number; text: string } = { resolve, options: p.options, chat_id, text }
      this.permissions.set(key, entry)
      void sendRich(this.bot, this.dest, text, { reply_markup: kb }).then(ids => { entry.message_id = ids.at(-1) }).catch(() => {})
    })
  }

  /** Button pressed on a permission prompt. Returns the chosen option's name, or null if stale. */
  answerPermission(key: string, idx: number): { name: string; entry: any } | null {
    const e = this.permissions.get(key)
    if (!e) return null
    const o = e.options[idx]
    if (!o) return null
    this.permissions.delete(key)
    e.resolve(o.optionId)
    return { name: o.name, entry: e }
  }

  private cancelPermissions(): void {
    for (const [k, e] of this.permissions) {
      e.resolve(null)
      if (e.message_id) void this.bot.api.editMessageReplyMarkup(e.chat_id, e.message_id, { reply_markup: undefined }).catch(() => {})
      this.permissions.delete(k)
    }
  }
}

export class SessionManager {
  sessions = new Map<string, AgentSession>()
  liveBroken = false
  onCommands: (s: AgentSession) => void = () => {}
  onRename: (s: AgentSession) => void = () => {}
  constructor(private bot: Bot) {}

  /** `key` is "<account>" or "<account>:<thread>" (see store.keyOf). */
  get(key: string): AgentSession {
    let s = this.sessions.get(key)
    if (!s) {
      s = new AgentSession(key, this.bot, this)
      s.onCommands = x => this.onCommands(x)
      s.onRename = x => this.onRename(x)
      this.sessions.set(key, s)
    }
    return s
  }
  /** Stop and forget a session (its topic was deleted, or its account removed). */
  drop(key: string): void {
    this.sessions.get(key)?.stop()
    this.sessions.delete(key)
  }
  ofAccount(account: string): AgentSession[] { return [...this.sessions.values()].filter(s => s.account === account) }
  maxSessions(): number { return Math.max(1, Number(loadShared().maxSessions ?? process.env.MAX_SESSIONS ?? 3) || 3) }
  running(): AgentSession[] { return [...this.sessions.values()].filter(s => s.running) }

  /** Before starting `who`, stop the least recently used idle session if we're at the cap. */
  async makeRoom(who: AgentSession): Promise<void> {
    const live = this.running().filter(s => s !== who)
    if (live.length < this.maxSessions()) return
    const idle = live.filter(s => !s.busy).sort((a, b) => a.lastUsed - b.lastUsed)
    if (!idle.length) throw new Error(`all ${this.maxSessions()} agy sessions are busy right now; try again in a few minutes`)
    log(`stopping idle session of ${idle[0]!.key} to make room`)
    idle[0]!.stop()
  }

  /** Which other running session (by key) has this chat open? */
  ownerOf(sessionId: string, except: string): string | null {
    for (const s of this.sessions.values()) if (s.key !== except && s.running && s.sessionId === sessionId) return s.key
    return null
  }
}

// --- /screen: a terminal-style view of the current (or last) turn, as ANSI text ----------------
const A = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', blue: '\x1b[34m', gray: '\x1b[90m', inv: '\x1b[7m' }
function wrap(s: string, width: number): string[] {
  const out: string[] = []
  for (const raw of s.replace(/\r/g, '').split('\n')) {
    let line = raw
    while ([...line].length > width) { const ch = [...line]; out.push(ch.slice(0, width).join('')); line = ch.slice(width).join('') }
    out.push(line)
  }
  return out
}
export function screenAnsi(s: AgentSession, width = 100): string {
  const live = s.turn
  const t = live
    ? { prompt: live.prompt, text: live.text, steps: live.steps, plan: live.plan, note: '', secs: Math.round((Date.now() - live.started) / 1000) }
    : s.lastTurn
  const out: string[] = []
  const rule = A.gray + '─'.repeat(width) + A.reset
  const model = s.config.find(c => c.id === 'model')
  const modelName = model?.options.find(o => o.value === model.currentValue)?.name ?? model?.currentValue ?? ''
  out.push(`${A.bold}${A.cyan}Antigravity${A.reset} ${A.gray}· ${s.title || '(new chat)'} · ${s.cwd}${A.reset}`, rule)
  if (!t) out.push(`${A.gray}Nothing has run in this session yet.${A.reset}`)
  else {
    for (const l of wrap(`> ${t.prompt || '(attachment)'}`, width).slice(0, 8)) out.push(`${A.bold}${l}${A.reset}`)
    out.push('')
    for (const e of t.plan) {
      const box = e.status === 'completed' ? `${A.green}☑` : e.status === 'in_progress' ? `${A.yellow}▸` : `${A.gray}☐`
      out.push(`${box} ${e.content}${A.reset}`)
    }
    if (t.plan.length) out.push('')
    for (const st of t.steps.slice(-12)) {
      const mark = st.status === 'completed' ? `${A.green}●` : st.status === 'failed' ? `${A.red}●` : `${A.yellow}●`
      out.push(`${mark}${A.reset} ${A.bold}${clip(st.label.replace(/\s+/g, ' '), width - 4)}${A.reset}`)
      const o = (st.output ?? (st.status === 'completed' ? '' : 'running…')).replace(/\r/g, '').trim()
      const lines = o.split('\n').filter(x => x.trim()).slice(-6)
      lines.forEach((l, i) => out.push(`${A.gray}  ${i === 0 ? '⎿' : ' '} ${clip(l, width - 6)}${A.reset}`))
    }
    if (t.text.trim()) {
      out.push('')
      for (const l of wrap(t.text.trim(), width).slice(-40)) out.push(l)
    }
    out.push('')
    out.push(live ? `${A.yellow}✻ Working… ${t.secs}s${A.reset}` : `${A.gray}✻ Done in ${t.secs}s${t.note ? ` · ${t.note}` : ''}${A.reset}`)
  }
  const mode = s.config.find(c => c.id === 'mode')?.currentValue ?? 'default'
  const perm = PERMISSIONS.find(p => p.value === (s.state.permission ?? 'request-review'))?.short ?? ''
  out.push(rule, `${A.gray}${modelName} · mode ${mode} · tools ${perm}${A.reset}`)
  return out.join('\n')
}
