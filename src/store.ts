// Persistent state in ./data (gitignored): shared bot state and one file per account.
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'

export const ROOT = join(import.meta.dir, '..')
export const DATA = process.env.AGY_TG_DATA ?? join(ROOT, 'data')
mkdirSync(join(DATA, 'accounts'), { recursive: true })

export type Shared = {
  admins?: string[]
  users?: Record<string, { name: string; addedBy?: string; addedAt?: string }>
  invites?: Record<string, { by: string; exp: number }>
  shell?: boolean
  maxSessions?: number
  icons?: Record<string, string> // project folder -> topic icon (custom emoji id) chosen with /icon
}
export type AccountState = {
  cwd: string
  sessionId?: string
  model?: string
  thought?: string
  mode?: string
  permission?: string // agy toolPermission: request-review | always-proceed (turbo) | proceed-in-sandbox | strict-mode
  live?: boolean
  title?: string // agy's title of the open chat
  topicName?: string // the Telegram topic's name as we last set it
  manualName?: boolean // the user renamed the topic; don't rename it again
  icon?: string // the topic's icon (custom emoji id) as we last set it
}

function readJson<T>(path: string, d: T): T {
  try { return { ...d, ...JSON.parse(readFileSync(path, 'utf8')) } } catch { return d }
}
function writeJson(path: string, v: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n')
  renameSync(tmp, path)
}

const SHARED = join(DATA, 'state.json')
export const loadShared = (): Shared => readJson<Shared>(SHARED, {})
export const saveShared = (s: Shared) => writeJson(SHARED, s)

export const DEFAULT_CWD = process.env.DEFAULT_CWD ?? process.env.HOME ?? '/root'
// A session key is "<account>" (the chat outside any topic) or "<account>:<thread>" (one topic).
export const keyOf = (account: string, thread?: number) => thread ? `${account}:${thread}` : account
export const splitKey = (key: string): { account: string; thread?: number } => {
  const [account, th] = key.split(':')
  return { account: account!, thread: th ? Number(th) : undefined }
}
const accPath = (key: string) => join(DATA, 'accounts', `${key.replace(':', '.t')}.json`)
export function loadAccount(key: string): AccountState {
  const { account, thread } = splitKey(key)
  if (!thread) return readJson<AccountState>(accPath(key), { cwd: DEFAULT_CWD, live: true })
  // A topic starts from the account's folder and preferences, with its own chat.
  const { sessionId: _s, title: _t, topicName: _n, manualName: _m, icon: _i, ...base } = loadAccount(account)
  return readJson<AccountState>(accPath(key), base)
}
export function saveAccount(key: string, patch: Partial<AccountState>): AccountState {
  const s = { ...loadAccount(key), ...patch }
  writeJson(accPath(key), s)
  return s
}
export function deleteAccount(key: string): void { try { rmSync(accPath(key)) } catch {} }
/** Keys of the topics this account has saved state for. */
export function topicKeys(account: string): string[] {
  try {
    return readdirSync(join(DATA, 'accounts'))
      .map(f => new RegExp(`^${account}\\.t(\\d+)\\.json$`).exec(f)?.[1])
      .filter((x): x is string => Boolean(x))
      .map(th => `${account}:${th}`)
  } catch { return [] }
}

export function adminIds(): string[] {
  const env = (process.env.ADMIN_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return [...new Set([...env, ...(loadShared().admins ?? [])])]
}
export const isAdmin = (id: string) => adminIds().includes(id)
export const isMember = (id: string) => isAdmin(id) || Boolean(loadShared().users?.[id])
export const memberIds = () => [...new Set([...adminIds(), ...Object.keys(loadShared().users ?? {})])]
