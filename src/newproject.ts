// /newproject: create a project folder (default under /root/project), optionally from a git remote.
import { execFile } from 'child_process'
import { existsSync, mkdirSync, readdirSync } from 'fs'
import { join, basename, resolve } from 'path'

export const PROJECTS_BASE = process.env.PROJECTS_BASE ?? '/root/project'
const URL_RE = /^(https?:\/\/\S+|git@[\w.-]+:\S+|ssh:\/\/\S+|[\w.-]+\.\w+\/[\w.-]+\/[\w.-]+(\.git)?)$/

function run(cmd: string, args: string[], cwd: string, timeout = 300_000): Promise<{ code: number; out: string }> {
  return new Promise(res => execFile(cmd, args, { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err: any, so, se) =>
    res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${so ?? ''}${se ?? ''}`.trim() })))
}

export type NewProject = { dir: string; report: string }

/** Parse "<name|/abs/path> [remote]" or just "<remote>". */
export function parseArgs(text: string): { target: string; remote: string } | string {
  const parts = text.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'usage'
  let target = '', remote = ''
  for (const p of parts) {
    if (URL_RE.test(p) && !p.startsWith('/')) remote = /^[\w.-]+\.\w+\//.test(p) && !/^https?:/.test(p) ? `https://${p}` : p
    else if (!target) target = p
    else return `Too many arguments: ${p}`
  }
  if (!target && remote) target = basename(remote.replace(/\.git$/, '').replace(/\/+$/, ''))
  if (!target) return 'usage'
  if (!target.startsWith('/') && !/^[\w.-]+$/.test(target)) return 'Project names can only use letters, digits, ".", "-" and "_". Or give a full path like /srv/app.'
  return { target, remote }
}

export async function createProject(target: string, remote: string): Promise<NewProject> {
  const dir = target.startsWith('/') ? resolve(target) : join(PROJECTS_BASE, target)
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} already exists and is not empty. Use /project ${dir} to switch to it.`)
  mkdirSync(join(dir, '..'), { recursive: true })
  const lines: string[] = []
  if (remote) {
    const gh = /github\.com[/:]/.test(remote)
    // gh uses the server's GitHub login, so private repos work too.
    let r = gh ? await run('gh', ['repo', 'clone', remote, dir], join(dir, '..')) : { code: 1, out: '' }
    if (r.code !== 0) r = await run('git', ['clone', remote, dir], join(dir, '..'))
    if (r.code !== 0) throw new Error(`Couldn't clone ${remote}:\n${r.out.slice(-800)}`)
    const files = (await run('git', ['ls-files'], dir)).out.split('\n').filter(Boolean).length
    const branch = (await run('git', ['branch', '--show-current'], dir)).out || '(none)'
    const head = (await run('git', ['log', '-1', '--format=%h %s (%cr)'], dir)).out
    lines.push(`📥 Cloned \`${remote}\``, files ? `${files} files · branch \`${branch}\` · last commit ${head}` : 'The repository is empty; your first commit will start it.')
  } else {
    mkdirSync(dir, { recursive: true })
    await run('git', ['init', '-b', 'main'], dir)
    lines.push('🆕 Empty folder with a new git repository (branch `main`). Add a remote later with `!git remote add origin <url>`.')
  }
  return { dir, report: lines.join('\n') }
}

export const NEWPROJECT_HELP = [
  '**/newproject** creates a project and switches to it:',
  '- `/newproject myapp`: empty folder `' + PROJECTS_BASE + '/myapp` with git',
  '- `/newproject myapp https://github.com/you/myapp`: clones it (empty or with files; private GitHub repos work)',
  '- `/newproject https://github.com/you/myapp`: same, name taken from the repo',
  '- `/newproject /srv/site [url]`: a custom folder',
].join('\n')
