import { SessionRpc, type RpcObject } from './rpc.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { formatSessionMessage, SessionError, type SessionAdapter, type SessionInfo, type SessionTarget } from './types.ts'

/** Connect to the existing daemon; never spawn an independent app-server for a live target. */
async function connect(endpoint?: string): Promise<SessionRpc> {
  const rpc = await SessionRpc.webSocket(endpoint ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock'))
  try {
    await rpc.request('initialize', { clientInfo: { name: 'dianjiang', version: '1' }, capabilities: { experimentalApi: true } })
    rpc.notify('initialized')
    return rpc
  } catch (error) { rpc.close(); throw error }
}

function info(thread: RpcObject, endpoint?: string): SessionInfo {
  if (typeof thread?.id !== 'string') throw new SessionError('Codex returned an invalid thread.')
  const state = thread.status?.type
  return {
    harness: 'codex', sessionId: thread.id, endpoint, cwd: thread.cwd,
    state: state === 'active' ? 'active' : state === 'idle' ? 'idle' : state === 'notLoaded' ? 'stopped' : 'unknown',
    observedAt: new Date().toISOString(), capabilities: ['queue', 'steer'],
    turnId: thread.turns?.findLast((turn: RpcObject) => turn.status === 'inProgress')?.id,
    detail: state === 'notLoaded' ? 'Not loaded on this server; another server may own the conversation.' : undefined,
  }
}

/** https://developers.openai.com/codex/app-server/ */
export function createCodexSessionAdapter(open: (endpoint?: string) => Promise<SessionRpc> = connect): SessionAdapter { return {
  name: 'codex',
  async list({ endpoint, limit }) {
    const rpc = await open(endpoint)
    try {
      const result = await rpc.request('thread/list', { limit, sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'] })
      if (!Array.isArray(result?.data)) throw new SessionError('Codex returned an invalid thread list.')
      return result.data.map((thread: RpcObject) => info(thread, endpoint))
    } finally { rpc.close() }
  },
  async inspect(target) {
    const rpc = await open(target.endpoint)
    try { return info((await rpc.request('thread/read', { threadId: target.sessionId, includeTurns: true })).thread, target.endpoint) }
    finally { rpc.close() }
  },
  async send(message) {
    const rpc = await open(message.to.endpoint)
    try {
      // Re-read on the connection doing the write; steering also has a native turn-ID precondition.
      const current = info((await rpc.request('thread/read', { threadId: message.to.sessionId, includeTurns: true })).thread, message.to.endpoint)
      if (current.state !== 'active' && current.state !== 'idle') throw new SessionError('Target is not loaded on this Codex server. Use --wake only after stopping other owners.')
      const input = [{ type: 'text', text: formatSessionMessage(message), text_elements: [] }]
      if (message.mode === 'steer') {
        if (current.state !== 'active' || !current.turnId) throw new SessionError('Codex steering requires an active turn; use queue for idle sessions.')
        const result = await rpc.request('turn/steer', { threadId: message.to.sessionId, expectedTurnId: current.turnId, clientUserMessageId: message.id, input })
        if (typeof result?.turnId !== 'string') throw new SessionError('Codex returned no steering acknowledgement.', 'unknown')
        return { status: 'accepted', transport: 'codex-app-server-steer', nativeMessageId: result.turnId }
      }
      const result = await rpc.request('thread/queue/add', { threadId: message.to.sessionId, clientUserMessageId: message.id, input })
      if (typeof result?.queuedSubmission?.id !== 'string') throw new SessionError('Codex returned no queue acknowledgement.', 'unknown')
      return { status: 'accepted', transport: 'codex-app-server-queue', nativeMessageId: result.queuedSubmission.id }
    } finally { rpc.close() }
  },
} }

export const codexSessions = createCodexSessionAdapter()
