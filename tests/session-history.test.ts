import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeProjectDir, findSessions, readSession, searchSession } from '../src/core/session-history/index.ts'
import { openDatabase } from '../src/core/sqlite.ts'

let root: string

/** Fixture stores for all three harnesses, isolated via each CLI's home env var. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dianjiang-sessions-'))
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
  process.env.CODEX_HOME = join(root, 'codex')
  process.env.GROK_HOME = join(root, 'grok')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CODEX_HOME
  delete process.env.GROK_HOME
})

const PROJECT = '/Users/tester/code/demo'

function writeJsonl(path: string, records: unknown[]): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

/**
 * A claude transcript with everything the reader has to get right: an
 * attachment, an injected reminder, a tool call/result pair, and a rewound
 * branch that must NOT be reported as a real request.
 */
function writeClaudeTranscript(sessionId: string): string {
  const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', encodeProjectDir(PROJECT))
  const file = join(dir, `${sessionId}.jsonl`)
  const common = { sessionId, cwd: PROJECT, isSidechain: false }
  writeJsonl(file, [
    { ...common, type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-09-01T10:00:00.000Z', message: { role: 'user', content: 'add a login button' } },
    { ...common, type: 'attachment', uuid: 'att1', parentUuid: 'u1', timestamp: '2026-09-01T10:00:01.000Z', attachment: { type: 'file' } },
    {
      ...common,
      type: 'user',
      uuid: 'u-meta',
      parentUuid: 'u1',
      timestamp: '2026-09-01T10:00:02.000Z',
      message: { role: 'user', content: '<system-reminder>be careful</system-reminder>' },
    },
    {
      ...common,
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      timestamp: '2026-09-01T10:00:03.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file: 'app.tsx' } }] },
    },
    {
      ...common,
      type: 'user',
      uuid: 'u2',
      parentUuid: 'a1',
      timestamp: '2026-09-01T10:00:04.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'edited app.tsx' }] },
    },
    // Abandoned branch: asked, then rewound. It hangs off a1 like u2 does.
    { ...common, type: 'user', uuid: 'dead1', parentUuid: 'a1', timestamp: '2026-09-01T10:00:05.000Z', message: { role: 'user', content: 'actually use a modal' } },
    {
      ...common,
      type: 'assistant',
      uuid: 'a2',
      parentUuid: 'u2',
      timestamp: '2026-09-01T10:00:06.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Added the login button.' }] },
    },
    { type: 'ai-title', aiTitle: 'Login button', sessionId },
    { type: 'last-prompt', lastPrompt: 'x', leafUuid: 'a2', sessionId },
  ])
  return file
}

test('claude: overview reports human requests, hides injected content, drops rewound branches', () => {
  writeClaudeTranscript('11111111-1111-4111-8111-111111111111')
  const result = readSession('11111111-1111-4111-8111-111111111111', {}, 'claude')
  expect(result).toBeDefined()
  expect(result?.session.title).toBe('Login button')
  expect(result?.session.cwd).toBe(PROJECT)
  expect(result?.session.resumeCommand).toBe(`cd '${PROJECT}' && claude --resume 11111111-1111-4111-8111-111111111111`)

  const overview = result?.overview
  expect(overview?.firstRequest?.text).toBe('add a login button')
  expect(overview?.lastAssistant?.text).toBe('Added the login button.')
  // The rewound request is neither a request nor an entry.
  expect(JSON.stringify(result)).not.toContain('actually use a modal')
  expect(result?.warnings.some((w) => w.includes('abandoned branches'))).toBe(true)
  // Attachment and system-reminder records are injected, not conversation.
  expect(overview?.counts.injected).toBeUndefined()
  expect(overview?.counts.user).toBe(1)
})

test('claude: --include-injected surfaces attachments and reminders', () => {
  writeClaudeTranscript('11111111-1111-4111-8111-111111111111')
  const result = readSession('11111111-1111-4111-8111-111111111111', { view: 'all', includeInjected: true }, 'claude')
  const kinds = result?.entries?.map((e) => e.kind) ?? []
  expect(kinds).toContain('injected')
  expect(result?.entries?.some((e) => e.text.includes('[attachment: file]'))).toBe(true)
})

test('claude: find matches by content and reports the cwd it ran in', () => {
  writeClaudeTranscript('11111111-1111-4111-8111-111111111111')
  const { matches } = findSessions({ query: 'login button', cwd: PROJECT, harness: 'claude' })
  expect(matches).toHaveLength(1)
  expect(matches[0]?.session.sessionId).toBe('11111111-1111-4111-8111-111111111111')
  expect(matches[0]?.evidence.length).toBeGreaterThan(0)
  expect(matches[0]?.evidence[0]?.preview).toContain('login button')
})

test('claude: find excludes a request on an abandoned branch', () => {
  writeClaudeTranscript('11111111-1111-4111-8111-111111111111')
  const result = findSessions({ query: 'actually use a modal', cwd: PROJECT, harness: 'claude' })
  expect(result.matches).toHaveLength(0)
})

test('claude: search can locate text beyond the entry preview cap', () => {
  const sessionId = '11111111-1111-4111-8111-111111111111'
  const file = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', encodeProjectDir(PROJECT), `${sessionId}.jsonl`)
  writeJsonl(file, [
    { type: 'user', uuid: 'deep', sessionId, cwd: PROJECT, message: { role: 'user', content: `${'x'.repeat(4100)} DEEP-NEEDLE` } },
  ])
  expect(findSessions({ query: 'DEEP-NEEDLE', cwd: PROJECT, harness: 'claude' }).matches).toHaveLength(1)
  const result = searchSession(sessionId, 'DEEP-NEEDLE', {}, 'claude')
  expect(result?.hits.map((hit) => hit.id)).toEqual(['deep'])
  expect(result?.hits[0]?.text).toContain('DEEP-NEEDLE')
})

test('claude: find honours the cwd filter', () => {
  writeClaudeTranscript('11111111-1111-4111-8111-111111111111')
  expect(findSessions({ cwd: '/somewhere/else', harness: 'claude' }).matches).toHaveLength(0)
  expect(findSessions({ cwd: '/somewhere/else', all: true, harness: 'claude' }).matches).toHaveLength(1)
})

/** Minimal `thread_items` table matching codex 0.154.0's schema. */
function writeCodexThreadHistory(threadId: string): void {
  const home = process.env.CODEX_HOME!
  mkdirSync(home, { recursive: true })
  const db = openDatabase(join(home, 'thread_history_1.sqlite'))
  db.exec(`create table thread_items (
    thread_id text not null, turn_id text not null, item_id text not null,
    rollout_ordinal integer not null, created_at_ms integer not null,
    item_json text not null, item_type text not null default '',
    primary key (thread_id, turn_id, item_id))`)
  const insert = db.query('insert into thread_items values (?, ?, ?, ?, ?, ?, ?)')
  const rows: Array<[string, string, unknown]> = [
    ['i1', 'userMessage', { type: 'userMessage', id: 'i1', content: [{ type: 'text', text: 'why is the build slow' }] }],
    ['i2', 'agentMessage', { type: 'agentMessage', id: 'i2', text: 'Checking the bundler config.' }],
    ['i3', 'commandExecution', { type: 'commandExecution', id: 'i3', command: 'bun run build', cwd: PROJECT, aggregatedOutput: 'built in 9s' }],
    ['i4', 'contextCompaction', { type: 'contextCompaction', id: 'i4' }],
    ['i5', 'quantumThing', { type: 'quantumThing', id: 'i5', note: 'from a future codex' }],
  ]
  rows.forEach(([itemId, itemType, payload], index) => {
    insert.run(threadId, 't1', itemId, index, 1_757_000_000_000 + index, JSON.stringify(payload), itemType)
  })
  db.close()
}

test('codex: reads the thread history index, including unknown item types', () => {
  const threadId = '01a08c09-51ae-7361-9f92-9b519d0b24d4'
  writeCodexThreadHistory(threadId)
  const result = readSession(threadId, { view: 'all' }, 'codex')
  expect(result?.session.store).toContain('thread_history_1.sqlite')
  expect(result?.session.cwd).toBe(PROJECT)
  expect(result?.session.resumeCommand).toBe(`codex resume -C '${PROJECT}' ${threadId}`)

  const byKind = (result?.entries ?? []).map((e) => `${e.kind}:${e.text.slice(0, 20)}`)
  expect(byKind.some((k) => k.startsWith('user:why is the build'))).toBe(true)
  expect(byKind.some((k) => k.startsWith('assistant:Checking'))).toBe(true)
  expect(byKind.some((k) => k.startsWith('tool_call:$ bun run build'))).toBe(true)
  expect(byKind.some((k) => k.startsWith('compaction:'))).toBe(true)
  // A type this version has never seen is labelled, never dropped.
  expect(byKind.some((k) => k.includes('quantumThing'))).toBe(true)
})

test('codex: find discovers a thread present only in the SQLite index', () => {
  const threadId = '01a08c09-51ae-7361-9f92-9b519d0b24d4'
  writeCodexThreadHistory(threadId)
  const result = findSessions({ query: 'why is the build slow', cwd: PROJECT, harness: 'codex' })
  expect(result.matches.map((match) => match.session.sessionId)).toContain(threadId)
})

test('codex: search reaches text beyond the indexed entry preview cap', () => {
  const threadId = '01a08c09-51ae-7361-9f92-9b519d0b24d4'
  writeCodexThreadHistory(threadId)
  const db = openDatabase(join(process.env.CODEX_HOME!, 'thread_history_1.sqlite'))
  db.query('insert into thread_items values (?, ?, ?, ?, ?, ?, ?)').run(
    threadId, 't1', 'deep', 5, 1_757_000_000_005,
    JSON.stringify({ type: 'commandExecution', id: 'deep', command: 'cat log', cwd: PROJECT, aggregatedOutput: `${'x'.repeat(4100)} DEEP-NEEDLE` }),
    'commandExecution',
  )
  db.close()
  const result = searchSession(threadId, 'DEEP-NEEDLE', {}, 'codex')
  expect(result?.hits.map((hit) => hit.id)).toEqual(['deep'])
  expect(result?.hits[0]?.text).toContain('DEEP-NEEDLE')
})

test('codex: indexed threads do not fall back to stale rollout text on a search miss', () => {
  const threadId = '01a08c09-51ae-7361-9f92-9b519d0b24d4'
  writeCodexThreadHistory(threadId)
  writeCodexRollout(threadId, threadId)
  const result = findSessions({ query: 'ship the release', all: true, harness: 'codex' })
  expect(result.matches).toHaveLength(0)
})

test('CLI: search --run accepts a query without a session id', () => {
  const home = join(root, 'dianjiang')
  mkdirSync(home, { recursive: true })
  const proc = Bun.spawnSync({
    cmd: ['bun', 'run', 'src/cli/index.ts', 'session', 'search', '--run', 'missing-run', 'needle'],
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, DIANJIANG_HOME: home },
  })
  expect(proc.exitCode).toBe(1)
  expect(JSON.parse(proc.stdout.toString())).toEqual({ status: 'failed', error: 'Run missing-run not found.' })
})

/** A resumed rollout: its own meta first, the parent's copied in after it. */
function writeCodexRollout(sessionId: string, parentId: string): string {
  const file = join(process.env.CODEX_HOME!, 'sessions', '2026', '09', '01', `rollout-2026-09-01T10-00-00-${sessionId}.jsonl`)
  writeJsonl(file, [
    { timestamp: '2026-09-01T10:00:00.000Z', type: 'session_meta', payload: { id: sessionId, session_id: parentId, cwd: PROJECT, timestamp: '2026-09-01T10:00:00.000Z' } },
    { timestamp: '2026-09-01T10:00:00.000Z', type: 'session_meta', payload: { id: parentId, session_id: parentId, cwd: PROJECT, timestamp: '2026-09-01T09:00:00.000Z' } },
    { timestamp: '2026-09-01T10:00:01.000Z', type: 'response_item', payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'ship the release' }] } },
    { timestamp: '2026-09-01T10:00:02.000Z', type: 'event_msg', payload: { type: 'item_completed', id: 'm1' } },
    { timestamp: '2026-09-01T10:00:03.000Z', type: 'response_item', payload: { type: 'message', id: 'm2', role: 'assistant', content: [{ type: 'output_text', text: 'Released v1.' }] } },
  ])
  return file
}

test('codex: rollout fallback keeps its own identity and flags the parent', () => {
  const sessionId = '01a07263-63a3-7082-bbf4-8dfdf600ce9e'
  const parentId = '01a07262-8f84-7910-bf3e-6f36fd2779f4'
  writeCodexRollout(sessionId, parentId)
  const result = readSession(sessionId, { view: 'all' }, 'codex')
  // Identity comes from the FIRST session_meta; the last one is the parent's.
  expect(result?.session.sessionId).toBe(sessionId)
  expect(result?.session.parentSessionId).toBe(parentId)
  expect(result?.warnings.some((w) => w.includes('resumed or forked'))).toBe(true)
  // event_msg mirrors response_item; counting both would duplicate m1.
  expect(result?.entries?.filter((e) => e.id === 'm1')).toHaveLength(1)
  expect(result?.entries?.map((e) => e.kind)).toEqual(['user', 'assistant'])
})

test('codex: unindexed rollout search streams across chunk boundaries', () => {
  const sessionId = '01a07263-63a3-7082-bbf4-8dfdf600ce9e'
  const file = join(process.env.CODEX_HOME!, 'sessions', '2026', '09', '01', `rollout-2026-09-01T10-00-00-${sessionId}.jsonl`)
  writeJsonl(file, [
    { type: 'session_meta', payload: { id: sessionId, cwd: PROJECT, timestamp: '2026-09-01T10:00:00.000Z' } },
    { type: 'response_item', payload: { type: 'message', id: 'large', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(70_000) }] } },
    { type: 'response_item', payload: { type: 'message', id: 'hit', role: 'user', content: [{ type: 'input_text', text: 'LEGACY-NEEDLE' }] } },
  ])
  const result = findSessions({ query: 'LEGACY-NEEDLE', cwd: PROJECT, harness: 'codex' })
  expect(result.matches[0]?.evidence[0]?.entryId).toBe('hit')
})

function writeGrokSession(sessionId: string): void {
  const dir = join(process.env.GROK_HOME!, 'sessions', encodeURIComponent(PROJECT), sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({
      info: { id: sessionId, cwd: PROJECT },
      session_summary: 'Fix flaky test',
      created_at: '2026-09-01T10:00:00.000Z',
      updated_at: '2026-09-01T10:05:00.000Z',
    }),
  )
  writeJsonl(join(dir, 'chat_history.jsonl'), [
    { type: 'system', content: 'You are Grok.' },
    { type: 'user', content: [{ type: 'text', text: '<user_info>\nWorkspace Path: /x\n</user_info>' }] },
    { type: 'user', content: [{ type: 'text', text: 'the retry test flakes on CI' }] },
    { type: 'assistant', content: 'Looking at the retry helper.', tool_calls: [{ id: 'call-1', name: 'run_terminal_command', arguments: '{"command":"bun test"}' }] },
    { type: 'tool_result', tool_call_id: 'call-1', content: 'exit: 0' },
    { type: 'assistant', content: 'Fixed the timing assumption.' },
  ])
}

test('grok: reads the local store, with cwd taken from the directory name', () => {
  const sessionId = '01a07714-ad3d-78f0-938c-ba32d7214c97'
  writeGrokSession(sessionId)
  const { matches } = findSessions({ query: 'retry test', cwd: PROJECT, harness: 'grok' })
  expect(matches).toHaveLength(1)
  expect(matches[0]?.session.title).toBe('Fix flaky test')
  expect(matches[0]?.session.cwd).toBe(PROJECT)

  const result = readSession(sessionId, {}, 'grok')
  expect(result?.overview?.firstRequest?.text).toBe('the retry test flakes on CI')
  expect(result?.overview?.lastAssistant?.text).toBe('Fixed the timing assumption.')
  // The `<user_info>` prompt frame is injected content, not a request.
  expect(result?.overview?.counts.user).toBe(1)
  expect(result?.session.resumeCommand).toBe(`cd '${PROJECT}' && grok --resume ${sessionId}`)
})

test('search returns entry ids that read --around can expand', () => {
  const sessionId = '01a07714-ad3d-78f0-938c-ba32d7214c97'
  writeGrokSession(sessionId)
  const found = searchSession(sessionId, 'flakes', {}, 'grok')
  expect(found?.hits).toHaveLength(1)
  const hitId = found?.hits[0]?.id
  expect(hitId).toBeDefined()

  const around = readSession(sessionId, { around: hitId }, 'grok')
  expect(around?.view).toBe('around')
  expect(around?.entries?.some((e) => e.id === hitId)).toBe(true)
  expect(around?.warnings.some((w) => w.includes('not found'))).toBe(false)
})

test('budget caps output and hands back a cursor instead of silently cutting', () => {
  const sessionId = '01a07714-ad3d-78f0-938c-ba32d7214c97'
  writeGrokSession(sessionId)
  const first = readSession(sessionId, { view: 'all', limit: 2 }, 'grok')
  expect(first?.entries).toHaveLength(2)
  expect(first?.page.truncated).toBe(true)
  expect(first?.page.nextCursor).toBeDefined()

  const next = readSession(sessionId, { view: 'all', limit: 2, cursor: first?.page.nextCursor }, 'grok')
  expect(next?.entries?.[0]?.id).toBe(first?.page.nextCursor)
})

test('an unknown session id is reported, not guessed', () => {
  expect(readSession('00000000-0000-4000-8000-000000000000')).toBeUndefined()
})
