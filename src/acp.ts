// Minimal Agent Client Protocol (ACP) client for `agy acp` (JSON-RPC 2.0 over stdio, one JSON
// message per line). We act as the client: we send initialize / session/* requests and answer the
// agent's session/request_permission requests.
import type { Subprocess } from 'bun'

export type SessionUpdate = { sessionUpdate: string; [k: string]: any }
export type PermissionRequest = {
  sessionId: string
  toolCall: { toolCallId: string; title?: string; kind?: string; rawInput?: any; args?: any; name?: string }
  options: { optionId: string; name: string; kind: string }[]
}

export class Acp {
  private proc: Subprocess<'pipe', 'pipe', 'pipe'> | null = null
  private nextId = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  onUpdate: (sessionId: string, u: SessionUpdate) => void = () => {}
  onPermission: (p: PermissionRequest) => Promise<string | null> = async () => null
  onExit: (code: number | null) => void = () => {}
  agentInfo: any = null

  constructor(private bin: string, private args: string[], private log: (s: string) => void, readonly cwd: string) {}

  get running(): boolean { return this.proc !== null }
  get pid(): number | undefined { return this.proc?.pid }

  async start(): Promise<void> {
    const p = Bun.spawn([this.bin, 'acp', '--disable-telemetry', ...this.args], {
      // agy works in its process folder, so each process is tied to one project folder.
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', cwd: this.cwd,
    })
    this.proc = p
    void this.readLoop(p.stdout)
    void this.drain(p.stderr)
    void p.exited.then(code => {
      if (this.proc !== p) return
      this.proc = null
      for (const w of this.pending.values()) w.reject(new Error(`agy exited (${code})`))
      this.pending.clear()
      this.onExit(code)
    })
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    this.agentInfo = init
  }

  stop(): void {
    const p = this.proc
    this.proc = null
    for (const w of this.pending.values()) w.reject(new Error('agy stopped'))
    this.pending.clear()
    try { p?.kill() } catch {}
  }

  request<T = any>(method: string, params: any, timeoutMs = 0): Promise<T> {
    if (!this.proc) return Promise.reject(new Error('agy is not running'))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
      if (timeoutMs) setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
      }, timeoutMs)
    })
  }

  notify(method: string, params: any): void { if (this.proc) this.write({ jsonrpc: '2.0', method, params }) }

  private write(m: unknown): void {
    try { this.proc!.stdin.write(JSON.stringify(m) + '\n'); this.proc!.stdin.flush() } catch (e) { this.log(`write failed: ${e}`) }
  }

  private async drain(s: ReadableStream<Uint8Array>): Promise<void> {
    const dec = new TextDecoder()
    for await (const chunk of s) {
      const t = dec.decode(chunk).trim()
      if (t && !/logging before google\.Init/.test(t)) this.log(`agy: ${t.slice(0, 500)}`)
    }
  }

  private async readLoop(s: ReadableStream<Uint8Array>): Promise<void> {
    const dec = new TextDecoder()
    let buf = ''
    for await (const chunk of s) {
      buf += dec.decode(chunk, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let m: any
        try { m = JSON.parse(line) } catch { this.log(`bad line from agy: ${line.slice(0, 200)}`); continue }
        this.handle(m)
      }
    }
  }

  private handle(m: any): void {
    if (m.id != null && !m.method) {
      const w = this.pending.get(m.id)
      if (!w) return
      this.pending.delete(m.id)
      if (m.error) w.reject(new Error(m.error.message ?? JSON.stringify(m.error)))
      else w.resolve(m.result)
      return
    }
    if (m.method === 'session/update') {
      try { this.onUpdate(m.params.sessionId, m.params.update) } catch (e) { this.log(`update handler: ${e}`) }
      return
    }
    if (m.method === 'session/request_permission' && m.id != null) {
      this.onPermission(m.params).then(
        optionId => this.write({ jsonrpc: '2.0', id: m.id, result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } }),
        () => this.write({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } }),
      )
      return
    }
    if (m.id != null && m.method) {
      // A client method we don't implement (fs/terminal are declared unsupported).
      this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not supported: ${m.method}` } })
    }
  }
}
