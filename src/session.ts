// One agy ACP process + session per Telegram account. Streams each turn into a live Telegram
// draft (reply text, thinking, tool steps, plan) and sends the final answer as a rich message.
import { Bot, InlineKeyboard } from 'grammy'
import { randomBytes } from 'crypto'
import { Acp, type PermissionRequest, type SessionUpdate } from './acp.ts'
import { sendRich, sendDraft, fence, clip } from './rich.ts'
import { existsSync } from 'fs'
import { loadAccount, saveAccount, loadShared, DEFAULT_CWD, type AccountState } from './store.ts'

export const AGY_BIN = process.env.AGY_BIN ?? `${process.env.HOME ?? '/root'}/.local/bin/agy`
const DRAFT_EVERY_MS = 1200
const DRAFT_REFRESH_MS = 20_000 // drafts expire after ~30 s; keep them alive

export type Step = { id: string; label: string; kind: string; input: string; output: string | null; status: string }
export type PlanEntry = { content: string; status: string }
export type ConfigOption = { id: string; name: string; currentValue: string; options: { value: string; name: string }[] }
export type Command = { name: string; description: string }

type Turn = {
  chat_id: string
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
}
type Queued = { chat_id: string; blocks: any[] }

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
const KIND_ICON: Record<string, string> = {
  execute: '⚙️', read: '📄', edit: '✏️', delete: '🗑', move: '📦', search: '🔍', fetch: '🌐', think: '💭', other: '🔧',
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
  lastUsed = 0
  tokens = { input: 0, output: 0, turns: 0 }
  private starting: Promise<void> | null = null
  private replaying = false
  private replay = { user: '', agent: '' }
  private permissions = new Map<string, { resolve: (id: string | null) => void; options: PermissionRequest['options']; chat_id: string; message_id?: number; text: string }>()
  onCommands: (s: AgentSession) => void = () => {}

  constructor(readonly account: string, private bot: Bot, private mgr: SessionManager) {}

  get busy(): boolean { return this.turn !== null }
  get state(): AccountState { return loadAccount(this.account) }
  get running(): boolean { return Boolean(this.acp?.running) }
  configValue(id: string): string { return this.config.find(c => c.id === id)?.currentValue ?? '' }

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
    const acp = new Acp(AGY_BIN, st.yolo ? ['--dangerously-skip-permissions'] : [], s => log(`[${this.account}]`, s), cwd)
    acp.onUpdate = (sid, u) => this.onUpdate(sid, u)
    acp.onPermission = p => this.askPermission(p)
    acp.onExit = code => {
      log(`[${this.account}] agy exited (${code})`)
      this.acp = null
      this.sessionId = ''
      this.cancelPermissions()
      if (this.turn) void this.finishTurn(`⚠️ agy stopped unexpectedly (exit ${code}). Send your message again.`)
    }
    this.acp = acp
    await acp.start()
    log(`[${this.account}] agy acp started (pid ${acp.pid})`)
    await this.open(st.sessionId, cwd)
  }

  /** Open an existing chat (load) or start a new one in `cwd`. Returns the last exchange of a loaded chat. */
  async open(sessionId: string | undefined, cwd: string): Promise<{ user: string; agent: string } | null> {
    if (this.acp && this.acp.cwd !== cwd) {
      // Different folder: restart agy there (its tools work in the process folder).
      saveAccount(this.account, { cwd, sessionId: sessionId ?? '' })
      this.stop()
      if (!sessionId) saveAccount(this.account, { sessionId: undefined })
      await this.ensure()
      return sessionId ? { ...this.replay } : null
    }
    const acp = this.acp!
    let res: any = null
    let loaded = false
    if (sessionId) {
      this.replaying = true
      this.replay = { user: '', agent: '' }
      try {
        res = await acp.request('session/load', { sessionId, cwd, mcpServers: [] })
        loaded = true
      } catch (e) {
        log(`[${this.account}] load ${sessionId} failed: ${e}`)
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
    saveAccount(this.account, { sessionId: this.sessionId, cwd })
    await this.applyPrefs()
    return loaded ? { ...this.replay } : null
  }

  /** Re-apply the account's saved model / thinking level / mode to the open session. */
  private async applyPrefs(): Promise<void> {
    const st = this.state
    for (const [id, want] of [['model', st.model], ['thought_level', st.thought], ['mode', st.mode]] as const) {
      if (want && this.configValue(id) && this.configValue(id) !== want) {
        await this.setConfig(id, want).catch(e => log(`[${this.account}] set ${id}=${want}: ${e}`))
      }
    }
  }

  async setConfig(id: string, value: string): Promise<void> {
    const r: any = await this.acp!.request('session/set_config_option', { sessionId: this.sessionId, configId: id, value })
    if (r?.configOptions) this.config = r.configOptions
    const key = id === 'thought_level' ? 'thought' : id
    saveAccount(this.account, { [key]: value } as any)
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
  async prompt(chat_id: string, blocks: any[]): Promise<void> {
    this.lastUsed = Date.now()
    if (this.turn || this.starting) {
      this.queue.push({ chat_id, blocks })
      if (this.turn) await this.bot.api.sendMessage(chat_id, `⏳ Queued (${this.queue.length}). agy is still working; it runs next. /stop cancels the current turn.`).catch(() => {})
      if (this.turn) return
      await this.starting
      return this.drain()
    }
    this.queue.push({ chat_id, blocks })
    return this.drain()
  }

  private async drain(): Promise<void> {
    while (!this.turn && this.queue.length) {
      const q = this.queue.shift()!
      try {
        if (!this.running || !this.sessionId) {
          await this.bot.api.sendChatAction(q.chat_id, 'typing').catch(() => {})
          await this.ensure()
        }
      } catch (e) {
        await this.bot.api.sendMessage(q.chat_id, `⚠️ Couldn't start agy: ${e instanceof Error ? e.message : e}`).catch(() => {})
        continue
      }
      await this.runTurn(q)
    }
  }

  private async runTurn(q: Queued): Promise<void> {
    const t: Turn = {
      chat_id: q.chat_id, draftId: 1 + Math.floor(Math.random() * 2_000_000_000), started: Date.now(),
      text: '', thought: '', thinking: true, steps: [], stepById: new Map(), plan: [], lastDraft: '', lastDraftAt: 0,
      timer: setInterval(() => void this.pushDraft(), DRAFT_EVERY_MS),
    }
    this.turn = t
    void this.pushDraft(true)
    let stop = ''
    try {
      const r: any = await this.acp!.request('session/prompt', { sessionId: this.sessionId, prompt: q.blocks })
      stop = r?.stopReason ?? ''
      const u = r?.usage
      if (u) { this.tokens.input += u.inputTokens ?? 0; this.tokens.output += u.outputTokens ?? 0 }
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
    this.lastUsed = Date.now()
    if (t.steps.length) this.lastSteps = t.steps
    const parts: string[] = []
    if (t.text.trim()) parts.push(t.text.trim())
    if (t.plan.length && !t.text.trim()) parts.push(planMd(t.plan))
    const meta: string[] = []
    if (t.steps.length) meta.push(`🔧 ${t.steps.length} step${t.steps.length > 1 ? 's' : ''} · /steps`)
    meta.push(`${Math.round((Date.now() - t.started) / 1000)}s`)
    if (note) parts.push(note)
    if (!parts.length) parts.push('_(agy finished without a text reply)_')
    parts.push(`<sub>${meta.join(' · ')}</sub>`)
    await sendRich(this.bot, t.chat_id, parts.join('\n\n')).catch(e => log('final send failed', e))
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

  private async pushDraft(force = false): Promise<void> {
    const t = this.turn
    if (!t || this.state.live === false || this.mgr.liveBroken) return
    const md = this.renderLive(t)
    const now = Date.now()
    if (!force && md === t.lastDraft && now - t.lastDraftAt < DRAFT_REFRESH_MS) return
    t.lastDraft = md
    t.lastDraftAt = now
    try { await sendDraft(this.bot, t.chat_id, t.draftId, md) } catch (e) {
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
    if (kind === 'session_info_update') { if (u.title) this.title = u.title; return }
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
        if (t.text && !t.text.endsWith('\n\n')) t.text += '\n\n'
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
    const chat_id = this.turn?.chat_id ?? this.account
    const tc = p.toolCall ?? ({} as any)
    const key = randomBytes(3).toString('hex')
    const input = stepInput(tc)
    const text = `🔐 **agy wants to ${tc.kind === 'execute' ? 'run a command' : tc.kind === 'edit' ? 'edit a file' : tc.kind === 'delete' ? 'delete a file' : `use ${tc.name ?? 'a tool'}`}**\n\n${fence(clip(input || tc.title || '', 1500))}`
    const kb = new InlineKeyboard()
    p.options.forEach((o, i) => kb.text(`${o.kind.startsWith('allow') ? '✅' : '❌'} ${o.name}`, `pm:${key}:${i}`))
    return new Promise<string | null>(resolve => {
      const entry: { resolve: (id: string | null) => void; options: PermissionRequest['options']; chat_id: string; message_id?: number; text: string } = { resolve, options: p.options, chat_id, text }
      this.permissions.set(key, entry)
      void sendRich(this.bot, chat_id, text, { reply_markup: kb }).then(ids => { entry.message_id = ids.at(-1) }).catch(() => {})
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
  constructor(private bot: Bot) {}

  get(account: string): AgentSession {
    let s = this.sessions.get(account)
    if (!s) {
      s = new AgentSession(account, this.bot, this)
      s.onCommands = x => this.onCommands(x)
      this.sessions.set(account, s)
    }
    return s
  }
  maxSessions(): number { return Math.max(1, Number(loadShared().maxSessions ?? process.env.MAX_SESSIONS ?? 3) || 3) }
  running(): AgentSession[] { return [...this.sessions.values()].filter(s => s.running) }

  /** Before starting `who`, stop the least recently used idle session if we're at the cap. */
  async makeRoom(who: AgentSession): Promise<void> {
    const live = this.running().filter(s => s !== who)
    if (live.length < this.maxSessions()) return
    const idle = live.filter(s => !s.busy).sort((a, b) => a.lastUsed - b.lastUsed)
    if (!idle.length) throw new Error(`all ${this.maxSessions()} agy sessions are busy right now; try again in a few minutes`)
    log(`stopping idle session of ${idle[0]!.account} to make room`)
    idle[0]!.stop()
  }

  /** Which other account has this chat open? */
  ownerOf(sessionId: string, except: string): string | null {
    for (const s of this.sessions.values()) if (s.account !== except && s.running && s.sessionId === sessionId) return s.account
    return null
  }
}
