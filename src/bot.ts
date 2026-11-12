// agy-telegram: use Google's Antigravity CLI (agy) from Telegram.
// Each allowed account gets its own `agy acp` process and chat (like separate terminals on the
// same machine). Replies stream live; tool steps, plans and permission prompts appear in Telegram.
import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy'
import { execFile } from 'child_process'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync, appendFileSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { sendRich, fence, clip } from './rich.ts'
import { SessionManager, AgentSession, stepsMd, AGY_BIN, PERMISSIONS } from './session.ts'
import {
  DATA, ROOT, loadShared, saveShared, loadAccount, saveAccount, adminIds, isAdmin, isMember, memberIds,
} from './store.ts'

// --- config --------------------------------------------------------------------
for (const f of [join(ROOT, '.env')]) {
  try {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim()
    }
  } catch {}
}
const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN missing (see .env.example)'); process.exit(1) }
if (!adminIds().length) { console.error('ADMIN_IDS missing (see .env.example)'); process.exit(1) }
const PROJECT_ROOTS = (process.env.PROJECT_ROOTS ?? homedir()).split(':')
const INBOX = join(DATA, 'inbox')
const OUT = join(DATA, 'out')
const SHELL_LOG = join(DATA, 'shell.log')
const AGY_SETTINGS = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')
const log = (...a: unknown[]) => console.error(new Date().toISOString(), ...a)

const bot = new Bot(TOKEN)
const mgr = new SessionManager(bot)
let botUsername = ''

// --- helpers ---------------------------------------------------------------------
const uid = (ctx: Context) => String(ctx.from?.id ?? '')
const chatId = (ctx: Context) => String(ctx.chat?.id ?? '')
const arg = (ctx: Context) => String(ctx.match ?? '').trim()
const isPrivate = (ctx: Context) => ctx.chat?.type === 'private'
function displayName(from: Context['from']): string {
  if (!from) return 'someone'
  return from.username ? `@${from.username}` : (from.first_name ?? String(from.id))
}
const userName = (id: string) => loadShared().users?.[id]?.name ?? id
function gate(ctx: Context): boolean {
  if (!isPrivate(ctx)) return false
  if (isMember(uid(ctx))) return true
  void ctx.reply('🔒 This bot is private. Ask the admin for an invite link.').catch(() => {})
  return false
}
function adminGate(ctx: Context): boolean {
  if (!gate(ctx)) return false
  if (isAdmin(uid(ctx))) return true
  void ctx.reply('🔒 Only an admin can do that.').catch(() => {})
  return false
}
function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
async function sendLong(chat_id: string, md: string, full: string, filename: string): Promise<void> {
  await sendRich(bot, chat_id, md)
  if (full.length <= 3200) return
  mkdirSync(OUT, { recursive: true })
  const path = join(OUT, `${Date.now()}-${filename}`)
  writeFileSync(path, full)
  await bot.api.sendDocument(chat_id, new InputFile(path, filename)).catch(() => {})
}
function run(cmd: string, args: string[], cwd: string, timeout = 120_000): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } }, (err: any, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ? (stdout ? '\n' : '') + stderr : ''}`.split('\n').filter(l => !/logging before google\.Init/.test(l)).join('\n')
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out })
    })
  })
}
const sess = (ctx: Context) => mgr.get(uid(ctx))
function modelName(s: AgentSession): string {
  const m = s.config.find(c => c.id === 'model')
  return m?.options.find(o => o.value === m.currentValue)?.name ?? (s.state.model || 'default')
}

// --- accounts: /invite /join /users ------------------------------------------------
const joinTries = new Map<string, number[]>()
async function tryJoin(ctx: Context, code: string): Promise<void> {
  const id = uid(ctx)
  if (isMember(id)) { await ctx.reply('You already have access. Send a message to start.'); return }
  const now = Date.now()
  const tries = (joinTries.get(id) ?? []).filter(t => now - t < 3600_000)
  if (tries.length >= 5) { await ctx.reply('Too many tries. Wait an hour.'); return }
  joinTries.set(id, [...tries, now])
  const s = loadShared()
  const inv = s.invites?.[code]
  if (!inv || inv.exp < now) { await ctx.reply('Invalid or expired invite code.'); return }
  delete s.invites![code]
  s.users = { ...(s.users ?? {}), [id]: { name: displayName(ctx.from), addedBy: inv.by, addedAt: new Date().toISOString() } }
  saveShared(s)
  await ctx.reply('✅ You have access. Each account gets its own agy session. Send /help to see what you can do.')
  for (const a of adminIds()) await bot.api.sendMessage(a, `👤 ${displayName(ctx.from)} (${id}) joined with an invite from ${userName(inv.by)}.`).catch(() => {})
}
bot.command('start', async ctx => {
  if (!isPrivate(ctx)) return
  const m = /^join_([0-9a-f]{8})$/.exec(arg(ctx))
  if (m) { await tryJoin(ctx, m[1]!); return }
  if (!isMember(uid(ctx))) { await ctx.reply('🔒 This bot is private. Ask the admin for an invite link.'); return }
  await ctx.reply(`Hi! Messages you send here go to your own Antigravity (agy) session on the server.\nSend /help for commands.`)
})
bot.command('join', async ctx => { if (isPrivate(ctx)) await tryJoin(ctx, arg(ctx).toLowerCase()) })
bot.command('invite', async ctx => {
  if (!adminGate(ctx)) return
  const code = randomBytes(4).toString('hex')
  const s = loadShared()
  s.invites = Object.fromEntries(Object.entries(s.invites ?? {}).filter(([, v]) => v.exp > Date.now()))
  s.invites[code] = { by: uid(ctx), exp: Date.now() + 15 * 60_000 }
  saveShared(s)
  await ctx.reply(`Invite (valid 15 minutes, one use):\nhttps://t.me/${botUsername}?start=join_${code}\n\nOr they send: /join ${code}`)
})
function usersView(): { md: string; kb: InlineKeyboard } {
  const s = loadShared()
  const kb = new InlineKeyboard()
  const lines = ['## 👥 Accounts', '']
  for (const id of memberIds()) {
    const admin = isAdmin(id)
    const envAdmin = (process.env.ADMIN_IDS ?? '').split(',').map(x => x.trim()).includes(id)
    lines.push(`- **${userName(id)}** (\`${id}\`)${admin ? ' · ⭐ admin' : ''}`)
    if (envAdmin) continue
    kb.text(`❌ Remove ${userName(id)}`, `us:rm:${id}`)
    kb.text(admin ? '☆ Remove admin' : '⭐ Make admin', `us:${admin ? 'un' : 'ad'}:${id}`).row()
  }
  void s
  return { md: lines.join('\n'), kb }
}
bot.command('users', async ctx => {
  if (!adminGate(ctx)) return
  const v = usersView()
  await sendRich(bot, chatId(ctx), v.md, { reply_markup: v.kb })
})

// --- session commands ------------------------------------------------------------
bot.command('new', async ctx => {
  if (!gate(ctx)) return
  const s = sess(ctx)
  if (s.busy) { await ctx.reply('⏳ agy is working. /stop first, then /new.'); return }
  try { await s.newChat(); await ctx.reply(`🆕 New chat in ${s.cwd}`) } catch (e) { await ctx.reply(`⚠️ ${e instanceof Error ? e.message : e}`) }
})

let resumeLists = new Map<string, { sessionId: string; cwd: string; title?: string }[]>()
bot.command('resume', async ctx => {
  if (!gate(ctx)) return
  const s = sess(ctx)
  if (s.busy) { await ctx.reply('⏳ agy is working. /stop first, then /resume.'); return }
  let list: { sessionId: string; cwd: string; title?: string; updatedAt?: string }[]
  try { list = await s.listChats() } catch (e) { await ctx.reply(`⚠️ ${e instanceof Error ? e.message : e}`); return }
  const all = arg(ctx) === 'all'
  list = list.filter(x => all || x.cwd === s.cwd).slice(0, 15)
  if (!list.length) { await ctx.reply(`No saved chats in ${s.cwd}. Send /resume all for every folder.`); return }
  resumeLists.set(uid(ctx), list)
  const kb = new InlineKeyboard()
  list.forEach((x, i) => {
    const mark = x.sessionId === s.sessionId ? '• ' : mgr.ownerOf(x.sessionId, uid(ctx)) ? '🔒 ' : ''
    const when = x.updatedAt ? ` · ${ago(Date.parse(x.updatedAt))}` : ''
    kb.text(clip(`${mark}${x.title || '(untitled)'}${all ? ` · ${basename(x.cwd)}` : ''}${when}`, 60), `rs:${i}`).row()
  })
  await ctx.reply(`Recent chats ${all ? '(all folders)' : `in ${s.cwd}`}:\n• = current · 🔒 = open in another account`, { reply_markup: kb })
})

bot.command('model', async ctx => {
  if (!gate(ctx)) return
  const s = sess(ctx)
  try { await s.ensure() } catch (e) { await ctx.reply(`⚠️ ${e instanceof Error ? e.message : e}`); return }
  const m = s.config.find(c => c.id === 'model')
  if (!m) { await ctx.reply('agy did not report any models.'); return }
  const want = arg(ctx)
  if (want) {
    const o = m.options.find(x => x.value === want || x.name.toLowerCase().includes(want.toLowerCase()))
    if (!o) { await ctx.reply(`Unknown model. Options: ${m.options.map(x => x.value).join(', ')}`); return }
    await s.setConfig('model', o.value).then(() => ctx.reply(`🧠 Model: ${o.name}`), e => ctx.reply(`⚠️ ${e.message}`))
    return
  }
  const kb = new InlineKeyboard()
  m.options.forEach((o, i) => kb.text(`${o.value === m.currentValue ? '• ' : ''}${o.name}`, `cf:model:${i}`).row())
  await ctx.reply(`Current model: ${modelName(s)}`, { reply_markup: kb })
})

async function configPicker(ctx: Context, id: string, title: string): Promise<void> {
  if (!gate(ctx)) return
  const s = sess(ctx)
  try { await s.ensure() } catch (e) { await ctx.reply(`⚠️ ${e instanceof Error ? e.message : e}`); return }
  const c = s.config.find(x => x.id === id)
  if (!c) { await ctx.reply(`agy did not report a ${title} setting.`); return }
  const want = arg(ctx).toLowerCase()
  if (want) {
    const o = c.options.find(x => x.value === want || x.name.toLowerCase() === want)
    if (!o) { await ctx.reply(`Options: ${c.options.map(x => x.value).join(', ')}`); return }
    await s.setConfig(id, o.value).then(() => ctx.reply(`${title}: ${o.name}`), e => ctx.reply(`⚠️ ${e.message}`))
    return
  }
  const kb = new InlineKeyboard()
  c.options.forEach((o, i) => kb.text(`${o.value === c.currentValue ? '• ' : ''}${o.name}`, `cf:${id}:${i}`))
  await ctx.reply(`${title}: ${c.options.find(o => o.value === c.currentValue)?.name ?? c.currentValue}`, { reply_markup: kb })
}
bot.command(['think', 'effort'], ctx => configPicker(ctx, 'thought_level', '💭 Thinking level'))

bot.command('mode', async ctx => {
  if (!gate(ctx)) return
  const s = sess(ctx)
  try { await s.ensure() } catch (e) { await ctx.reply(`⚠️ ${e instanceof Error ? e.message : e}`); return }
  const c = s.config.find(x => x.id === 'mode')
  const perm = s.state.permission ?? 'request-review'
  const kb = new InlineKeyboard()
  ;(c?.options ?? []).forEach((o, i) => kb.text(`${o.value === c!.currentValue ? '• ' : ''}${o.name}`, `cf:mode:${i}`))
  kb.row()
  PERMISSIONS.forEach((p, i) => { kb.text(`${p.value === perm ? '• ' : ''}${p.label}`, `tp:${i}`); if (i % 2) kb.row() })
  const modeName = c?.options.find(o => o.value === c.currentValue)?.name ?? 'Default'
  await sendRich(bot, chatId(ctx), [
    `**Agent mode:** ${modeName} · **Tool permission:** ${PERMISSIONS.find(p => p.value === perm)?.label ?? perm}`, '',
    '**Agent mode** (first row): *Default* asks per your tool permission · *Accept edits* approves file edits · *Plan* researches and plans without changes.',
    '**Tool permission** (agy\'s setting): *Ask me* · *Turbo* runs every command without asking · *Sandbox* runs commands in a restricted sandbox · *Strict* read-only. Changing it restarts your agy (chat kept).',
  ].join('\n'), { reply_markup: kb })
})
bot.command(['permission', 'turbo'], async ctx => {
  if (!gate(ctx)) return
  const want = arg(ctx).toLowerCase() || (ctx.message?.text?.startsWith('/turbo') ? 'turbo' : '')
  const p = PERMISSIONS.find(x => x.short === want || x.value === want)
  if (!p) { await ctx.reply(`Usage: /permission ask | turbo | sandbox | strict\nNow: ${sess(ctx).state.permission ?? 'request-review'}`); return }
  await setPermission(ctx, p.value)
})
async function setPermission(ctx: Context, value: string): Promise<void> {
  const s = sess(ctx)
  const p = PERMISSIONS.find(x => x.value === value)!
  if ((s.state.permission ?? 'request-review') === value) { await ctx.reply(`Already: ${p.label}`); return }
  if (s.busy) { await ctx.reply('⏳ agy is working. /stop first.'); return }
  saveAccount(uid(ctx), { permission: value })
  await ctx.reply(`${p.label}: restarting your agy (chat kept)…`)
  try { await s.restart(); await ctx.reply(`✅ Tool permission: ${p.label}`) } catch (e) { await ctx.reply(`⚠️ ${e instanceof Error ? e.message : e}`) }
}

function listProjects(): string[] {
  const out: string[] = []
  for (const root of PROJECT_ROOTS) {
    try {
      for (const d of readdirSync(root)) {
        if (d.startsWith('.')) continue
        const p = join(root, d)
        try { if (statSync(p).isDirectory()) out.push(p) } catch {}
      }
    } catch {}
  }
  return out.sort().slice(0, 30)
}
let projectLists = new Map<string, string[]>()
async function switchProject(ctx: Context, dir: string): Promise<void> {
  const s = sess(ctx)
  if (s.busy) { await ctx.reply('⏳ agy is working. /stop first.'); return }
  try {
    await s.ensure()
    await s.newChat(dir)
    await ctx.reply(`📁 ${dir}\nNew chat started there. /resume lists older chats in this folder.`)
  } catch (e) { await ctx.reply(`⚠️ ${e instanceof Error ? e.message : e}`) }
}
bot.command('project', async ctx => {
  if (!gate(ctx)) return
  const a = arg(ctx)
  if (a) {
    let dir = ''
    try { dir = realpathSync(a); if (!statSync(dir).isDirectory()) dir = '' } catch {}
    if (!dir) { await ctx.reply(`Not a folder: ${a}`); return }
    await switchProject(ctx, dir)
    return
  }
  const list = listProjects()
  projectLists.set(uid(ctx), list)
  const cur = sess(ctx).cwd || loadAccount(uid(ctx)).cwd
  const kb = new InlineKeyboard()
  list.forEach((p, i) => kb.text(`${p === cur ? '• ' : ''}${p}`, `pj:${i}`).row())
  await ctx.reply(`Current folder: ${cur}\nPick one, or send /project <path>:`, { reply_markup: kb })
})

bot.command('stop', async ctx => {
  if (!gate(ctx)) return
  const ok = await sess(ctx).cancel()
  await ctx.reply(ok ? '⏹ Stopped.' : 'Nothing is running.')
})
bot.use(async (ctx, next) => {
  // The Stop button Telegram shows under a streaming draft.
  const st = (ctx.update as any).stopped_message_generation
  if (!st) return next()
  const id = String(st.chat?.id ?? '')
  if (!isMember(id)) return
  await mgr.get(id).cancel()
})

bot.command('restart', async ctx => {
  if (!gate(ctx)) return
  await ctx.reply('♻️ Restarting your agy process (your chat is kept)…')
  try { await sess(ctx).restart(); await ctx.reply('✅ agy is running again.') } catch (e) { await ctx.reply(`⚠️ ${e instanceof Error ? e.message : e}`) }
})

bot.command('steps', async ctx => {
  if (!gate(ctx)) return
  const s = sess(ctx)
  const steps = s.turn?.steps.length ? s.turn.steps : s.lastSteps
  if (!steps.length) { await ctx.reply('No steps yet. They appear once agy runs a command or opens a file.'); return }
  const shown = steps.slice(-30)
  const md = `**🔧 ${s.turn ? 'Current' : 'Last'} turn: ${steps.length} step${steps.length > 1 ? 's' : ''}** · tap one to open\n\n${stepsMd(shown, 25000, steps.length - shown.length)}`
  const full = steps.map((st, i) => `#${i + 1} ${st.label} [${st.status}]\n--- input ---\n${st.input}\n--- output ---\n${st.output ?? '(running…)'}\n`).join('\n')
  await sendRich(bot, chatId(ctx), md)
  if (steps.length > 30 || steps.some(st => st.input.length > 600 || (st.output?.length ?? 0) > 800)) {
    mkdirSync(OUT, { recursive: true })
    const p = join(OUT, `${Date.now()}-steps.txt`)
    writeFileSync(p, full)
    await bot.api.sendDocument(chatId(ctx), new InputFile(p, 'steps.txt'), { caption: 'Full inputs and outputs' }).catch(() => {})
  }
})

bot.command('diff', async ctx => {
  if (!gate(ctx)) return
  const cwd = sess(ctx).cwd || loadAccount(uid(ctx)).cwd
  const stat = await run('git', ['diff', 'HEAD', '--stat'], cwd)
  if (stat.code !== 0) { await ctx.reply(`Not a git repository: ${cwd}`); return }
  const diff = (await run('git', ['diff', 'HEAD'], cwd)).out
  const untracked = (await run('git', ['ls-files', '--others', '--exclude-standard'], cwd)).out.trim()
  if (!diff.trim() && !untracked) { await ctx.reply(`No uncommitted changes in ${cwd}.`); return }
  const md = `**📝 Changes in \`${cwd}\`**\n\n${fence(stat.out.trim() || '(only untracked files)')}${untracked ? `\n\n**Untracked:**\n${fence(clip(untracked, 1500))}` : ''}${diff.length <= 3000 && diff.trim() ? `\n\n${fence(diff.trim(), 'diff')}` : ''}`
  await sendRich(bot, chatId(ctx), md)
  if (diff.length > 3000) {
    mkdirSync(OUT, { recursive: true })
    const p = join(OUT, `${Date.now()}-changes.diff`)
    writeFileSync(p, diff)
    await bot.api.sendDocument(chatId(ctx), new InputFile(p, 'changes.diff')).catch(() => {})
  }
})

bot.command('status', async ctx => {
  if (!gate(ctx)) return
  const s = sess(ctx)
  const st = s.state
  const think = s.config.find(c => c.id === 'thought_level')?.currentValue ?? st.thought ?? ''
  const mode = `${s.config.find(c => c.id === 'mode')?.currentValue ?? st.mode ?? 'default'} · tools: ${PERMISSIONS.find(p => p.value === (st.permission ?? 'request-review'))?.label}`
  let rss = ''
  if (s.acp?.pid) { const r = await run('ps', ['-o', 'rss=', '-p', String(s.acp.pid)], '/'); rss = r.code === 0 ? ` · ${Math.round(Number(r.out.trim()) / 1024)} MB` : '' }
  await sendRich(bot, chatId(ctx), [
    '## 📊 Status', '',
    '| | |', '|:--|:--|',
    `| agy | ${s.running ? (s.busy ? '⏳ working' : '🟢 idle') : '⚪ stopped (starts on your next message)'}${rss} |`,
    `| Folder | \`${s.cwd || st.cwd}\` |`,
    `| Chat | ${s.title || (st.sessionId ? `\`${st.sessionId.slice(0, 8)}\`` : '(new)')} |`,
    `| Model | ${modelName(s)} |`,
    `| Thinking | ${think || 'default'} |`,
    `| Mode | ${mode} |`,
    `| Live progress | ${st.live === false ? 'off' : 'on'} |`,
    `| Tokens this run | ${s.tokens.input.toLocaleString()} in · ${s.tokens.output.toLocaleString()} out · ${s.tokens.turns} turns |`,
  ].join('\n'))
})
bot.command('usage', async ctx => {
  if (!gate(ctx)) return
  const s = sess(ctx)
  await ctx.reply(`Tokens since your agy process started: ${s.tokens.input.toLocaleString()} input, ${s.tokens.output.toLocaleString()} output, ${s.tokens.turns} turns.\nagy has no plan-usage API; check quotas in the Antigravity app.`)
})

bot.command('sessions', async ctx => {
  if (!gate(ctx)) return
  const me = uid(ctx)
  const icon = (s: AgentSession) => s.busy ? '⏳ working' : '🟢 idle'
  const lines = [`## 🖥 agy sessions · ${mgr.running().length} of ${mgr.maxSessions()} running`, '']
  const kb = new InlineKeyboard()
  for (const s of mgr.running()) {
    lines.push(`- **${userName(s.account)}${s.account === me ? ' (you)' : ''}** · ${icon(s)}${s.lastUsed ? ` · last message ${ago(s.lastUsed)}` : ''}  \n  📁 \`${s.cwd}\` · 💬 ${s.title || '(new chat)'} · ${modelName(s)}`)
    if (s.account === me || isAdmin(me)) kb.text(`⏹ Stop ${s.account === me ? 'mine' : userName(s.account)}`, `ss:${s.account}`).row()
  }
  if (!mgr.running().length) lines.push('_None running. A session starts on an account\'s next message._')
  lines.push('', `_A stopped session keeps its chat and starts again on that account's next message. When a new one is needed at the limit, the one idle longest is stopped._`)
  await sendRich(bot, chatId(ctx), lines.join('\n'), { reply_markup: kb })
})

bot.command('live', async ctx => {
  if (!gate(ctx)) return
  const on = loadAccount(uid(ctx)).live === false
  saveAccount(uid(ctx), { live: on })
  await ctx.reply(on ? '🟢 Live progress is on.' : '⚪ Live progress is off. You only get the final reply.')
})

// agy's own CLI management commands, run as `agy <sub> <args>`.
async function agyCli(ctx: Context, sub: string[], title: string): Promise<void> {
  if (!gate(ctx)) return
  const extra = arg(ctx) ? arg(ctx).split(/\s+/) : []
  const r = await run(AGY_BIN, [...sub, ...extra], sess(ctx).cwd || loadAccount(uid(ctx)).cwd, 60_000)
  const body = r.out.trim() || '(no output)'
  await sendLong(chatId(ctx), `**${title}**${r.code ? ` · exit ${r.code}` : ''}\n\n${fence(clip(body, 3200, true))}`, body, `${sub[0]}.txt`)
}
bot.command('mcp', ctx => agyCli(ctx, ['mcp', ...(arg(ctx) ? [] : ['list'])], '🔌 agy mcp'))
bot.command('plugins', ctx => agyCli(ctx, ['plugin', ...(arg(ctx) ? [] : ['list'])], '🧩 agy plugins'))
bot.command('agents', ctx => agyCli(ctx, ['agents'], '🤖 agy agents'))
bot.command('models', ctx => agyCli(ctx, ['models'], '🧠 agy models'))
bot.command('changelog', ctx => agyCli(ctx, ['changelog'], '📰 agy changelog'))

bot.command('config', async ctx => {
  if (!gate(ctx)) return
  let cur: any = {}
  try { cur = JSON.parse(readFileSync(AGY_SETTINGS, 'utf8')) } catch {}
  const a = arg(ctx)
  if (!a) {
    await sendRich(bot, chatId(ctx), `**⚙️ agy settings** (\`${AGY_SETTINGS}\`)\n\n${fence(JSON.stringify(cur, null, 2), 'json')}\n\nChange one: \`/config <key> <json value>\`, for example \`/config theme "dark"\`. Remove one: \`/config <key> -\`. Takes effect after /restart.`)
    return
  }
  if (!isAdmin(uid(ctx))) { await ctx.reply('🔒 Only an admin can change agy settings (they are shared by all accounts).'); return }
  const m = /^([\w.-]+)\s+([\s\S]+)$/.exec(a)
  if (!m) { await ctx.reply('Usage: /config <key> <json value>'); return }
  if (m[2]!.trim() === '-') delete cur[m[1]!]
  else {
    try { cur[m[1]!] = JSON.parse(m[2]!) } catch { cur[m[1]!] = m[2]! }
  }
  mkdirSync(join(AGY_SETTINGS, '..'), { recursive: true })
  writeFileSync(AGY_SETTINGS, JSON.stringify(cur, null, 2) + '\n')
  await ctx.reply(`✅ Saved. /restart to apply it to your session.`)
})

bot.command('shell', async ctx => {
  if (!adminGate(ctx)) return
  const a = arg(ctx).toLowerCase()
  if (a !== 'on' && a !== 'off') { await ctx.reply(`! shell commands are ${loadShared().shell === false ? 'off' : 'on'}. Send /shell on or /shell off.`); return }
  saveShared({ ...loadShared(), shell: a === 'on' })
  await ctx.reply(`! shell commands are now ${a}.`)
})

bot.command('help', async ctx => {
  if (!gate(ctx)) return
  const s = sess(ctx)
  const agyCmds = s.commands.length ? s.commands.map(c => `/${c.name}`).join(' ') : '(send a message first to load them)'
  await sendRich(bot, chatId(ctx), [
    '## Antigravity on Telegram',
    'Messages go to **your own agy session** on the server (each account has its own, like separate terminals). Photos are sent as images; files are saved and their path passed on.',
    '',
    '**Chat:** /new · /resume (`/resume all` for every folder) · /stop (or the Stop button) · /project',
    '**agy settings:** /model · /think (thinking level) · /mode (agent mode + tool permission) · /turbo · /permission ask|turbo|sandbox|strict · /config · /restart',
    '**agy tools:** /mcp · /plugins · /agents · /models · /changelog (add arguments to pass them on, e.g. `/mcp disable github`)',
    '**See what happened:** /steps · /diff · /status · /usage · /sessions · /live',
    '**Shell:** `!git status` runs directly on the server',
    `**agy's own commands** (sent to agy as typed): ${agyCmds}`,
    '**Admin:** /invite · /users · /shell on|off',
  ].join('\n'))
})

// --- buttons ---------------------------------------------------------------------------
bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data
  const me = uid(ctx)
  if (!isMember(me)) { await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {}); return }
  const s = mgr.get(me)
  const done = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
  const clearKb = () => ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
  let m: RegExpExecArray | null

  if ((m = /^pm:([0-9a-f]{6}):(\d+)$/.exec(data))) {
    const r = s.answerPermission(m[1]!, Number(m[2]))
    if (!r) { await done('Already answered or expired.'); await clearKb(); return }
    await done(r.name)
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text(`${/deny|reject/i.test(r.name) ? '❌' : '✅'} ${r.name} · ${displayName(ctx.from)}`, 'noop') }).catch(() => {})
    return
  }
  if ((m = /^cf:(\w+):(\d+)$/.exec(data))) {
    await done(); await clearKb()
    try {
      await s.ensure()
      const c = s.config.find(x => x.id === m![1])
      const o = c?.options[Number(m[2])]
      if (!c || !o) { await ctx.reply('That option is gone. Send the command again.'); return }
      await s.setConfig(c.id, o.value)
      await ctx.reply(`${c.name}: ${o.name}`)
    } catch (e) { await ctx.reply(`⚠️ ${e instanceof Error ? e.message : e}`) }
    return
  }
  if ((m = /^tp:(\d+)$/.exec(data))) {
    const p = PERMISSIONS[Number(m[1])]
    await done(); await clearKb()
    if (p) await setPermission(ctx, p.value)
    return
  }
  if ((m = /^rs:(\d+)$/.exec(data))) {
    const x = resumeLists.get(me)?.[Number(m[1])]
    if (!x) { await done('List expired. Send /resume again.'); return }
    if (x.sessionId === s.sessionId) { await done('Already in this chat.'); return }
    const owner = mgr.ownerOf(x.sessionId, me)
    if (owner) { await done('🔒 Open in another account'); await ctx.reply(`🔒 That chat is open in ${userName(owner)}'s session. A chat can only run in one place at a time.`); return }
    if (s.busy) { await done('agy is working. /stop first.'); return }
    await done(); await clearKb()
    try {
      await s.ensure()
      const last = await s.open(x.sessionId, x.cwd)
      const prev = last && (last.user || last.agent)
        ? `\n\n**Last exchange**\n\n> **You:** ${clip(last.user.trim().replace(/\n+/g, ' '), 400)}\n\n**agy:** ${clip(last.agent.trim(), 1500)}` : ''
      await sendRich(bot, chatId(ctx), `↩️ **Resumed:** ${x.title || x.sessionId}\n📁 \`${x.cwd}\`${prev}`)
    } catch (e) { await ctx.reply(`⚠️ ${e instanceof Error ? e.message : e}`) }
    return
  }
  if ((m = /^pj:(\d+)$/.exec(data))) {
    const p = projectLists.get(me)?.[Number(m[1])]
    await done(); await clearKb()
    if (!p) { await ctx.reply('List expired. Send /project again.'); return }
    await switchProject(ctx, p)
    return
  }
  if ((m = /^ss:(\d+)$/.exec(data))) {
    const target = m[1]!
    if (target !== me && !isAdmin(me)) { await done('You can only stop your own session.'); return }
    await done(); await clearKb()
    const t = mgr.get(target)
    if (t.busy) await t.cancel()
    t.stop()
    await ctx.reply(`⏹ Stopped ${target === me ? 'your' : `${userName(target)}'s`} agy session. The chat is kept; it starts again on the next message.`)
    if (target !== me) await bot.api.sendMessage(target, `⏹ ${displayName(ctx.from)} stopped your agy session (your chat is kept; it starts again on your next message).`).catch(() => {})
    return
  }
  if ((m = /^us:(rm|ad|un):(\d+)$/.exec(data))) {
    if (!isAdmin(me)) { await done('Admins only.'); return }
    const [, op, id] = m
    const sh = loadShared()
    if (op === 'rm') {
      if (sh.users) delete sh.users[id!]
      sh.admins = (sh.admins ?? []).filter(a => a !== id)
      mgr.get(id!).stop()
    } else if (op === 'ad') sh.admins = [...new Set([...(sh.admins ?? []), id!])]
    else sh.admins = (sh.admins ?? []).filter(a => a !== id)
    saveShared(sh)
    await done('Saved')
    const v = usersView()
    await ctx.editMessageReplyMarkup({ reply_markup: v.kb }).catch(() => {})
    return
  }
  await done()
})

// --- messages ----------------------------------------------------------------------------
async function runShell(ctx: Context, cmd: string): Promise<void> {
  if (loadShared().shell === false) { await ctx.reply('! shell commands are turned off (admin: /shell on).'); return }
  const cwd = sess(ctx).cwd || loadAccount(uid(ctx)).cwd
  appendFileSync(SHELL_LOG, `${new Date().toISOString()} ${uid(ctx)} ${displayName(ctx.from)} [${cwd}] ${cmd}\n`)
  void bot.api.sendChatAction(chatId(ctx), 'typing').catch(() => {})
  const r = await run('bash', ['-lc', cmd], cwd, 120_000)
  const body = r.out.trim() || '(no output)'
  await sendLong(chatId(ctx), `${r.code === 0 ? '✅' : `❌ exit ${r.code}`} \`${clip(cmd, 100)}\`\n\n${fence(clip(body, 3200, true))}`, body, 'output.txt')
}

async function download(fileId: string, name?: string): Promise<{ path: string; buf: Buffer }> {
  const f = await bot.api.getFile(fileId)
  if (!f.file_path) throw new Error('Telegram returned no file path')
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  mkdirSync(INBOX, { recursive: true })
  const safe = (name ?? basename(f.file_path)).replace(/[^\w.\-]+/g, '_')
  const path = join(INBOX, `${Date.now()}-${safe}`)
  writeFileSync(path, buf)
  return { path, buf }
}

bot.on('message', async ctx => {
  if (!gate(ctx)) return
  const msg = ctx.message
  const chat = chatId(ctx)
  let text = msg.text ?? msg.caption ?? ''
  if (msg.text?.startsWith('!') && msg.text.length > 1) { await runShell(ctx, msg.text.slice(1).trim()); return }
  // Unknown /commands (agy's own: /goal, /compact, /plan …) go to agy as typed.
  if (botUsername) text = text.replace(new RegExp(`^(/[\\w-]+)@${botUsername}\\b`, 'i'), '$1')
  const blocks: any[] = []
  try {
    if (msg.photo?.length) {
      const p = msg.photo[msg.photo.length - 1]!
      const { buf } = await download(p.file_id, 'photo.jpg')
      blocks.push({ type: 'image', mimeType: 'image/jpeg', data: buf.toString('base64') })
    } else if (msg.document || msg.video || msg.audio || msg.voice) {
      const d: any = msg.document ?? msg.video ?? msg.audio ?? msg.voice
      if (d.file_size && d.file_size > 20 * 1024 * 1024) { await ctx.reply('That file is over 20 MB, the limit for bots. Put it on the server another way.'); return }
      const { path } = await download(d.file_id, d.file_name)
      text = `${text}\n\n[The user sent a file, saved on the server at: ${path}]`.trim()
    }
  } catch (e) { await ctx.reply(`⚠️ Couldn't download the attachment: ${e instanceof Error ? e.message : e}`); return }
  if (msg.reply_to_message && 'text' in msg.reply_to_message && msg.reply_to_message.text) {
    text = `[Replying to: "${clip(msg.reply_to_message.text, 500)}"]\n\n${text}`
  }
  if (text.trim()) blocks.push({ type: 'text', text })
  if (!blocks.length) return
  // Don't await: grammY handles updates one at a time, and the turn may wait for a button press.
  void mgr.get(uid(ctx)).prompt(chat, blocks).catch(e => log('prompt failed', e))
})

// --- command menu ------------------------------------------------------------------------
const BOT_COMMANDS = [
  ['new', 'Start a new chat'], ['resume', 'Open a previous chat'], ['stop', 'Stop what agy is doing'],
  ['model', 'Choose the model'], ['think', 'Thinking level (low/medium/high)'], ['mode', 'Agent mode and tool permission (turbo)'], ['turbo', 'Run commands without asking'],
  ['project', 'Switch folder'], ['steps', 'Steps of the last turn, with outputs'], ['diff', 'Uncommitted changes'],
  ['status', 'Folder, model, mode, chat'], ['sessions', 'Who is running what'], ['mcp', 'agy MCP servers'],
  ['plugins', 'agy plugins'], ['agents', 'agy agents'], ['config', 'agy settings'], ['restart', 'Restart your agy process'],
  ['live', 'Toggle live progress'], ['usage', 'Token usage'], ['users', 'Manage accounts (admin)'],
  ['invite', 'Invite another account (admin)'], ['help', 'All commands'],
].map(([command, description]) => ({ command: command!, description: description! }))
const menuSent = new Map<string, string>()
mgr.onCommands = s => {
  // Add agy's own commands to this account's / menu.
  const ours = new Set(BOT_COMMANDS.map(c => c.command))
  const extra = s.commands
    .filter(c => /^[a-z0-9_]{1,32}$/.test(c.name) && !ours.has(c.name))
    .map(c => ({ command: c.name, description: `agy: ${clip(c.description || c.name, 240)}` }))
  const all = [...BOT_COMMANDS, ...extra].slice(0, 100)
  const key = JSON.stringify(all)
  if (menuSent.get(s.account) === key) return
  menuSent.set(s.account, key)
  void bot.api.setMyCommands(all, { scope: { type: 'chat', chat_id: Number(s.account) } }).catch(e => log('setMyCommands', e))
}

// --- start --------------------------------------------------------------------------------
bot.catch(err => log('handler error:', err.error))
function shutdown(): void {
  for (const s of mgr.sessions.values()) s.stop()
  void bot.stop()
  setTimeout(() => process.exit(0), 1500)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
if (!existsSync(AGY_BIN)) log(`warning: agy not found at ${AGY_BIN} (set AGY_BIN)`)

for (let attempt = 1; ; attempt++) {
  try {
    await bot.start({
      drop_pending_updates: false,
      onStart: info => {
        attempt = 0
        botUsername = info.username
        log(`polling as @${info.username}`)
        void bot.api.setMyCommands(BOT_COMMANDS, { scope: { type: 'all_private_chats' } }).catch(e => log('setMyCommands', e))
      },
    })
    break
  } catch (e) {
    const delay = Math.min(1000 * attempt, 15000)
    log(`polling error: ${e}; retrying in ${delay / 1000}s`)
    await Bun.sleep(delay)
  }
}
