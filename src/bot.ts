// agy-telegram: use Google's Antigravity CLI (agy) from Telegram.
// Each allowed account gets its own `agy acp` process and chat (like separate terminals on the
// same machine). With topics turned on for the bot, each topic is its own chat. Replies stream live; tool steps, plans and permission prompts appear in Telegram.
import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy'
import { execFile } from 'child_process'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync, appendFileSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { sendRich, fence, clip, threadOpt, type Dest } from './rich.ts'
import { SessionManager, AgentSession, stepsMd, AGY_BIN, PERMISSIONS, screenAnsi } from './session.ts'
import { runTuiCommand } from './tui.ts'
import { initCards, routeQuery } from './cards/kit.ts'
import { parseQuota, quotaMd, rememberQuota, sendUsageCard, registerUsage } from './cards/usage.ts'
import { registerLive } from './cards/live.ts'
import { sendStatusCard, registerStatus } from './cards/status.ts'
import { diffList, sendDiffCard, registerDiff } from './cards/diff.ts'
import { scan, older, remove, human, summary } from './cleanup.ts'
import { userMessages } from './import.ts'
import { parseArgs, createProject, NEWPROJECT_HELP, PROJECTS_BASE } from './newproject.ts'
import {
  DATA, ROOT, loadShared, saveShared, loadAccount, saveAccount, deleteAccount, topicKeys, keyOf, adminIds, isAdmin, isMember, memberIds,
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
const PROJECT_ROOTS = (process.env.PROJECT_ROOTS ?? `${homedir()}:${process.env.PROJECTS_BASE ?? '/root/project'}`).split(':')
const INBOX = join(DATA, 'inbox')
const OUT = join(DATA, 'out')
const SHELL_LOG = join(DATA, 'shell.log')
const AGY_SETTINGS = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')
const log = (...a: unknown[]) => console.error(new Date().toISOString(), ...a)

const API_ROOT = (process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org').replace(/\/+$/, '')
const MAX_FILE_BYTES = (API_ROOT.includes('api.telegram.org') ? 20 : 2000) * 1024 * 1024
const bot = new Bot(TOKEN, API_ROOT !== 'https://api.telegram.org' ? { client: { apiRoot: API_ROOT } } : undefined)
const mgr = new SessionManager(bot)
let botUsername = ''
let topicsOn = false // forum topic mode in private chats (a @BotFather setting), read from getMe

// --- helpers ---------------------------------------------------------------------
const uid = (ctx: Context) => String(ctx.from?.id ?? '')
const chatId = (ctx: Context) => String(ctx.chat?.id ?? '')
/** The topic a message or pressed button belongs to, if any. */
const threadOf = (ctx: Context): number | undefined => ctx.msg?.is_topic_message ? ctx.msg.message_thread_id : undefined
const keyFor = (ctx: Context) => keyOf(uid(ctx), threadOf(ctx))
const dest = (ctx: Context): Dest => ({ chat_id: chatId(ctx), thread: threadOf(ctx) })
const topicLink = (thread: number) => `https://t.me/${botUsername}/${thread}`
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
async function sendLong(d: Dest, md: string, full: string, filename: string): Promise<void> {
  await sendRich(bot, d, md)
  if (full.length <= 3200) return
  mkdirSync(OUT, { recursive: true })
  const path = join(OUT, `${Date.now()}-${filename}`)
  writeFileSync(path, full)
  await bot.api.sendDocument(d.chat_id, new InputFile(path, filename), threadOpt(d)).catch(() => {})
}
function run(cmd: string, args: string[], cwd: string, timeout = 120_000): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } }, (err: any, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ? (stdout ? '\n' : '') + stderr : ''}`.split('\n').filter(l => !/logging before google\.Init/.test(l)).join('\n')
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out })
    })
  })
}
const sess = (ctx: Context) => mgr.get(keyFor(ctx))
const modelName = (s: AgentSession) => s.modelName

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
  await sendRich(bot, dest(ctx), v.md, { reply_markup: v.kb })
})

// --- topics: one chat per topic ---------------------------------------------------
// Topic names are "<project folder> - <chat title>"; the title comes from agy after the first reply.
const topicName = (cwd: string, title?: string) => clip(`${basename(cwd) || cwd} - ${title?.trim() || 'new chat'}`, 120)
// Topic icons: Telegram allows a fixed set of emoji (getForumTopicIconStickers), no photos. Every
// topic of one project gets the same icon: the one picked with /icon, else one chosen by its name.
const ICONS: [string, string][] = [
  ['💻', '5350554349074391003'], ['🤖', '5309832892262654231'], ['⚡️', '5312016608254762256'], ['💡', '5312536423851630001'],
  ['🔥', '5312241539987020022'], ['💎', '5309958691854754293'], ['🧠', '5237889595894414384'], ['🧪', '5411138633765757782'],
  ['🔬', '5377580546748588396'], ['🔭', '5368585403467048206'], ['🎮', '5309950797704865693'], ['🎨', '5310039132297242441'],
  ['📱', '5409357944619802453'], ['📈', '5350305691942788490'], ['💰', '5350452584119279096'], ['🛒', '5431492767249342908'],
  ['📚', '5350481781306958339'], ['📝', '5373251851074415873'], ['📁', '5357315181649076022'], ['🔎', '5309965701241379366'],
  ['💬', '5417915203100613993'], ['🎵', '5310045076531978942'], ['🎬', '5368653135101310687'], ['🏆', '5312315739842026755'],
  ['⭐️', '5235579393115438657'], ['🦄', '5413625003218313783'], ['🔮', '5350367161514732241'], ['✈️', '5348436127038579546'],
  ['🏠', '5312486108309757006'], ['☕️', '5350392020785437399'], ['🧮', '5355127101970194557'], ['👑', '5357107601584693888'],
]
function iconFor(cwd: string): string {
  const chosen = loadShared().icons?.[cwd]
  if (chosen) return chosen
  let h = 0
  for (const c of basename(cwd) || cwd) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return ICONS[h % ICONS.length]![1]
}
/** Bring a topic's name and icon in line with its project and chat title. */
function syncTopic(key: string, cwd: string, title: string): void {
  const [account, th] = key.split(':')
  if (!th) return
  const st = loadAccount(key)
  const name = st.manualName ? st.topicName : topicName(cwd, title)
  const icon = iconFor(cwd)
  if (st.topicName === name && st.icon === icon) return
  saveAccount(key, { topicName: name, icon })
  void bot.api.editForumTopic(Number(account), Number(th), { ...(name && name !== st.topicName ? { name } : {}), icon_custom_emoji_id: icon })
    .catch(e => log(`edit topic ${key}: ${e}`))
}
mgr.onRename = s => syncTopic(s.key, s.cwd || s.state.cwd, s.title)
/** The key (main chat or topic) of this account that holds the given agy chat, if any. */
function boundKey(account: string, sessionId: string): string | null {
  for (const k of [account, ...topicKeys(account)]) if (loadAccount(k).sessionId === sessionId) return k
  return null
}
const whereIs = (key: string) => {
  const th = Number(key.split(':')[1] ?? 0)
  return th ? `the topic “${loadAccount(key).topicName ?? th}”: ${topicLink(th)}` : 'the main chat (outside topics)'
}
/** Create a topic for a new chat in `cwd`, or for an existing agy chat. */
async function openTopic(ctx: Context, cwd: string, chat?: { sessionId: string; title?: string }, imported = false): Promise<void> {
  const account = uid(ctx)
  const from = loadAccount(keyFor(ctx))
  const name = topicName(cwd, chat?.title)
  const icon = iconFor(cwd)
  const t = await bot.api.createForumTopic(Number(account), name, { icon_custom_emoji_id: icon })
  const thread = t.message_thread_id
  const key = keyOf(account, thread)
  saveAccount(key, {
    cwd, sessionId: chat?.sessionId, title: chat?.title, topicName: name, icon,
    model: from.model, thought: from.thought, mode: from.mode, permission: from.permission, live: from.live,
  })
  const d: Dest = { chat_id: account, thread }
  if (chat && imported) {
    // Many at once: don't start agy for each. It opens the chat on the first message here.
    await sendRich(bot, d, `📥 **${chat.title || chat.sessionId}**\n📁 \`${cwd}\`\n\nThis is an earlier agy chat. Send a message here to continue it.`)
    return
  }
  if (!chat) await sendRich(bot, d, `🆕 **New chat** in \`${cwd}\`\nSend a message here to start. agy starts on your first message.`)
  else {
    // Start agy now so the topic shows where the chat left off.
    try {
      const s = mgr.get(key)
      await s.ensure()
      const last = s.replay
      const prev = last.user || last.agent
        ? `\n\n**Last exchange**\n\n> **You:** ${clip(last.user.trim().replace(/\n+/g, ' '), 400)}\n\n**agy:** ${clip(last.agent.trim(), 1500)}` : ''
      await sendRich(bot, d, `↩️ **Resumed:** ${chat.title || chat.sessionId}\n📁 \`${cwd}\`${prev}`)
    } catch (e) {
      await sendRich(bot, d, `↩️ **${chat.title || chat.sessionId}**\n📁 \`${cwd}\`\n\n⚠️ ${e instanceof Error ? e.message : e}\nThe chat opens on your next message here.`)
    }
  }
  await ctx.reply(`➡️ Opened in a new topic: ${name}\n${topicLink(thread)}`)
}
bot.command('topics', async ctx => {
  if (!gate(ctx)) return
  if (!topicsOn) { await ctx.reply('Topics are off for this bot. Turn on topic mode for it in @BotFather, then /restart bot.'); return }
  const keys = topicKeys(uid(ctx))
  if (!keys.length) { await ctx.reply('No topics yet. /new, /resume, /project and /newproject each open one, or create a topic yourself and write in it.'); return }
  const lines = ['## 🗂 Your topics', '']
  const kb = new InlineKeyboard()
  for (const k of keys) {
    const st = loadAccount(k)
    const th = Number(k.split(':')[1])
    const s = mgr.sessions.get(k)
    const name = st.topicName ?? `topic ${th}`
    lines.push(`- [${name}](${topicLink(th)}) · ${s?.running ? (s.busy ? '⏳ working' : '🟢 idle') : '⚪ stopped'}  \n  📁 \`${st.cwd}\``)
    kb.text(clip(`🗑 ${name}`, 60), `td:${th}`).row()
  }
  lines.push('', '_🗑 deletes the topic and its messages in Telegram. The agy chat itself is kept and /resume can open it again._')
  await sendRich(bot, dest(ctx), lines.join('\n'), { reply_markup: kb })
})
bot.command('icon', async ctx => {
  if (!gate(ctx)) return
  if (!topicsOn) { await ctx.reply('Topics are off for this bot.'); return }
  const cwd = sess(ctx).cwd || loadAccount(keyFor(ctx)).cwd
  const cur = iconFor(cwd)
  const kb = new InlineKeyboard()
  ICONS.forEach(([e, id], i) => { kb.text(id === cur ? `[${e}]` : e, `ic:${i}`); if (i % 8 === 7) kb.row() })
  await ctx.reply(`Icon for the topics of ${basename(cwd) || cwd} (now ${ICONS.find(x => x[1] === cur)?.[0] ?? 'custom'}). Pick one:`, { reply_markup: kb })
})

bot.command('import', async ctx => {
  if (!gate(ctx)) return
  if (!topicsOn) { await ctx.reply('Topics are off for this bot. Turn on topic mode for it in @BotFather, then /restart bot.'); return }
  const a = arg(ctx)
  const min = a ? Number(a) : 4
  if (!Number.isInteger(min) || min < 1) { await ctx.reply('Usage: /import [n]\nMakes a topic for every saved agy chat in which you sent at least n messages (default 4, i.e. more than 3).'); return }
  const me = uid(ctx)
  const s = sess(ctx)
  let list: { sessionId: string; cwd: string; title?: string; updatedAt?: string }[]
  try { list = await s.listChats() } catch (e) { await ctx.reply(`⚠️ ${e instanceof Error ? e.message : e}`); return }
  let have = 0, short = 0, unreadable = 0, locked = 0
  const todo: typeof list = []
  for (const x of list) {
    const n = userMessages(x.sessionId)
    if (boundKey(me, x.sessionId)) have++
    else if (n < 0) unreadable++
    else if (n < min) short++
    else if (mgr.ownerOf(x.sessionId, s.key)) locked++
    else todo.push(x)
  }
  // Oldest first, so the most recent chat ends up as the newest topic.
  todo.sort((p, q) => Date.parse(p.updatedAt ?? '') - Date.parse(q.updatedAt ?? ''))
  const batch = todo.slice(-25)
  let made = 0
  const failed: string[] = []
  for (const x of batch) {
    try { await openTopic(ctx, x.cwd, x, true); made++ } catch (e) { failed.push(`${x.title || x.sessionId}: ${e instanceof Error ? e.message : e}`) }
    await Bun.sleep(400) // stay under Telegram's rate limit
  }
  const lines = [`📥 Made ${made} topic${made === 1 ? '' : 's'} from ${list.length} saved agy chat${list.length === 1 ? '' : 's'}.`]
  if (have) lines.push(`• ${have} already in a topic or the main chat`)
  if (short) lines.push(`• ${short} skipped: fewer than ${min} messages from you (/import ${Math.max(1, min - 1)} lowers the limit)`)
  if (locked) lines.push(`• ${locked} skipped: open in another account right now`)
  if (unreadable) lines.push(`• ${unreadable} skipped: couldn't read the chat's file`)
  if (todo.length > batch.length) lines.push(`• ${todo.length - batch.length} more waiting: send /import again`)
  if (failed.length) lines.push('', '⚠️ Failed:', ...failed.slice(0, 5))
  if (made) lines.push('', 'agy starts for a topic when you write in it. /topics lists them.')
  await ctx.reply(lines.join('\n'))
})

// --- session commands ------------------------------------------------------------
bot.command('new', async ctx => {
  if (!gate(ctx)) return
  const s = sess(ctx)
  try {
    if (topicsOn) { await openTopic(ctx, s.cwd || s.state.cwd); return }
    if (s.busy) { await ctx.reply('⏳ agy is working. /stop first, then /new.'); return }
    await s.newChat(); await ctx.reply(`🆕 New chat in ${s.cwd}`)
  } catch (e) { await ctx.reply(`⚠️ ${e instanceof Error ? e.message : e}`) }
})

let resumeLists = new Map<string, { sessionId: string; cwd: string; title?: string }[]>()
bot.command('resume', async ctx => {
  if (!gate(ctx)) return
  const s = sess(ctx)
  if (s.busy && !topicsOn) { await ctx.reply('⏳ agy is working. /stop first, then /resume.'); return }
  let list: { sessionId: string; cwd: string; title?: string; updatedAt?: string }[]
  try { list = await s.listChats() } catch (e) { await ctx.reply(`⚠️ ${e instanceof Error ? e.message : e}`); return }
  const all = arg(ctx) === 'all'
  list = list.filter(x => all || x.cwd === s.cwd).slice(0, 15)
  const me = uid(ctx)
  if (!list.length) { await ctx.reply(`No saved chats in ${s.cwd}. Send /resume all for every folder.`); return }
  resumeLists.set(uid(ctx), list)
  const kb = new InlineKeyboard()
  list.forEach((x, i) => {
    const owner = mgr.ownerOf(x.sessionId, s.key)
    const mark = x.sessionId === s.sessionId ? '• ' : owner && owner.split(':')[0] !== me ? '🔒 ' : boundKey(me, x.sessionId) ? '📌 ' : ''
    const when = x.updatedAt ? ` · ${ago(Date.parse(x.updatedAt))}` : ''
    kb.text(clip(`${mark}${x.title || '(untitled)'}${all ? ` · ${basename(x.cwd)}` : ''}${when}`, 60), `rs:${i}`).row()
  })
  await ctx.reply(`Recent chats ${all ? '(all folders)' : `in ${s.cwd}`}:\n• = current · 🔒 = open in another account${topicsOn ? ' · 📌 = already in one of your topics\nPicking one opens it in its own topic.' : ''}`, { reply_markup: kb })
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
  await sendRich(bot, dest(ctx), [
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
  saveAccount(keyFor(ctx), { permission: value })
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
  if (topicsOn) {
    try { await openTopic(ctx, dir) } catch (e) { await ctx.reply(`⚠️ ${e instanceof Error ? e.message : e}`) }
    return
  }
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
  const cur = sess(ctx).cwd || loadAccount(keyFor(ctx)).cwd
  const kb = new InlineKeyboard()
  list.forEach((p, i) => kb.text(`${p === cur ? '• ' : ''}${p}`, `pj:${i}`).row())
  await ctx.reply(`Current folder: ${cur}\nPick one, or send /project <path>:`, { reply_markup: kb })
})

bot.command('newproject', async ctx => {
  if (!gate(ctx)) return
  const a = parseArgs(arg(ctx))
  if (a === 'usage') { await sendRich(bot, dest(ctx), NEWPROJECT_HELP); return }
  if (typeof a === 'string') { await ctx.reply(a); return }
  if (sess(ctx).busy && !topicsOn) { await ctx.reply('⏳ agy is working. /stop first.'); return }
  void bot.api.sendChatAction(chatId(ctx), 'typing', threadOpt(dest(ctx))).catch(() => {})
  try {
    const p = await createProject(a.target, a.remote)
    await sendRich(bot, dest(ctx), `📁 **${p.dir}**\n${p.report}`)
    await switchProject(ctx, p.dir)
  } catch (e) { await ctx.reply(`⚠️ ${e instanceof Error ? e.message : e}`) }
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
  await mgr.get(keyOf(id, st.message_thread_id)).cancel()
})

bot.command('restart', async ctx => {
  if (!gate(ctx)) return
  const what = arg(ctx).toLowerCase()
  if (what && !isAdmin(uid(ctx))) { await ctx.reply('🔒 Only an admin can restart other sessions or bots. /restart alone restarts your own agy.'); return }
  if (!what || what === 'me') {
    await ctx.reply('♻️ Restarting your agy process (your chat is kept)…')
    try { await sess(ctx).restart(); await ctx.reply('✅ agy is running again.') } catch (e) { await ctx.reply(`⚠️ ${e instanceof Error ? e.message : e}`) }
  } else if (what === 'all') {
    const list = mgr.running()
    await ctx.reply(`♻️ Restarting ${list.length} agy process${list.length === 1 ? '' : 'es'}…`)
    for (const s of list) await s.restart().catch(e => log('restart', s.key, e))
    await ctx.reply('✅ Done.')
  } else if (what === 'bot') {
    await ctx.reply('♻️ Restarting the Antigravity bot. Back in a few seconds; agy starts again on your next message.')
    setTimeout(() => process.exit(0), 500) // systemd (Restart=always) starts it again
  } else if (what === 'claude') {
    // The Claude bot's router listens on a unix socket; restart every running Claude session.
    try {
      const sock = '/root/claude-telegram/run/router.sock'
      const r: any = await (await fetch('http://router/sessions', { unix: sock } as any)).json()
      for (const x of r.sessions ?? []) await fetch(`http://router/restart/${x.id}`, { method: 'POST', unix: sock } as any)
      await ctx.reply(`♻️ Restarting ${r.sessions?.length ?? 0} Claude session(s).`)
    } catch (e) { await ctx.reply(`⚠️ Couldn't reach the Claude bot's router: ${e instanceof Error ? e.message : e}`) }
  } else {
    await ctx.reply('Usage:\n/restart — your agy\nAdmin: /restart all · /restart bot · /restart claude (the Claude bot\'s sessions)')
  }
})

bot.command('steps', async ctx => {
  if (!gate(ctx)) return
  const s = sess(ctx)
  const steps = s.turn?.steps.length ? s.turn.steps : s.lastSteps
  if (!steps.length) { await ctx.reply('No steps yet. They appear once agy runs a command or opens a file.'); return }
  const shown = steps.slice(-30)
  const md = `**🔧 ${s.turn ? 'Current' : 'Last'} turn: ${steps.length} step${steps.length > 1 ? 's' : ''}** · tap one to open\n\n${stepsMd(shown, 25000, steps.length - shown.length)}`
  const full = steps.map((st, i) => `#${i + 1} ${st.label} [${st.status}]\n--- input ---\n${st.input}\n--- output ---\n${st.output ?? '(running…)'}\n`).join('\n')
  await sendRich(bot, dest(ctx), md)
  if (steps.length > 30 || steps.some(st => st.input.length > 600 || (st.output?.length ?? 0) > 800)) {
    mkdirSync(OUT, { recursive: true })
    const p = join(OUT, `${Date.now()}-steps.txt`)
    writeFileSync(p, full)
    await bot.api.sendDocument(chatId(ctx), new InputFile(p, 'steps.txt'), { caption: 'Full inputs and outputs', ...threadOpt(dest(ctx)) }).catch(() => {})
  }
})

bot.command('diff', async ctx => {
  if (!gate(ctx)) return
  const cwd = sess(ctx).cwd || loadAccount(keyFor(ctx)).cwd
  const d = await diffList(cwd)
  if (!d) { await ctx.reply(`Not a git repository: ${cwd}`); return }
  if (!d.files.length) { await ctx.reply(`No uncommitted changes in ${cwd}.`); return }
  if (await sendDiffCard(dest(ctx), keyFor(ctx), d).then(() => true, e => { log('diff card failed, sending text', e); return false })) return
  await diffText(ctx)
})
bot.command('legacy_diff', async ctx => { if (gate(ctx)) await diffText(ctx) })
async function diffText(ctx: Context): Promise<void> {
  const cwd = sess(ctx).cwd || loadAccount(keyFor(ctx)).cwd
  const stat = await run('git', ['diff', 'HEAD', '--stat'], cwd)
  if (stat.code !== 0) { await ctx.reply(`Not a git repository: ${cwd}`); return }
  const diff = (await run('git', ['diff', 'HEAD'], cwd)).out
  const untracked = (await run('git', ['ls-files', '--others', '--exclude-standard'], cwd)).out.trim()
  if (!diff.trim() && !untracked) { await ctx.reply(`No uncommitted changes in ${cwd}.`); return }
  const md = `**📝 Changes in \`${cwd}\`**\n\n${fence(stat.out.trim() || '(only untracked files)')}${untracked ? `\n\n**Untracked:**\n${fence(clip(untracked, 1500))}` : ''}${diff.length <= 3000 && diff.trim() ? `\n\n${fence(diff.trim(), 'diff')}` : ''}`
  await sendRich(bot, dest(ctx), md)
  if (diff.length > 3000) {
    mkdirSync(OUT, { recursive: true })
    const p = join(OUT, `${Date.now()}-changes.diff`)
    writeFileSync(p, diff)
    await bot.api.sendDocument(chatId(ctx), new InputFile(p, 'changes.diff'), threadOpt(dest(ctx))).catch(() => {})
  }
}

bot.command('status', async ctx => {
  if (!gate(ctx)) return
  const s = sess(ctx)
  if (await sendStatusCard(dest(ctx), s).then(() => true, e => { log('status card failed, sending text', e); return false })) return
  await statusText(ctx)
})
bot.command('legacy_status', async ctx => { if (gate(ctx)) await statusText(ctx) })
async function statusText(ctx: Context): Promise<void> {
  const s = sess(ctx)
  const st = s.state
  const think = s.config.find(c => c.id === 'thought_level')?.currentValue ?? st.thought ?? ''
  const mode = `${s.config.find(c => c.id === 'mode')?.currentValue ?? st.mode ?? 'default'} · tools: ${PERMISSIONS.find(p => p.value === (st.permission ?? 'request-review'))?.label}`
  let rss = ''
  if (s.acp?.pid) { const r = await run('ps', ['-o', 'rss=', '-p', String(s.acp.pid)], '/'); rss = r.code === 0 ? ` · ${Math.round(Number(r.out.trim()) / 1024)} MB` : '' }
  await sendRich(bot, dest(ctx), [
    '## 📊 Status', '',
    '| | |', '|:--|:--|',
    `| agy | ${s.running ? (s.busy ? '⏳ working' : '🟢 idle') : '⚪ stopped (starts on your next message)'}${rss} |`,
    `| Folder | \`${s.cwd || st.cwd}\` |`,
    `| Chat | ${s.title || (st.sessionId ? `\`${st.sessionId.slice(0, 8)}\`` : '(new)')} |`,
    `| Model | ${modelName(s)} |`,
    `| Thinking | ${think || 'default'} |`,
    `| Mode | ${mode} |`,
    `| Live progress | ${st.live === false ? 'off' : st.live === 'widget' ? 'card' : 'on'} |`,
    `| Tokens this run | ${s.tokens.input.toLocaleString()} in · ${s.tokens.output.toLocaleString()} out · ${s.tokens.turns} turns |`,
  ].join('\n'))
}
// --- agy terminal-only commands (/usage, /credits, /skills …), via a hidden agy terminal ------
// Cards (Telegram widgets, see src/cards/): taps on them arrive as widget_query updates.
initCards(bot)
registerUsage(mgr); registerLive(mgr); registerStatus(mgr); registerDiff()
bot.use(async (ctx, next) => {
  const q = (ctx.update as any).widget_query
  if (!q) return next()
  // Not awaited: grammy handles updates one at a time; answers are quick, slow work runs after them.
  void routeQuery(q, isMember).catch(e => log('widget query', e))
})
async function tuiCommand(ctx: Context, cmd: string, title: string, legacy = false): Promise<void> {
  if (!gate(ctx)) return
  void bot.api.sendChatAction(chatId(ctx), 'typing', threadOpt(dest(ctx))).catch(() => {})
  try {
    const r = await runTuiCommand(cmd)
    const body = r.text.trim() || '(no output)'
    if (cmd === '/usage') {
      const s = sess(ctx)
      const q = parseQuota(body)
      if (q) {
        rememberQuota(q)
        if (!legacy && await sendUsageCard(dest(ctx), keyFor(ctx), q).then(() => true, e => { log('usage card failed, sending text', e); return false })) return
        await sendRich(bot, dest(ctx), quotaMd(q, `${s.tokens.input.toLocaleString()} input · ${s.tokens.output.toLocaleString()} output tokens in ${s.tokens.turns} turns`))
        return
      }
    }
    await sendLong(dest(ctx), `**${title}**\n\n${fence(clip(body, 3200, true))}`, body, `${cmd.slice(1)}.txt`)
  } catch (e) { await ctx.reply(`⚠️ ${cmd}: ${e instanceof Error ? e.message : e}`) }
}
bot.command(['usage', 'quota'], ctx => tuiCommand(ctx, '/usage', '📊 agy usage'))
bot.command('legacy_usage', ctx => tuiCommand(ctx, '/usage', '📊 agy usage', true))
bot.command('credits', ctx => tuiCommand(ctx, '/credits', '💳 agy credits'))
bot.command('skills', ctx => tuiCommand(ctx, '/skills', '🧠 agy skills'))
bot.command('tui', async ctx => {
  const a = arg(ctx)
  if (!/^\/?[\w-]+( .*)?$/.test(a)) { await ctx.reply('Usage: /tui <agy terminal command>, e.g. /tui /hooks. Runs it in a fresh agy terminal (not your chat) and sends what it shows.'); return }
  await tuiCommand(ctx, a.startsWith('/') ? a : `/${a}`, `agy ${a}`)
})

// --- /screen: terminal-style screenshot of your session --------------------------------------
async function screenshot(s: AgentSession): Promise<{ png?: Buffer; err?: string; ansi: string }> {
  const ansi = screenAnsi(s)
  try {
    const { renderScreen } = await import('./screen.ts')
    return { png: renderScreen(ansi).png, ansi }
  } catch (e) { return { err: e instanceof Error ? e.message : String(e), ansi } }
}
const screenKb = () => new InlineKeyboard().text('🔄 Refresh', 'sc:refresh')
const screenCaption = (s: AgentSession) => `${s.busy ? '⏳ working' : s.running ? '🟢 idle' : '⚪ stopped'} · ${s.cwd || s.state.cwd} · ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`
bot.command('screen', async ctx => {
  if (!gate(ctx)) return
  const s = sess(ctx)
  const r = await screenshot(s)
  if (!r.png) { await ctx.reply(`Couldn't draw the screenshot (${r.err}).`); return }
  await bot.api.sendPhoto(chatId(ctx), new InputFile(r.png, 'screen.png'), { caption: screenCaption(s), reply_markup: screenKb(), ...threadOpt(dest(ctx)) })
})

bot.command('sessions', async ctx => {
  if (!gate(ctx)) return
  const me = uid(ctx)
  const icon = (s: AgentSession) => s.busy ? '⏳ working' : '🟢 idle'
  const lines = [`## 🖥 agy sessions · ${mgr.running().length} of ${mgr.maxSessions()} running`, '']
  const kb = new InlineKeyboard()
  for (const s of mgr.running()) {
    const topic = s.thread ? ` · 🗂 ${s.state.topicName ?? `topic ${s.thread}`}` : ''
    lines.push(`- **${userName(s.account)}${s.account === me ? ' (you)' : ''}**${topic} · ${icon(s)}${s.lastUsed ? ` · last message ${ago(s.lastUsed)}` : ''}  \n  📁 \`${s.cwd}\` · 💬 ${s.title || '(new chat)'} · ${modelName(s)}`)
    if (s.account === me || isAdmin(me)) kb.text(clip(`⏹ Stop ${s.account === me ? 'mine' : userName(s.account)}${s.thread ? `: ${s.state.topicName ?? s.thread}` : ''}`, 60), `ss:${s.key}`).row()
  }
  if (!mgr.running().length) lines.push('_None running. A session starts on an account\'s next message._')
  lines.push('', `_A stopped session keeps its chat and starts again on the next message in that chat or topic. When a new one is needed at the limit, the one idle longest is stopped._`)
  await sendRich(bot, dest(ctx), lines.join('\n'), { reply_markup: kb })
})

const LIVE_MODES = { off: false, on: true, widget: 'widget' } as const
const LIVE_TEXT: Record<string, string> = {
  off: '⚪ Live progress is off. You only get the final reply.',
  on: '🟢 Live progress is on: a streaming text draft while agy works.',
  widget: '🃏 Live progress is a card: one live run card per turn (timer, current step, counters, Stop), then the reply.',
}
const liveName = (v: boolean | 'widget' | undefined) => v === false ? 'off' : v === 'widget' ? 'widget' : 'on'
bot.command('live', async ctx => {
  if (!gate(ctx)) return
  const want = arg(ctx).toLowerCase().replace(/^card$/, 'widget')
  if (want in LIVE_MODES) {
    saveAccount(keyFor(ctx), { live: LIVE_MODES[want as keyof typeof LIVE_MODES] })
    await ctx.reply(LIVE_TEXT[want]!)
    return
  }
  const cur = liveName(loadAccount(keyFor(ctx)).live)
  const kb = new InlineKeyboard()
  for (const [k, label] of [['off', '⚪ Off'], ['on', '🟢 On (text)'], ['widget', '🃏 Card']] as const) kb.text(`${k === cur ? '• ' : ''}${label}`, `lv:${k}`)
  await ctx.reply(`Live progress: ${cur === 'widget' ? 'card' : cur}. Choose, or send /live off · /live on · /live widget.`, { reply_markup: kb })
})

// agy's own CLI management commands, run as `agy <sub> <args>`.
async function agyCli(ctx: Context, sub: string[], title: string): Promise<void> {
  if (!gate(ctx)) return
  const extra = arg(ctx) ? arg(ctx).split(/\s+/) : []
  const r = await run(AGY_BIN, [...sub, ...extra], sess(ctx).cwd || loadAccount(keyFor(ctx)).cwd, 60_000)
  const body = r.out.trim() || '(no output)'
  await sendLong(dest(ctx), `**${title}**${r.code ? ` · exit ${r.code}` : ''}\n\n${fence(clip(body, 3200, true))}`, body, `${sub[0]}.txt`)
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
    await sendRich(bot, dest(ctx), `**⚙️ agy settings** (\`${AGY_SETTINGS}\`)\n\n${fence(JSON.stringify(cur, null, 2), 'json')}\n\nChange one: \`/config <key> <json value>\`, for example \`/config theme "dark"\`. Remove one: \`/config <key> -\`. Takes effect after /restart.`)
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

bot.command('cleanup', async ctx => {
  if (!adminGate(ctx)) return
  const all = scan([INBOX, OUT])
  const kb = new InlineKeyboard()
  if (all.length) kb.text('🗑 Delete all', 'cl:all').text('Older than 7 days', 'cl:7').row().text('Cancel', 'cl:no')
  await ctx.reply(summary([INBOX, OUT]), all.length ? { reply_markup: kb } : undefined)
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
  await sendRich(bot, dest(ctx), [
    '## Antigravity on Telegram',
    'Messages go to **your own agy session** on the server (each account has its own, like separate terminals). Photos are sent as images; files are saved and their path passed on.',
    '',
    '**Chat:** /new · /resume (`/resume all` for every folder) · /stop (or the Stop button) · /project · /newproject',
    ...(topicsOn ? ['**Topics:** each topic is its own chat, named `project - chat title`. /new, /resume, /project and /newproject open a new topic; /topics lists and deletes them; /import makes a topic for each earlier agy chat with more than 3 messages from you (`/import 1` for all). Topics of one project share an icon; /icon changes it. Rename a topic yourself and the bot leaves the name alone.'] : []),
    '**agy settings:** /model · /think (thinking level) · /mode (agent mode + tool permission) · /turbo · /permission ask|turbo|sandbox|strict · /config · /restart',
    '**agy tools:** /mcp · /plugins · /agents · /models · /changelog (add arguments to pass them on, e.g. `/mcp disable github`)',
    '**See what happened:** /screen · /steps · /diff (card; /legacy_diff as text) · /status (control panel; /legacy_status as text) · /sessions · /live off|on|widget',
    '**agy account:** /usage (quota card; /legacy_usage as text) · /credits · /skills · /tui <any agy terminal command>',
    '**Shell:** `!git status` runs directly on the server',
    `**agy's own commands** (sent to agy as typed): ${agyCmds}`,
    '**Admin:** /invite · /users · /shell on|off · /cleanup (delete saved voice messages, photos and files)',
  ].join('\n'))
})

// --- buttons ---------------------------------------------------------------------------
bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data
  const me = uid(ctx)
  if (!isMember(me)) { await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {}); return }
  const s = mgr.get(keyFor(ctx))
  const done = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {})
  const clearKb = () => ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
  let m: RegExpExecArray | null

  if ((m = /^cl:(all|7|no)$/.exec(data))) {
    if (!isAdmin(me)) { await done('Admins only.'); return }
    await done(); await clearKb()
    if (m[1] === 'no') { await ctx.reply('OK, nothing deleted.'); return }
    const all = scan([INBOX, OUT])
    const r = remove(m[1] === 'all' ? all : older(all, 7))
    await ctx.reply(`🧹 Deleted ${r.count} file${r.count === 1 ? '' : 's'}, freed ${human(r.bytes)}.`)
    return
  }
  if (data === 'sc:refresh') {
    const r = await screenshot(s)
    if (!r.png) { await done(`Couldn't draw: ${r.err}`); return }
    await ctx.editMessageMedia({ type: 'photo', media: new InputFile(r.png, 'screen.png'), caption: screenCaption(s) }, { reply_markup: screenKb() })
      .then(() => done('Updated'), () => done('No change'))
    return
  }
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
  if ((m = /^lv:(off|on|widget)$/.exec(data))) {
    await done(); await clearKb()
    saveAccount(keyFor(ctx), { live: LIVE_MODES[m[1] as keyof typeof LIVE_MODES] })
    await ctx.reply(LIVE_TEXT[m[1]!]!)
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
    const owner = mgr.ownerOf(x.sessionId, s.key)
    if (owner && owner.split(':')[0] !== me) { await done('🔒 Open in another account'); await ctx.reply(`🔒 That chat is open in ${userName(owner.split(':')[0]!)}'s session. A chat can only run in one place at a time.`); return }
    const bound = boundKey(me, x.sessionId)
    if (bound) { await done(); await ctx.reply(`📌 That chat is already in ${whereIs(bound)}`); return }
    if (topicsOn) {
      await done(); await clearKb()
      try { await openTopic(ctx, x.cwd, x) } catch (e) { await ctx.reply(`⚠️ ${e instanceof Error ? e.message : e}`) }
      return
    }
    if (s.busy) { await done('agy is working. /stop first.'); return }
    await done(); await clearKb()
    try {
      await s.ensure()
      const last = await s.open(x.sessionId, x.cwd, x.title)
      const prev = last && (last.user || last.agent)
        ? `\n\n**Last exchange**\n\n> **You:** ${clip(last.user.trim().replace(/\n+/g, ' '), 400)}\n\n**agy:** ${clip(last.agent.trim(), 1500)}` : ''
      await sendRich(bot, dest(ctx), `↩️ **Resumed:** ${x.title || x.sessionId}\n📁 \`${x.cwd}\`${prev}`)
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
  if ((m = /^ic:(\d+)$/.exec(data))) {
    const pick = ICONS[Number(m[1])]
    if (!pick) { await done(); return }
    const cwd = s.cwd || s.state.cwd
    const sh = loadShared()
    saveShared({ ...sh, icons: { ...(sh.icons ?? {}), [cwd]: pick[1] } })
    await done(pick[0]); await clearKb()
    // Every topic of this project, for every account, follows.
    let n = 0
    for (const acc of memberIds()) for (const k of topicKeys(acc)) {
      const st = loadAccount(k)
      if (st.cwd === cwd) { syncTopic(k, cwd, st.title ?? ''); n++ }
    }
    await ctx.reply(`${pick[0]} is now the icon for ${basename(cwd) || cwd} (${n} topic${n === 1 ? '' : 's'} updated; new ones get it too).`)
    return
  }
  if ((m = /^td:(\d+)$/.exec(data))) {
    const th = Number(m[1])
    const key = keyOf(me, th)
    await done(); await clearKb()
    const t = mgr.sessions.get(key)
    if (t?.busy) await t.cancel()
    mgr.drop(key)
    const name = loadAccount(key).topicName ?? `topic ${th}`
    deleteAccount(key)
    const err = await bot.api.deleteForumTopic(Number(me), th).then(() => '', e => String(e))
    const text = err && !/not found|TOPIC_ID_INVALID/i.test(err) ? `⚠️ Removed “${name}” here, but Telegram didn't delete the topic: ${err}` : `🗑 Deleted the topic “${name}”. Its agy chat is kept; /resume can open it again.`
    // If the button was inside the deleted topic, answer in the main chat.
    await bot.api.sendMessage(me, text, threadOf(ctx) === th ? {} : threadOpt(dest(ctx))).catch(() => {})
    return
  }
  if ((m = /^ss:(\d+(?::\d+)?)$/.exec(data))) {
    const t = mgr.sessions.get(m[1]!)
    const target = m[1]!.split(':')[0]!
    if (target !== me && !isAdmin(me)) { await done('You can only stop your own session.'); return }
    await done(); await clearKb()
    if (!t) { await ctx.reply('That session is not running any more.'); return }
    if (t.busy) await t.cancel()
    t.stop()
    await ctx.reply(`⏹ Stopped ${target === me ? 'your' : `${userName(target)}'s`} agy session. The chat is kept; it starts again on the next message.`)
    if (target !== me) await sendRich(bot, t.dest, `⏹ ${displayName(ctx.from)} stopped your agy session (your chat is kept; it starts again on your next message).`).catch(() => {})
    return
  }
  if ((m = /^us:(rm|ad|un):(\d+)$/.exec(data))) {
    if (!isAdmin(me)) { await done('Admins only.'); return }
    const [, op, id] = m
    const sh = loadShared()
    if (op === 'rm') {
      if (sh.users) delete sh.users[id!]
      sh.admins = (sh.admins ?? []).filter(a => a !== id)
      for (const x of mgr.ofAccount(id!)) mgr.drop(x.key)
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
  const cwd = sess(ctx).cwd || loadAccount(keyFor(ctx)).cwd
  appendFileSync(SHELL_LOG, `${new Date().toISOString()} ${uid(ctx)} ${displayName(ctx.from)} [${cwd}] ${cmd}\n`)
  void bot.api.sendChatAction(chatId(ctx), 'typing', threadOpt(dest(ctx))).catch(() => {})
  const r = await run('bash', ['-lc', cmd], cwd, 120_000)
  const body = r.out.trim() || '(no output)'
  await sendLong(dest(ctx), `${r.code === 0 ? '✅' : `❌ exit ${r.code}`} \`${clip(cmd, 100)}\`\n\n${fence(clip(body, 3200, true))}`, body, 'output.txt')
}

async function download(fileId: string, name?: string): Promise<{ path: string; buf: Buffer }> {
  log(`downloading file_id: ${fileId}`)
  const f = await bot.api.getFile(fileId)
  log(`getFile result:`, f)
  if (!f.file_path) throw new Error('Telegram returned no file path')
  let buf: Buffer
  if (existsSync(f.file_path)) {
    buf = readFileSync(f.file_path)
  } else {
    const res = await fetch(`${API_ROOT}/file/bot${TOKEN}/${f.file_path}`)
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    buf = Buffer.from(await res.arrayBuffer())
  }
  mkdirSync(INBOX, { recursive: true })
  const safe = (name ?? basename(f.file_path)).replace(/[^\w.\-]+/g, '_')
  const path = join(INBOX, `${Date.now()}-${safe}`)
  writeFileSync(path, buf)
  log(`saved attachment to: ${path} (${buf.length} bytes)`)
  return { path, buf }
}

bot.on('message', async ctx => {
  if (!gate(ctx)) return
  const msg = ctx.message
  // Topic service messages: remember a name the user chose, so we don't rename over it.
  if (msg.forum_topic_created) {
    if (!msg.forum_topic_created.is_name_implicit && msg.message_thread_id) saveAccount(keyOf(uid(ctx), msg.message_thread_id), { topicName: msg.forum_topic_created.name, manualName: true })
    return
  }
  if (msg.forum_topic_edited) {
    const name = msg.forum_topic_edited.name
    const key = keyOf(uid(ctx), msg.message_thread_id)
    if (name && msg.message_thread_id && msg.from?.id !== ctx.me.id && loadAccount(key).topicName !== name) saveAccount(key, { topicName: name, manualName: true })
    return
  }
  if (msg.forum_topic_closed || msg.forum_topic_reopened) return
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
      log(`incoming attachment: name=${d.file_name}, size=${d.file_size}, mime=${d.mime_type}`)
      if (d.file_size && d.file_size > MAX_FILE_BYTES) {
        const limitMb = Math.round(MAX_FILE_BYTES / (1024 * 1024))
        log(`attachment rejected: file_size ${d.file_size} > MAX_FILE_BYTES ${MAX_FILE_BYTES}`)
        await ctx.reply(`That file is over ${limitMb} MB, the limit for bots. Put it on the server another way.`); return
      }
      const { path } = await download(d.file_id, d.file_name ?? (msg.voice ? 'voice.oga' : undefined))
      text = msg.voice || msg.audio
        ? `${text}\n\n[The user sent a ${msg.voice ? 'voice message' : 'audio file'}, saved at: ${path}. Listen to it (open the file). Start your reply with what you heard, word for word in the language spoken, as a quote line beginning with "🎤", so they can check you heard correctly. Then treat what they said as their request and answer in the language they speak.]`.trim()
        : `${text}\n\n[The user sent a file, saved on the server at: ${path}]`.trim()
    }
  } catch (e) {
    log('download error:', e)
    await ctx.reply(`⚠️ Couldn't download the attachment: ${e instanceof Error ? e.message : e}`); return
  }
  if (msg.reply_to_message && 'text' in msg.reply_to_message && msg.reply_to_message.text) {
    text = `[Replying to: "${clip(msg.reply_to_message.text, 500)}"]\n\n${text}`
  }
  if (text.trim()) {
    const hint = '\n\n[Telegram Integration: You can send files mid-task using `tg send-file <path>` or [send_file: /path]. You can set a custom reaction using `tg react <emoji>` or [react: <emoji>]. You can send intermediate messages with `tg send "<text>"`.]'
    blocks.push({ type: 'text', text: text + hint })
  }
  if (!blocks.length) return
  if (msg.message_id) {
    try {
      writeFileSync('/tmp/tg-current.json', JSON.stringify({
        chat_id: chatId(ctx),
        thread: threadOf(ctx),
        msg_id: msg.message_id,
        api_root: API_ROOT,
        token: TOKEN,
      }))
    } catch {}
  }
  // Don't await: grammY handles updates one at a time, and the turn may wait for a button press.
  void sess(ctx).prompt(blocks, msg.message_id).catch(e => log('prompt failed', e))
})

// --- command menu ------------------------------------------------------------------------
const BOT_COMMANDS = [
  ['new', 'Start a new chat'], ['resume', 'Open a previous chat'], ['stop', 'Stop what agy is doing'],
  ['model', 'Choose the model'], ['think', 'Thinking level (low/medium/high)'], ['mode', 'Agent mode and tool permission (turbo)'], ['turbo', 'Run commands without asking'],
  ['project', 'Switch folder'], ['newproject', 'Create a project (optionally from a git repo)'], ['steps', 'Steps of the last turn, with outputs'], ['diff', 'Uncommitted changes (tap a file)'], ['legacy_diff', 'Uncommitted changes as text'],
  ['status', 'Control panel: model, thinking, mode, tools, live'], ['legacy_status', 'Status as text'], ['sessions', 'Who is running what'], ['topics', 'Your topics (one chat each)'], ['import', 'Make topics from your earlier agy chats'], ['icon', 'Choose the icon for this project\'s topics'], ['mcp', 'agy MCP servers'],
  ['plugins', 'agy plugins'], ['agents', 'agy agents'], ['config', 'agy settings'], ['restart', 'Restart your agy (admin: all, bot, claude)'],
  ['live', 'Live progress: off, on (text) or widget (card)'], ['usage', 'agy quota (5-hour and weekly limits)'], ['legacy_usage', 'agy quota as text'], ['screen', 'Terminal-style screenshot'], ['credits', 'agy credits'], ['skills', 'agy skills'], ['users', 'Manage accounts (admin)'],
  ['invite', 'Invite another account (admin)'], ['cleanup', 'Delete saved files (admin)'], ['help', 'All commands'],
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
        topicsOn = Boolean(info.has_topics_enabled)
        log(`polling as @${info.username}${topicsOn ? ' (topics on: one chat per topic)' : ''}`)
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
