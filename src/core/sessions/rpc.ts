import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createConnection } from 'node:net'
import { PassThrough, Writable, type Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// Bun's ws compatibility shim ignores custom Unix createConnection. Load the
// package implementation explicitly so both supported runtimes use the same transport.
// https://github.com/websockets/ws/blob/master/doc/ws.md#new-websocketaddress-protocols-options
const require = createRequire(import.meta.url)
const WebSocket = require(join(dirname(require.resolve('ws/package.json')), 'index.js')) as typeof import('ws').default
import { connectSocket } from './process.ts'
import { SessionError } from './types.ts'

export type RpcObject = Record<string, any>

/** Bounded JSONL RPC; closing a client never terminates the shared native server. */
export class SessionRpc {
  private sequence = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private listeners = new Set<(message: RpcObject) => void>()
  private buffer = ''
  private ended = false
  private constructor(private input: Writable, output: Readable, private dispose: () => void) {
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => {
      this.buffer += chunk
      if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) return this.fail(new SessionError('Native protocol exceeded the 8 MiB frame limit.', 'unknown'))
      let index: number
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 1)
        if (!line.trim()) continue
        let message: RpcObject
        try { message = JSON.parse(line) } catch { this.fail(new SessionError('Native protocol returned invalid JSON.', 'unknown')); return }
        if (!message || typeof message !== 'object') { this.fail(new SessionError('Invalid native protocol frame.', 'unknown')); return }
        if (message.method) {
          // This delivery client cannot grant permissions or execute server tool requests.
          if (message.id !== undefined) this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Delivery client does not execute tools or grant approvals.' } })
          try { for (const listener of this.listeners) listener(message) }
          catch { this.fail(new SessionError('Invalid native protocol notification.', 'unknown')); return }
        } else if (typeof message.id === 'number') {
          const pending = this.pending.get(message.id)
          if (!pending) continue
          clearTimeout(pending.timer)
          this.pending.delete(message.id)
          if (message.error) pending.reject(new SessionError(`Native RPC error ${message.error.code}: ${message.error.message}`, [-32600, -32601, -32602].includes(message.error.code) ? 'rejected' : 'unknown', message.error.code))
          else pending.resolve(message.result)
        }
      }
    })
    output.on('end', () => this.fail(new SessionError('Native connection closed before acknowledgement.', 'unknown')))
    output.on('error', (error) => this.fail(new SessionError(error.message, 'unknown')))
    input.on('error', (error) => this.fail(new SessionError(error.message, 'unknown')))
  }

  static async socket(path: string): Promise<SessionRpc> {
    const socket = await connectSocket(path, { timedOut: 'Native socket connection timed out.' })
    return new SessionRpc(socket, socket, () => socket.destroy())
  }

  static process(argv: string[], cwd?: string): SessionRpc {
    const child: ChildProcessWithoutNullStreams = spawn(argv[0]!, argv.slice(1), { cwd, stdio: 'pipe' })
    const rpc = new SessionRpc(child.stdin, child.stdout, () => { child.stdin.end(); child.kill() })
    // Drain stderr without exposing native configuration or retaining unbounded logs.
    child.stderr.resume()
    child.on('error', (error) => rpc.fail(new SessionError(`Could not start ${argv[0]}: ${error.message}`)))
    child.on('exit', () => rpc.fail(new SessionError('Native client exited before acknowledgement.', 'unknown')))
    return rpc
  }

  /** Codex's local control socket speaks WebSocket over Unix, rather than raw JSONL. */
  static async webSocket(path: string): Promise<SessionRpc> {
    const ws = new WebSocket('ws://localhost/', { createConnection: () => createConnection(path), handshakeTimeout: 5000, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', (error) => reject(new SessionError(`Native WebSocket connection failed: ${error.message}`)))
    })
    const output = new PassThrough()
    const input = new Writable({ write(chunk, _encoding, callback) { ws.send(String(chunk).trimEnd(), callback) } })
    const rpc = new SessionRpc(input, output, () => { ws.terminate(); output.destroy(); input.destroy() })
    ws.on('message', (data) => output.write(`${data.toString()}\n`))
    ws.on('close', () => output.end())
    ws.on('error', (error) => rpc.fail(new SessionError(error.message, 'unknown')))
    return rpc
  }

  private write(frame: RpcObject): void {
    if (this.ended) throw new SessionError('Native connection is closed.', 'unknown')
    this.input.write(`${JSON.stringify(frame)}\n`)
  }

  request(method: string, params: RpcObject = {}, timeoutMs = 15000): Promise<any> {
    if (this.ended) return Promise.reject(new SessionError('Native connection is closed.'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new SessionError(`Timed out waiting for ${method}; do not resend blindly.`, 'unknown')) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ jsonrpc: '2.0', id, method, params }) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }

  notify(method: string, params: RpcObject = {}): void { this.write({ jsonrpc: '2.0', method, params }) }
  onMessage(listener: (message: RpcObject) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private fail(error: Error): void {
    if (this.ended) return
    this.ended = true
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    this.dispose()
  }
  close(): void { this.fail(new SessionError('Delivery client closed.', 'unknown')) }
}
