import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { sendSessionMessage, getMessageReceipt, normalizeSessionTarget, type SessionAdapter, type SessionInfo, type SendSessionOptions, SessionError } from '../src/core/sessions/index.ts'
import { SessionRpc } from '../src/core/sessions/rpc.ts'
import { claudeSessions } from '../src/core/sessions/claude.ts'
import { createCodexSessionAdapter } from '../src/core/sessions/codex.ts'
import { createGrokSessionAdapter } from '../src/core/sessions/grok.ts'
import { claimMessage } from '../src/core/sessions/store.ts'
import { openDatabase } from '../src/core/sqlite.ts'
import { dbPath } from '../src/core/paths.ts'
import { specFromRecord, waitForRun } from '../src/core/runner.ts'
import { getRun } from '../src/core/store.ts'
import type { RunRecord } from '../src/core/types.ts'

let home: string
let previous: string | undefined
beforeEach(() => { previous = process.env.DIANJIANG_HOME; home = mkdtempSync(join(tmpdir(), 'dj-sessions-')); process.env.DIANJIANG_HOME = home })
afterEach(() => { if (previous === undefined) delete process.env.DIANJIANG_HOME; else process.env.DIANJIANG_HOME = previous; rmSync(home, { recursive: true, force: true }) })

const config = { maxDepth: 2, agents: [] }
function options(): SendSessionOptions {
  return { from: { harness: 'codex', sessionId: randomUUID() }, to: { harness: 'claude', sessionId: randomUUID() }, text: 'hello', messageId: randomUUID() }
}
function adapter(overrides: Partial<SessionAdapter> = {}): SessionAdapter {
  return { name: 'claude', list: async () => [], inspect: async (to) => ({ ...to, state: 'active', observedAt: new Date().toISOString(), capabilities: ['queue'] }), send: async () => ({ status: 'accepted', transport: 'test' }), ...overrides }
}

describe('delivery receipts', () => {
  test('same ID sends once, returns original receipt, and does not re-probe', async () => {
    let writes = 0, probes = 0
    const transport = adapter({ inspect: async (to) => { probes++; return { ...to, state: 'idle', observedAt: '', capabilities: ['queue'] } }, send: async () => { writes++; return { status: 'accepted', transport: 'test' } } })
    const request = options()
    const first = await sendSessionMessage(request, config, { claude: transport })
    expect(await sendSessionMessage(request, config, { claude: transport })).toEqual(first)
    expect([writes, probes]).toEqual([1, 1])
    expect(getMessageReceipt(first.messageId)).toEqual(first)
  })
  test('ID reuse with changed content or wake model is rejected', async () => {
    const request = options()
    await sendSessionMessage(request, config, { claude: adapter() })
    await expect(sendSessionMessage({ ...request, text: 'other' }, config)).rejects.toThrow('different content')
    await expect(sendSessionMessage({ ...request, model: 'sonnet' }, config)).rejects.toThrow('different content')
  })
  test('ambiguous writes are retained and never retried', async () => {
    let writes = 0
    const transport = adapter({ send: async () => { writes++; throw new SessionError('lost acknowledgement', 'unknown') } })
    const request = options()
    expect((await sendSessionMessage(request, config, { claude: transport })).status).toBe('unknown')
    expect((await sendSessionMessage(request, config, { claude: transport })).status).toBe('unknown')
    expect(writes).toBe(1)
  })
  test('a second message cannot overlap the same native target', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const request = options()
    const pending = sendSessionMessage(request, config, { claude: adapter({ send: async () => { started(); await gate; return { status: 'accepted', transport: 'test' } } }) })
    await entered
    await expect(sendSessionMessage({ ...request, messageId: randomUUID() }, config)).rejects.toThrow('Another sender')
    release(); await pending
    expect((await sendSessionMessage({ ...request, messageId: randomUUID() }, config, { claude: adapter() })).status).toBe('accepted')
  })
  test('a dead sender becomes unknown and releases its target lock', () => {
    const request = options()
    const message = { id: request.messageId!, from: request.from, to: request.to, text: request.text, mode: 'queue' as const, createdAt: new Date().toISOString() }
    claimMessage(message, { wake: false })
    const db = openDatabase(dbPath())
    db.query('UPDATE session_messages SET owner_pid=?').run(2147483647); db.close()
    expect(getMessageReceipt(message.id)?.status).toBe('unknown')
    expect(claimMessage({ ...message, id: randomUUID() }, { wake: false }).fresh).toBe(true)
  })
  test('unknown state and inspection failures never trigger wake or send', async () => {
    for (const inspect of [async (to: any): Promise<SessionInfo> => ({ ...to, state: 'unknown', capabilities: [], observedAt: '' }), async () => { throw new Error('connection failed') }]) {
      const receipt = await sendSessionMessage({ ...options(), wake: true }, config, { claude: adapter({ inspect, send: async () => { throw new Error('must not write') } }) })
      expect(receipt.status).toBe('rejected')
      expect(receipt.runId).toBeUndefined()
    }
  })
  test('a reused PID releases the dead process incarnation without expiring live senders', () => {
    const request = options()
    const message = { id: request.messageId!, from: request.from, to: request.to, text: request.text, mode: 'queue' as const, createdAt: new Date().toISOString() }
    claimMessage(message, { wake: false })
    expect(getMessageReceipt(message.id)?.status).toBe('sending')
    const db = openDatabase(dbPath())
    db.query('UPDATE session_messages SET owner_started=?').run('a different process incarnation'); db.close()
    expect(getMessageReceipt(message.id)?.status).toBe('unknown')
    expect(claimMessage({ ...message, id: randomUUID() }, { wake: false }).fresh).toBe(true)
  })
  test('stopped requires explicit wake; unsupported steer does not send', async () => {
    const stopped = adapter({ inspect: async (to) => ({ ...to, state: 'stopped', capabilities: [], observedAt: '' }) })
    expect((await sendSessionMessage(options(), config, { claude: stopped })).detail).toContain('--wake')
    expect((await sendSessionMessage({ ...options(), mode: 'steer' }, config, { claude: adapter() })).detail).toContain('does not support')
  })
  test('validates native UUIDs, endpoints, self-send and size before writes', async () => {
    expect(() => normalizeSessionTarget({ harness: 'grok', sessionId: '../secret' })).toThrow('UUID')
    expect(() => normalizeSessionTarget({ harness: 'grok', sessionId: randomUUID(), endpoint: 'https://example.com' })).toThrow('local socket')
    const request = options()
    await expect(sendSessionMessage({ ...request, to: request.from }, config)).rejects.toThrow('Self-messaging')
    await expect(sendSessionMessage({ ...request, text: ' ' }, config)).rejects.toThrow('contain text')
    await expect(sendSessionMessage({ ...request, text: 'x'.repeat(262145) }, config)).rejects.toThrow('256 KiB')
  })
  test('external resume ID survives worker spec reconstruction', () => {
    const sessionId = randomUUID()
    expect(specFromRecord({ externalResumeSessionId: sessionId } as RunRecord).resumeSessionId).toBe(sessionId)
  })
  test('external wake executes the native resume in a detached worker and preserves its receipt', async () => {
    const oldPath = process.env.PATH
    const oldClaude = process.env.CLAUDE_CONFIG_DIR
    process.env.PATH = `${home}:${oldPath}`
    process.env.CLAUDE_CONFIG_DIR = home
    const capture = join(home, 'args.json')
    writeFileSync(join(home, 'claude'), `#!/usr/bin/env bun\n// 验证外部续接参数；仅写入测试目录。\nawait Bun.write(${JSON.stringify(capture)}, JSON.stringify(process.argv));\nawait Bun.sleep(200);\nconsole.log(JSON.stringify({result:'RESUMED',session_id:process.argv[process.argv.indexOf('--resume')+1]}));\n`, { mode: 0o755 })
    try {
      const request = { ...options(), wake: true }
      request.to.cwd = home
      const registry = { claude: adapter({ inspect: async (to) => ({ ...to, state: 'stopped', capabilities: [], observedAt: '' }) }) }
      const receipt = await sendSessionMessage(request, config, registry)
      expect(receipt.status).toBe('resumed')
      expect(receipt.runId).toBe(request.messageId)
      const overlapping = await sendSessionMessage({ ...request, messageId: randomUUID() }, config, registry)
      expect(overlapping.status).toBe('rejected')
      expect(overlapping.detail).toContain('already running')
      const run = await waitForRun(receipt.runId!, { timeoutMs: 5000 })
      expect(run?.status).toBe('completed')
      expect(run?.externalResumeSessionId).toBe(request.to.sessionId)
      expect(run?.parentRunId).toBeUndefined()
      const argv: string[] = JSON.parse(readFileSync(capture, 'utf8'))
      expect(argv[argv.indexOf('--resume') + 1]).toBe(request.to.sessionId)
      expect(getRun(receipt.runId!)?.result).toBe('RESUMED')
    } finally {
      process.env.PATH = oldPath
      if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude
    }
  })
})

/**
 * A fake native backend: one JSONL frame per line, `respond` returns the frame
 * to write back (or nothing, when the server answers out of band instead).
 */
async function jsonlServer(endpoint: string, respond: (frame: any, emit: (value: unknown) => void) => unknown) {
  const server = createServer((socket) => {
    const emit = (value: unknown) => socket.write(`${JSON.stringify(value)}\n`)
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1)
        const reply = respond(frame, emit)
        if (reply !== undefined) emit(reply)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(endpoint, resolve))
  return server
}

describe('native protocol boundaries', () => {
  test('Grok unwraps the roster and keeps its proxy until correlated interjection confirmation', async () => {
    const endpoint = join(home, 'grok.sock')
    const request = { ...options(), to: { harness: 'grok' as const, sessionId: randomUUID(), endpoint }, mode: 'steer' as const }
    let promoted = false
    const server = await jsonlServer(endpoint, (frame, emit) => {
      if (frame.method === '_x.ai/sessions/list') return { id: frame.id, result: { result: { sessions: [{ sessionId: request.to.sessionId, resident: true, activity: 'working', cwd: home }] } } }
      if (frame.method === 'session/load') return { id: frame.id, result: {} }
      if (frame.method === 'session/prompt') {
        expect(frame.params._meta.promptId).toBe(request.messageId)
        return { method: '_x.ai/queue/changed', params: { sessionId: request.to.sessionId, entries: [{ id: request.messageId, version: 2 }] } }
      }
      if (frame.method === '_x.ai/queue/interject') {
        expect(frame.params.expectedVersion).toBe(2)
        setTimeout(() => { promoted = true; emit({ method: '_x.ai/session/interjection', params: { sessionId: request.to.sessionId, interjectionId: request.messageId } }) }, 30)
      }
    })
    try {
      const receipt = await sendSessionMessage(request, config, { grok: createGrokSessionAdapter((path) => SessionRpc.socket(path!)) })
      expect(receipt.status).toBe('accepted')
      expect(receipt.detail).toContain('interjection confirmed')
      expect(promoted).toBe(true)
    } finally { server.close() }
  })
  test('Claude writes one complete attributed frame but does not invent an ACK', async () => {
    const endpoint = join(home, 'claude.sock')
    let received = ''
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const server = createServer((socket) => { socket.on('data', (chunk) => { received += chunk }); socket.on('end', () => { finish(); socket.end() }) })
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    try {
      const request = options()
      const message = { id: request.messageId!, from: request.from, to: { ...request.to, endpoint }, text: 'line one\n"line two"', mode: 'queue' as const, createdAt: new Date().toISOString() }
      const result = await claudeSessions.send(message, { ...message.to, state: 'active', observedAt: '', capabilities: ['queue'] })
      await done
      const frame = JSON.parse(received)
      expect(frame.session_id).toBe(request.to.sessionId)
      expect(frame.message.content).toContain(request.from.sessionId)
      expect(frame.message.content).toContain('line one\n"line two"')
      expect(frame.from_mode).toBeUndefined()
      expect(result.status).toBe('written')
    } finally { server.close() }
  })
  test('Codex queue correlates native idempotency and rejects a changed turn', async () => {
    const endpoint = join(home, 'codex.sock')
    const request = { ...options(), to: { harness: 'codex' as const, sessionId: randomUUID(), endpoint } }
    let queued: any
    const server = await jsonlServer(endpoint, (frame) => {
      if (frame.id === undefined) return
      let result: any = {}
      if (frame.method === 'thread/read') result = { thread: { id: request.to.sessionId, status: { type: 'idle' }, turns: [] } }
      if (frame.method === 'thread/queue/add') { queued = frame.params; result = { queuedSubmission: { id: 'native-1' } } }
      return { id: frame.id, result }
    })
    try {
      const registry = { codex: createCodexSessionAdapter((path) => SessionRpc.socket(path!)) }
      const receipt = await sendSessionMessage(request, config, registry)
      expect(receipt.status).toBe('accepted')
      expect(queued.clientUserMessageId).toBe(request.messageId)
      expect(queued.input[0].text).toContain(request.from.sessionId)
      const steer = await sendSessionMessage({ ...request, messageId: randomUUID(), mode: 'steer' }, config, registry)
      expect(steer.status).toBe('rejected')
      expect(steer.detail).toContain('active turn')
    } finally { server.close() }
  })
  test('Codex queues when the server refuses to list turns, and refuses to steer', async () => {
    const endpoint = join(home, 'codex-no-turns.sock')
    const request = { ...options(), to: { harness: 'codex' as const, sessionId: randomUUID(), endpoint } }
    const server = await jsonlServer(endpoint, (frame) => {
      if (frame.id === undefined) return
      // The daemon reads a loaded thread but rejects its turn listing.
      if (frame.method === 'thread/read' && frame.params.includeTurns) return { id: frame.id, error: { code: -32601, message: 'list_turns is not supported yet' } }
      let result: any = {}
      if (frame.method === 'thread/read') result = { thread: { id: request.to.sessionId, status: { type: 'idle' } } }
      if (frame.method === 'thread/queue/add') result = { queuedSubmission: { id: 'native-2' } }
      return { id: frame.id, result }
    })
    try {
      const adapter = createCodexSessionAdapter((path) => SessionRpc.socket(path!))
      expect((await adapter.inspect(request.to)).capabilities).toEqual(['queue'])
      const receipt = await sendSessionMessage(request, config, { codex: adapter })
      expect(receipt.status).toBe('accepted')
      const steer = await sendSessionMessage({ ...request, messageId: randomUUID(), mode: 'steer' }, config, { codex: adapter })
      expect(steer.status).toBe('rejected')
      expect(steer.detail).toContain('does not support steer')
    } finally { server.close() }
  })
  test('RPC disconnect after write is unknown, invalid JSON fails without hanging', async () => {
    for (const malformed of [false, true]) {
      const endpoint = join(home, `rpc-${malformed}.sock`)
      const server = createServer((socket) => socket.once('data', () => malformed ? socket.end('not json\n') : socket.destroy()))
      await new Promise<void>((resolve) => server.listen(endpoint, resolve))
      const rpc = await SessionRpc.socket(endpoint)
      try { await expect(rpc.request('send')).rejects.toMatchObject({ outcome: 'unknown' }) }
      finally { rpc.close(); server.close() }
    }
  })
})
