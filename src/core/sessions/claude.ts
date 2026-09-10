import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { nativeOutput } from './process.ts'
import { formatSessionMessage, SessionError, type SessionAdapter, type SessionInfo } from './types.ts'

async function activeSessions(): Promise<SessionInfo[]> {
  let rows: any
  try { rows = JSON.parse(await nativeOutput('claude', ['agents', '--json'])) } catch (error) { throw new SessionError(`Cannot discover Claude sessions: ${error instanceof Error ? error.message : String(error)}`) }
  if (!Array.isArray(rows)) throw new SessionError('Claude returned an invalid session list.')
  return rows.filter((row) => typeof row.sessionId === 'string' && Number.isInteger(row.pid)).map((row) => ({
    harness: 'claude', sessionId: row.sessionId, cwd: row.cwd, pid: row.pid,
    state: 'active', observedAt: new Date().toISOString(), capabilities: ['queue'],
    detail: 'Process is live; Claude does not expose busy versus idle in this listing.',
  }))
}

async function socketFor(info: SessionInfo): Promise<string> {
  if (info.endpoint && !info.pid) return info.endpoint
  const listing = await nativeOutput('lsof', ['-a', '-p', String(info.pid), '-U', '-Fn'])
  if (info.endpoint) {
    if (!listing.split('\n').includes(`n${info.endpoint}`)) throw new SessionError('Claude endpoint does not belong to the target session process.')
    return info.endpoint
  }
  const paths = [...new Set(listing.split('\n').filter((line) => line.startsWith('n/')).map((line) => line.slice(1)).filter((path) => /\/cc-socks(?:-\d+)?\/[^/]+\.sock$/.test(path)))]
  if (paths.length !== 1) throw new SessionError('Cannot uniquely discover the Claude inbox socket. Pass --endpoint from the target session Peer address.')
  return paths[0]!
}

/** https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket */
export const claudeSessions: SessionAdapter = {
  name: 'claude',
  async list({ limit }) { return (await activeSessions()).slice(0, limit) },
  async inspect(target) {
    const current = (await activeSessions()).find((row) => row.sessionId === target.sessionId)
    if (current) return { ...current, endpoint: target.endpoint }
    const history = target.cwd && join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects', target.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${target.sessionId}.jsonl`)
    return { ...target, state: history && existsSync(history) ? 'stopped' : 'unknown', observedAt: new Date().toISOString(), capabilities: [], detail: 'No registered live process. A stopped session requires its original --cwd and local history.' }
  },
  async send(message, observed) {
    if (message.mode !== 'queue') throw new SessionError('Claude accepts messages between tool calls; it does not expose forced steering here. Use queue.')
    if (process.platform === 'win32') throw new SessionError('Claude named-pipe authentication is not supported by this adapter.')
    const endpoint = await socketFor(observed)
    let stat
    try { stat = statSync(endpoint) } catch { throw new SessionError('Claude inbox socket is unavailable; no resume was attempted.') }
    if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid())) throw new SessionError('Claude inbox must be a socket owned by the current user.')
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(endpoint)
      let wrote = false
      const timer = setTimeout(() => { socket.destroy(); reject(new SessionError('Claude socket timed out.', wrote ? 'unknown' : 'rejected')) }, 5000)
      socket.on('error', (error) => { clearTimeout(timer); reject(new SessionError(error.message, wrote ? 'unknown' : 'rejected')) })
      socket.once('connect', () => {
        wrote = true
        // Do not claim a Claude permission class: native inbound policy still decides delivery.
        socket.end(`${JSON.stringify({ type: 'user', session_id: message.to.sessionId, msg_id: message.id, message: { role: 'user', content: formatSessionMessage(message) } })}\n`, () => {
          clearTimeout(timer); socket.destroy(); resolve()
        })
      })
    })
    return { status: 'written', transport: 'claude-peer-socket', detail: 'Written to the socket, not acknowledged by Claude. Native crossSessionInbound policy may hold or refuse it; this is not proof of delivery.' }
  },
}
