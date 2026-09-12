import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { realpathSync, statSync } from 'node:fs'
import { HARNESS_NAMES, isUuid, type DianjiangConfig, type HarnessName } from '../types.ts'
import { dispatch, reconcileRun } from '../runner.ts'
import { findExternalResumeRuns, getRun } from '../store.ts'
import { claudeSessions } from './claude.ts'
import { codexSessions } from './codex.ts'
import { grokSessions } from './grok.ts'
import { claimMessage, finishMessage } from './store.ts'
import { formatSessionMessage, SessionError, type SessionAdapter, type SessionAddress, type SessionInfo, type SessionMessage, type SessionTarget, type MessageMode, type MessageReceipt } from './types.ts'

export * from './types.ts'
export { getMessageReceipt } from './store.ts'

export const sessionAdapters: Readonly<Record<string, SessionAdapter>> = { claude: claudeSessions, codex: codexSessions, grok: grokSessions }

export function validateSessionAddress(address: SessionAddress): void {
  if (!HARNESS_NAMES.includes(address.harness)) throw new SessionError('Unknown harness.')
  if (!isUuid(address.sessionId)) throw new SessionError('Use the native session UUID, not a session name or dianjiang run ID.')
}

/** An endpoint names a local native socket. Never a URL, a token, or a traversal. */
export function validateSessionEndpoint(endpoint: string | undefined): void {
  if (endpoint && (!isAbsolute(endpoint) || endpoint.includes('\0') || endpoint.split('/').includes('..'))) throw new SessionError('--endpoint must be an absolute local socket path without .. segments.')
}

function requireAdapter(harness: HarnessName, registry: Readonly<Record<string, SessionAdapter>>): SessionAdapter {
  if (!HARNESS_NAMES.includes(harness)) throw new SessionError('Unknown harness.')
  const adapter = registry[harness]
  if (!adapter) throw new SessionError(`No session adapter for ${harness}.`)
  return adapter
}

export function normalizeSessionTarget(target: SessionTarget): SessionTarget {
  validateSessionAddress(target)
  validateSessionEndpoint(target.endpoint)
  let cwd = target.cwd ? resolve(target.cwd) : undefined
  if (cwd) { try { cwd = realpathSync(cwd) } catch {} }
  return { harness: target.harness, sessionId: target.sessionId.toLowerCase(), endpoint: target.endpoint, cwd }
}

/**
 * Discovery entry points live here rather than in a frontend, so every caller of
 * the library gets the same endpoint and bound checks before a socket is opened.
 */
export async function listSessions(harness: HarnessName, options: { endpoint?: string; limit?: number } = {}, registry = sessionAdapters): Promise<SessionInfo[]> {
  const adapter = requireAdapter(harness, registry)
  validateSessionEndpoint(options.endpoint)
  const limit = options.limit ?? 20
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SessionError('--limit must be between 1 and 100.')
  return adapter.list({ endpoint: options.endpoint, limit })
}

export async function inspectSession(target: SessionTarget, registry = sessionAdapters): Promise<SessionInfo> {
  const to = normalizeSessionTarget(target)
  return requireAdapter(to.harness, registry).inspect(to)
}

export interface SendSessionOptions {
  from: SessionAddress
  to: SessionTarget
  text: string
  messageId?: string
  mode?: MessageMode
  /** Explicitly permits resuming a stopped conversation. Never used on transport failure. */
  wake?: boolean
  model?: string
  effort?: string
}

/** Registry injection lets another frontend add a transport without altering dispatch adapters. */
export async function sendSessionMessage(options: SendSessionOptions, config: DianjiangConfig, registry = sessionAdapters): Promise<MessageReceipt> {
  validateSessionAddress(options.from)
  const to = normalizeSessionTarget(options.to)
  if (!options.text.trim() || Buffer.byteLength(options.text) > 256 * 1024) throw new SessionError('Message must contain text and be at most 256 KiB.')
  const mode = options.mode ?? 'queue'
  if (!['queue', 'steer'].includes(mode)) throw new SessionError('Mode must be queue or steer.')
  const id = options.messageId ?? randomUUID()
  validateSessionAddress({ harness: to.harness, sessionId: id })
  const from = { harness: options.from.harness, sessionId: options.from.sessionId.toLowerCase() }
  if (from.harness === to.harness && from.sessionId === to.sessionId) throw new SessionError('Self-messaging is not supported.')
  const adapter = requireAdapter(to.harness, registry)
  const message: SessionMessage = { id: id.toLowerCase(), from, to, text: options.text, mode, createdAt: new Date().toISOString() }
  const claim = claimMessage(message, { wake: !!options.wake, model: options.model, effort: options.effort })
  if (!claim.fresh) return claim.receipt
  let receipt = claim.receipt
  let writeStarted = false
  try {
    const current = await adapter.inspect(to)
    if (current.sessionId !== to.sessionId || current.harness !== to.harness) throw new SessionError('Native discovery returned a different session.')
    if (current.state === 'stopped' && options.wake) {
      if (mode !== 'queue') throw new SessionError('--wake cannot steer a stopped session; use queue.')
      const cwd = to.cwd ?? current.cwd
      if (!cwd || !statSync(cwd).isDirectory()) throw new SessionError('Waking an external session requires its original working directory (--cwd).')
      const prior = findExternalResumeRuns(to.harness, to.sessionId).find((run) => reconcileRun(run).status === 'running')
      if (prior) throw new SessionError(`An external resume is already running: ${prior.runId}.`)
      if (getRun(message.id)) throw new SessionError('Message ID conflicts with an existing run ID; choose a new message ID.')
      // The deterministic run ID is recoverable even if the caller dies after spawning the worker.
      receipt = { ...receipt, runId: message.id }
      finishMessage(receipt, true)
      writeStarted = true
      await dispatch({ runId: message.id, harness: to.harness, externalResumeSessionId: to.sessionId, task: formatSessionMessage(message), cwd, model: options.model, effort: options.effort, detach: true }, config)
      receipt = { ...receipt, status: 'resumed', transport: 'native-resume', detail: 'Detached resume started. Read the run result; this is not a model reply.' }
    } else {
      if (current.state === 'unknown') throw new SessionError('Target state is unknown; refusing to send or start a competing resume.')
      if (current.state === 'stopped') throw new SessionError('Target is stopped. Pass --wake and its original --cwd to resume it.')
      if (!current.capabilities.includes(mode)) throw new SessionError(`Target does not support ${mode}.`)
      writeStarted = true
      receipt = { ...receipt, ...await adapter.send(message, current) }
    }
  } catch (error) {
    receipt = { ...receipt, status: error instanceof SessionError ? error.outcome : writeStarted ? 'unknown' : 'rejected', detail: error instanceof Error ? error.message : String(error) }
  }
  return finishMessage({ ...receipt, updatedAt: new Date().toISOString() })
}
