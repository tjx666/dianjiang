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

function info(thread: RpcObject, endpoint?: string, turnsRead = true): SessionInfo {
  if (typeof thread?.id !== 'string') throw new SessionError('Codex returned an invalid thread.')
  const state = thread.status?.type
  return {
    harness: 'codex', sessionId: thread.id, endpoint, cwd: thread.cwd,
    state: state === 'active' ? 'active' : state === 'idle' ? 'idle' : state === 'notLoaded' ? 'stopped' : 'unknown',
    observedAt: new Date().toISOString(), capabilities: turnsRead ? ['queue', 'steer'] : ['queue'],
    turnId: thread.turns?.findLast((turn: RpcObject) => turn.status === 'inProgress')?.id,
    detail: state === 'notLoaded' ? 'Not loaded on this server; another server may own the conversation.'
      : turnsRead ? undefined : 'This server does not expose turns for a loaded thread, so steering has no turn ID to target.',
  }
}

/**
 * The app-server daemon answers `thread/read` for a loaded thread but rejects its
 * turn listing with `-32601: list_turns is not supported yet` (Codex 0.154.0).
 * Re-read without turns so queueing still works; steering loses its precondition.
 */
async function read(rpc: SessionRpc, threadId: string, endpoint?: string): Promise<SessionInfo> {
  try { return info((await rpc.request('thread/read', { threadId, includeTurns: true })).thread, endpoint) }
  catch (error) {
    if (!(error instanceof SessionError) || error.code !== -32601) throw error
    return info((await rpc.request('thread/read', { threadId })).thread, endpoint, false)
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
    try { return await read(rpc, target.sessionId, target.endpoint) }
    finally { rpc.close() }
  },
  async send(message) {
    const rpc = await open(message.to.endpoint)
    try {
      // Re-read on the connection doing the write; steering also has a native turn-ID precondition.
      const current = await read(rpc, message.to.sessionId, message.to.endpoint)
      if (current.state !== 'active' && current.state !== 'idle') throw new SessionError('Target is not loaded on this Codex server. Use --wake only after stopping other owners.')
      const input = [{ type: 'text', text: formatSessionMessage(message), text_elements: [] }]
      if (message.mode === 'steer') {
        if (!current.capabilities.includes('steer')) throw new SessionError('This Codex server does not expose turns for a loaded thread, so steering has no turn to target; use queue.')
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
