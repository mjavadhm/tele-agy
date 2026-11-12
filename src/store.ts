// Persistent state in ./data (gitignored): shared bot state and one file per account.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
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
}
export type AccountState = {
  cwd: string
  sessionId?: string
  model?: string
  thought?: string
  mode?: string
  permission?: string // agy toolPermission: request-review | always-proceed (turbo) | proceed-in-sandbox | strict-mode
  live?: boolean
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
const accPath = (id: string) => join(DATA, 'accounts', `${id}.json`)
export const loadAccount = (id: string): AccountState => readJson<AccountState>(accPath(id), { cwd: DEFAULT_CWD, live: true })
export function saveAccount(id: string, patch: Partial<AccountState>): AccountState {
  const s = { ...loadAccount(id), ...patch }
  writeJson(accPath(id), s)
  return s
}

export function adminIds(): string[] {
  const env = (process.env.ADMIN_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return [...new Set([...env, ...(loadShared().admins ?? [])])]
}
export const isAdmin = (id: string) => adminIds().includes(id)
export const isMember = (id: string) => isAdmin(id) || Boolean(loadShared().users?.[id])
export const memberIds = () => [...new Set([...adminIds(), ...Object.keys(loadShared().users ?? {})])]
