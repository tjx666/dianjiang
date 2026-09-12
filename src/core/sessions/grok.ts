import { homedir } from 'node:os'
import { join } from 'node:path'
import { connectSocket } from './process.ts'
import { SessionRpc, type RpcObject } from './rpc.ts'
import { formatSessionMessage, SessionError, type SessionAdapter, type SessionInfo } from './types.ts'

async function connect(endpoint = join(homedir(), '.grok', 'leader.sock')): Promise<SessionRpc> {
  // The stdio proxy can auto-start a leader. Refuse missing leaders before invoking it.
  ;(await connectSocket(endpoint, { timedOut: 'Grok leader connection timed out.', unreachable: 'No reachable Grok leader at this socket; no new leader was started.' })).destroy()
  const rpc = SessionRpc.process(['grok', 'agent', '--leader', '--leader-socket', endpoint, 'stdio'])
  try {
    const init = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dianjiang', version: '1' } })
    if (!init?.agentCapabilities?.loadSession) throw new SessionError('This Grok does not support loading sessions.')
    return rpc
  } catch (error) { rpc.close(); throw error }
}

async function roster(rpc: SessionRpc, endpoint?: string): Promise<SessionInfo[]> {
  const envelope = await rpc.request('_x.ai/sessions/list')
  const result = envelope?.result
  if (!Array.isArray(result?.sessions)) throw new SessionError('Grok returned an invalid session roster.')
  return result.sessions.map((row: RpcObject) => {
    if (typeof row.sessionId !== 'string') throw new SessionError('Grok returned an invalid session address.')
    return { harness: 'grok', sessionId: row.sessionId, cwd: row.cwd, endpoint,
      state: row.resident === true ? row.activity === 'idle' ? 'idle' : 'active' : row.resident === false ? 'stopped' : 'unknown',
      observedAt: new Date().toISOString(), capabilities: ['queue', 'steer'], detail: `Native activity: ${row.activity}; scoped to this leader.`,
    }
  })
}

/** Grok ACP uses underscored wire names for vendor extension methods. */
export function createGrokSessionAdapter(open: (endpoint?: string) => Promise<SessionRpc> = connect): SessionAdapter { return {
  name: 'grok',
  async list({ endpoint, limit }) {
    const rpc = await open(endpoint)
    try { return (await roster(rpc, endpoint)).slice(0, limit) } finally { rpc.close() }
  },
  async inspect(target) {
    const rpc = await open(target.endpoint)
    try {
      return (await roster(rpc, target.endpoint)).find((row) => row.sessionId === target.sessionId) ?? { ...target, state: 'unknown', capabilities: [], observedAt: new Date().toISOString(), detail: 'Session is not known to this Grok leader.' }
    } finally { rpc.close() }
  },
  async send(message) {
    const rpc = await open(message.to.endpoint)
    try {
      const current = (await roster(rpc, message.to.endpoint)).find((row) => row.sessionId === message.to.sessionId)
      if (!current || !['active', 'idle'].includes(current.state)) throw new SessionError('Target is not resident in this Grok leader; no fresh session was started.')
      await rpc.request('session/load', { sessionId: message.to.sessionId, cwd: current.cwd, mcpServers: [] })
      return await new Promise((resolve, reject) => {
        let interjected = false
        let admitted = false
        const timer = setTimeout(() => {
          if (admitted) finish('Queue admission confirmed; mid-turn promotion was not confirmed. Do not resend.')
          else { remove(); reject(new SessionError('Grok did not acknowledge the message; do not resend blindly.', 'unknown')) }
        }, 15000)
        const finish = (detail?: string) => {
          clearTimeout(timer); remove()
          resolve({ status: 'accepted', transport: 'grok-acp-queue', nativeMessageId: message.id, detail })
        }
        const remove = rpc.onMessage((frame) => {
          if (frame.method === '_x.ai/session/interjection' && frame.params?.sessionId === message.to.sessionId && frame.params?.interjectionId === message.id) {
            finish('Native mid-turn interjection confirmed; a turn-boundary race may still defer processing to the next turn.')
            return
          }
          if (frame.method !== '_x.ai/queue/changed' || frame.params?.sessionId !== message.to.sessionId) return
          const params = frame.params
          const entry = params.entries?.find((item: RpcObject) => item.id === message.id)
          if (!entry && params.runningPromptId !== message.id) return
          admitted = true
          if (message.mode === 'steer' && entry && !interjected) {
            interjected = true
            rpc.notify('_x.ai/queue/interject', { sessionId: message.to.sessionId, id: message.id, expectedVersion: entry.version })
            // Keep the proxy alive until native confirmation; closing it here can drop the notification.
          } else if (!interjected || params.runningPromptId === message.id) finish('Native queue admission confirmed.')
        })
        // ACP completes this RPC at turn end. Admission is correlated with the native queue event instead.
        void rpc.request('session/prompt', { sessionId: message.to.sessionId, prompt: [{ type: 'text', text: formatSessionMessage(message) }], _meta: { promptId: message.id } }, 20000)
          .then(() => finish())
          .catch((error) => {
            if (admitted) finish('Queue admission confirmed; connection ended before mid-turn promotion confirmation.')
            else { clearTimeout(timer); remove(); reject(error) }
          })
      })
    } finally { rpc.close() }
  },
} }

export const grokSessions = createGrokSessionAdapter()
