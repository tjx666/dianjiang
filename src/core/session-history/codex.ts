/**
 * Codex session reader.
 *
 * Codex maintains its own index — `~/.codex/thread_history_1.sqlite`, where the
 * `thread_items` table already holds typed, id-bearing items per thread — and
 * `codex migrate-rollouts` is the official path moving legacy rollout JSONL into
 * it. So the index is the primary source and the 18 GB of rollout files are the
 * raw view / fallback for threads that were never migrated.
 *
 * Two rules the format forces:
 * - The DB is opened READ-ONLY and its schema is probed first: the `_1` filename
 *   suffix is a version counter with no stability promise, so a mismatch falls
 *   back to rollout parsing instead of failing.
 * - A resumed/forked rollout carries MORE THAN ONE `session_meta` record, and
 *   the first one's `session_id` names the PARENT while its `id` is this
 *   session's own. Reading identity off the last record attributes the parent's
 *   work to the child.
 */

import { existsSync, openSync, readdirSync, readFileSync, readSync, closeSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { openDatabaseReadonly, type SqliteDatabase } from '../sqlite.ts'
import type { FindOptions, LoadedSession, SessionEntry, SessionInfo, SessionMatch, SessionReader } from './types.ts'
import { capText, codexHome, evidencePreview, parseJsonLine, shellQuote } from './shared.ts'

/** Versioned filename; a future codex may ship `_2` with a different schema. */
const DB_FILE = 'thread_history_1.sqlite'

/** Sessions examined per `find` call before the scan stops and warns. */
const SCAN_CAP = 400

/** Total raw rollout bytes a find may inspect when an index has no thread. */
const FALLBACK_BYTE_BUDGET = 128 * 1024 * 1024

const MAX_EVIDENCE = 3

/**
 * Rows pulled per thread before filtering. Injected blocks (the memory and
 * skills preamble) repeat in every session and would otherwise fill the
 * evidence slots with a match that says nothing about this session.
 */
const EVIDENCE_SCAN = 20

/** Bytes read when peeking at a rollout's first line (`session_meta`). */
const FIRST_LINE_BYTES = 256 * 1024

/** Bytes scanned when counting a rollout's `session_meta` records. */
const META_SCAN_BYTES = 512 * 1024

interface RolloutFile {
  sessionId: string
  path: string
  /** Filename timestamp; sorts lexicographically, newest last. */
  stamp: string
}

interface ThreadCandidate {
  sessionId: string
  file?: RolloutFile
  updatedAtMs: number
}

interface SessionMeta {
  ownId?: string
  parentId?: string
  cwd?: string
  startedAt?: string
  metaCount: number
}

/** `rollout-<stamp>-<uuid>.jsonl` under `sessions/YYYY/MM/DD/`, newest first. */
function rolloutFiles(): RolloutFile[] {
  const root = join(codexHome(), 'sessions')
  const files: RolloutFile[] = []
  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < 3) walk(path, depth + 1)
        continue
      }
      const match = /^rollout-(.+)-([0-9a-f-]{36})\.jsonl$/.exec(entry.name)
      if (match?.[1] && match[2]) files.push({ sessionId: match[2], path, stamp: match[1] })
    }
  }
  walk(root, 0)
  return files.sort((a, b) => b.stamp.localeCompare(a.stamp))
}

/** Thread titles live outside the DB, in `session_index.jsonl` (last wins). */
function titleIndex(): Map<string, string> {
  const titles = new Map<string, string>()
  let text: string
  try {
    text = readFileSync(join(codexHome(), 'session_index.jsonl'), 'utf8')
  } catch {
    return titles
  }
  for (const line of text.split('\n')) {
    const record = parseJsonLine<{ id?: string; thread_name?: string }>(line)
    if (record?.id && record.thread_name) titles.set(record.id, record.thread_name)
  }
  return titles
}

/**
 * The head of a file split into whole lines. Rollouts reach gigabytes, so
 * identity is always read from a bounded prefix rather than the whole file; a
 * line cut off by the byte limit is dropped because it cannot parse anyway.
 */
function readHeadLines(path: string, limit: number): string[] {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(limit)
    const bytes = readSync(fd, buffer, 0, limit, 0)
    const lines = buffer.subarray(0, bytes).toString('utf8').split('\n')
    if (bytes === limit) lines.pop()
    return lines
  } catch {
    return []
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Read a file's first line without pulling the whole rollout into memory. */
function readFirstLine(path: string): string | undefined {
  return readHeadLines(path, FIRST_LINE_BYTES)[0]
}

/**
 * Identity from a rollout's `session_meta` records. The FIRST record's `id` is
 * this session; its `session_id` is the thread it continues (equal for a fresh
 * session). Reading the last record instead would report the parent's identity.
 */
function readMeta(path: string, scanAll = false): SessionMeta {
  const meta: SessionMeta = { metaCount: 0 }
  // `scanAll` only has to reach the second `session_meta`, which a resumed
  // rollout writes among its first replayed records — a head scan, never the
  // whole file (rollouts reach gigabytes and the DB read exists to avoid that).
  const lines = scanAll ? readHeadLines(path, META_SCAN_BYTES) : [readFirstLine(path) ?? '']
  for (const line of lines) {
    if (!line.includes('"session_meta"')) continue
    const record = parseJsonLine<{ payload?: { id?: string; session_id?: string; cwd?: string; timestamp?: string } }>(line)
    const payload = record?.payload
    if (!payload) continue
    meta.metaCount += 1
    if (meta.metaCount === 1) {
      meta.ownId = payload.id
      meta.cwd = payload.cwd
      meta.startedAt = payload.timestamp
      if (payload.session_id && payload.session_id !== payload.id) meta.parentId = payload.session_id
    }
    if (!scanAll) break
  }
  return meta
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Open codex's thread history read-only, verifying the schema we rely on. */
function openThreadHistory(): SqliteDatabase | undefined {
  const path = join(codexHome(), DB_FILE)
  if (!existsSync(path)) return undefined
  let db: SqliteDatabase
  try {
    db = openDatabaseReadonly(path)
  } catch {
    return undefined
  }
  try {
    // Schema probe: the columns this reader actually uses must all exist.
    db.query('select thread_id, item_id, item_type, item_json, created_at_ms, rollout_ordinal from thread_items limit 1').get()
    return db
  } catch {
    db.close()
    return undefined
  }
}

interface ThreadItemRow {
  item_id: string
  item_type: string
  item_json: string
  created_at_ms: number
}

/** Text of a codex `content` array (`[{type:'text',text}]`). */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block as { text?: string }).text ?? '')
    .join('\n')
    .trim()
}

/** Injected preambles arrive as user-role text in rollouts (not in the DB). */
function isInjectedUserText(text: string): boolean {
  return /^(# AGENTS\.md instructions|<environment_context>|<user_instructions>|<system-reminder>)/.test(text.trimStart())
}

/** Normalize one `thread_items` row. Unknown types are labelled, never dropped. */
function itemToEntry(row: ThreadItemRow, source: string): SessionEntry | undefined {
  const item = parseJsonLine<Record<string, unknown>>(row.item_json)
  if (!item) return undefined
  const base = {
    id: row.item_id,
    timestamp: row.created_at_ms ? new Date(row.created_at_ms).toISOString() : undefined,
    source,
  }

  switch (row.item_type) {
    case 'userMessage': {
      const text = contentText(item.content)
      if (!text) return undefined
      return { ...base, kind: isInjectedUserText(text) ? 'injected' : 'user', ...capText(text) }
    }
    case 'agentMessage': {
      const text = String(item.text ?? '')
      if (!text) return undefined
      return { ...base, kind: 'assistant', ...capText(text) }
    }
    case 'reasoning': {
      const text = [contentText(item.summary), contentText(item.content)].filter(Boolean).join('\n')
      if (!text) return undefined
      return { ...base, kind: 'reasoning', ...capText(text) }
    }
    case 'commandExecution': {
      const command = String(item.command ?? '')
      const output = String(item.aggregatedOutput ?? '')
      return {
        ...base,
        kind: 'tool_call',
        tool: 'shell',
        ...capText(output ? `$ ${command}\n${output}` : `$ ${command}`),
      }
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? (item.changes as Array<{ path?: string; kind?: { type?: string } }>) : []
      const summary = changes.map((c) => `${c.kind?.type ?? 'change'} ${c.path ?? '?'}`).join('\n')
      return { ...base, kind: 'tool_call', tool: 'apply_patch', ...capText(summary) }
    }
    case 'mcpToolCall': {
      const tool = `${String(item.server ?? 'mcp')}.${String(item.tool ?? 'tool')}`
      const text = `${tool}(${JSON.stringify(item.arguments ?? {})})`
      return { ...base, kind: 'tool_call', tool, ...capText(text) }
    }
    case 'webSearch':
      return { ...base, kind: 'tool_call', tool: 'web_search', ...capText(String(item.query ?? '')) }
    case 'subAgentActivity':
      return {
        ...base,
        kind: 'other',
        sidechain: true,
        ...capText(`sub-agent ${String(item.kind ?? '')} ${String(item.agentPath ?? '')} (thread ${String(item.agentThreadId ?? '?')})`),
      }
    case 'contextCompaction':
      return { ...base, kind: 'compaction', text: '[context compaction]' }
    default:
      return { ...base, kind: 'other', ...capText(`[${row.item_type}] ${JSON.stringify(item).slice(0, 400)}`) }
  }
}

/**
 * Normalize one rollout line. `event_msg` records mirror the response items for
 * display, so only `response_item` records are turned into entries — counting
 * both would report every message twice.
 */
function rolloutLineToEntry(line: string, path: string, lineNumber: number): SessionEntry | undefined {
  const record = parseJsonLine<{ timestamp?: string; type?: string; payload?: Record<string, unknown> }>(line)
  if (!record || record.type !== 'response_item') return undefined
  const payload = record.payload ?? {}
  const source = `${path}:${lineNumber}`
  const base = { id: String(payload.id ?? source), timestamp: record.timestamp, source }

  switch (payload.type) {
    case 'message': {
      const role = String(payload.role ?? '')
      const body = contentText(payload.content)
      if (!body) return undefined
      if (role === 'assistant') return { ...base, kind: 'assistant', ...capText(body) }
      if (role === 'user') return { ...base, kind: isInjectedUserText(body) ? 'injected' : 'user', ...capText(body) }
      return { ...base, kind: 'injected', ...capText(body) }
    }
    case 'reasoning': {
      const body = [contentText(payload.summary), contentText(payload.content)].filter(Boolean).join('\n')
      return body ? { ...base, kind: 'reasoning', ...capText(body) } : undefined
    }
    case 'custom_tool_call':
    case 'function_call': {
      const name = String(payload.name ?? 'tool')
      return { ...base, kind: 'tool_call', tool: name, ...capText(`${name}(${String(payload.input ?? payload.arguments ?? '')})`) }
    }
    case 'custom_tool_call_output':
    case 'function_call_output':
      return { ...base, kind: 'tool_result', ...capText(String(payload.output ?? '')) }
    default:
      return undefined
  }
}

/** Fallback parser for rollouts the thread history never ingested. */
function parseRollout(path: string, sessionId: string): LoadedSession | undefined {
  const text = safeRead(path)
  if (text === undefined) return undefined
  const warnings: string[] = []
  const entries: SessionEntry[] = []
  const lines = text.split('\n')
  let unreadable = 0
  let metaCount = 0
  let meta: SessionMeta = { metaCount: 0 }
  let updatedAt: string | undefined

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line?.trim()) continue
    const record = parseJsonLine<{ timestamp?: string; type?: string; payload?: Record<string, unknown> }>(line)
    if (!record) {
      unreadable += 1
      continue
    }
    if (record.timestamp) updatedAt = record.timestamp

    if (record.type === 'session_meta') {
      metaCount += 1
      if (metaCount === 1) meta = readMetaFromPayload(record.payload ?? {})
      continue
    }

    const entry = rolloutLineToEntry(line, path, i + 1)
    if (entry) entries.push(entry)
  }

  if (unreadable > 0) warnings.push(`${unreadable} unreadable line(s) skipped (a session still being written ends mid-line).`)
  if (metaCount > 1) {
    warnings.push(
      `This rollout carries ${metaCount} session_meta records: it was resumed or forked, so some records may be inherited from ${meta.parentId ?? 'a parent session'}.`,
    )
  }
  warnings.push('Read from the rollout file; this thread is not in codex thread history.')

  return {
    session: buildInfo({
      sessionId: meta.ownId ?? sessionId,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
      updatedAt,
      parentId: meta.parentId,
      store: path,
    }),
    entries,
    warnings,
  }
}

function readMetaFromPayload(payload: Record<string, unknown>): SessionMeta {
  const id = payload.id ? String(payload.id) : undefined
  const sessionId = payload.session_id ? String(payload.session_id) : undefined
  return {
    metaCount: 1,
    ownId: id,
    cwd: payload.cwd ? String(payload.cwd) : undefined,
    startedAt: payload.timestamp ? String(payload.timestamp) : undefined,
    parentId: sessionId && sessionId !== id ? sessionId : undefined,
  }
}

function buildInfo(parts: {
  sessionId: string
  title?: string
  cwd?: string
  startedAt?: string
  updatedAt?: string
  parentId?: string
  store: string
}): SessionInfo {
  return {
    sessionId: parts.sessionId,
    harness: 'codex',
    ...(parts.title ? { title: parts.title } : {}),
    ...(parts.cwd ? { cwd: parts.cwd } : {}),
    ...(parts.startedAt ? { startedAt: parts.startedAt } : {}),
    ...(parts.updatedAt ? { updatedAt: parts.updatedAt } : {}),
    ...(parts.parentId ? { parentSessionId: parts.parentId } : {}),
    store: parts.store,
    resumeCommand: parts.cwd
      ? `codex resume -C ${shellQuote(parts.cwd)} ${parts.sessionId}`
      : `codex resume ${parts.sessionId}`,
  }
}

/** cwd without touching the rollout: any shell item records where it ran. */
function cwdFromDb(db: SqliteDatabase, threadId: string): string | undefined {
  try {
    const row = db
      .query(`select item_json from thread_items where thread_id = ? and item_type = 'commandExecution' limit 1`)
      .get(threadId) as { item_json?: string } | undefined
    if (!row?.item_json) return undefined
    const item = parseJsonLine<{ cwd?: string }>(row.item_json)
    return item?.cwd
  } catch {
    return undefined
  }
}

/**
 * Last activity from the newest item of a thread. `find` sorts across harnesses
 * by this, so a codex session without it would sort by start time and sink
 * below newer-looking sessions it actually outlived. Index-backed reverse
 * lookup on `(thread_id, rollout_ordinal)` — no file read.
 */
function lastActivityFromDb(db: SqliteDatabase, threadId: string): string | undefined {
  try {
    const row = db
      .query('select created_at_ms from thread_items where thread_id = ? order by rollout_ordinal desc limit 1')
      .get(threadId) as { created_at_ms?: number } | undefined
    return row?.created_at_ms ? new Date(row.created_at_ms).toISOString() : undefined
  } catch {
    return undefined
  }
}

/** Include index-only threads while retaining rollout-only fallback sessions. */
function threadCandidates(files: RolloutFile[], db: SqliteDatabase | undefined): ThreadCandidate[] {
  const candidates = new Map<string, ThreadCandidate>()
  for (const file of files) {
    const stamp = file.stamp.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3')
    candidates.set(file.sessionId, { sessionId: file.sessionId, file, updatedAtMs: Date.parse(`${stamp}Z`) || 0 })
  }
  if (db) {
    try {
      // DISTINCT uses the thread-id index; the correlated lookup visits only
      // each thread's final indexed item instead of grouping large item_json rows.
      const rows = db.query(`select ids.thread_id,
        (select created_at_ms from thread_items where thread_id = ids.thread_id
          order by rollout_ordinal desc limit 1) as updated_at_ms
        from (select distinct thread_id from thread_items) ids
        order by updated_at_ms desc limit ${SCAN_CAP + 1}`).all() as Array<{
        thread_id: string
        updated_at_ms: number
      }>
      for (const row of rows) {
        const existing = candidates.get(row.thread_id)
        candidates.set(row.thread_id, {
          sessionId: row.thread_id,
          ...(existing?.file ? { file: existing.file } : {}),
          updatedAtMs: row.updated_at_ms,
        })
      }
    } catch {
      // An unreadable index still leaves the rollout fallback available.
    }
  }
  return [...candidates.values()].sort((a, b) => b.updatedAtMs - a.updatedAtMs)
}

function threadHasItems(db: SqliteDatabase, threadId: string): boolean {
  try {
    return Boolean(db.query('select 1 from thread_items where thread_id = ? limit 1').get(threadId))
  } catch {
    return false
  }
}

/** Scan an unindexed rollout with fixed memory and a caller-owned byte budget. */
function scanRolloutEvidence(
  path: string,
  needle: string,
  includeInjected: boolean | undefined,
  byteBudget: number,
): { evidence: SessionMatch['evidence']; bytesRead: number; complete: boolean } {
  const evidence: SessionMatch['evidence'] = []
  let fd: number | undefined
  let bytesRead = 0
  let complete = false
  let lineNumber = 0
  let pending = ''
  const decoder = new StringDecoder('utf8')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const accept = (line: string): void => {
    lineNumber += 1
    if (!line.toLowerCase().includes(needle.toLowerCase())) return
    const entry = rolloutLineToEntry(line, path, lineNumber)
    if (!entry || (!includeInjected && entry.kind === 'injected')) return
    evidence.push({ entryId: entry.id, kind: entry.kind, preview: evidencePreview(entry.text, line, needle) })
  }
  try {
    fd = openSync(path, 'r')
    while (bytesRead < byteBudget && evidence.length < MAX_EVIDENCE) {
      const size = readSync(fd, buffer, 0, Math.min(buffer.length, byteBudget - bytesRead), null)
      if (size === 0) {
        complete = true
        break
      }
      bytesRead += size
      pending += decoder.write(buffer.subarray(0, size))
      let end: number
      while (evidence.length < MAX_EVIDENCE && (end = pending.indexOf('\n')) !== -1) {
        accept(pending.slice(0, end))
        pending = pending.slice(end + 1)
      }
    }
    if (complete && pending.trim() && evidence.length < MAX_EVIDENCE) accept(pending + decoder.end())
  } catch {
    complete = false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return { evidence, bytesRead, complete: complete || evidence.length >= MAX_EVIDENCE }
}

export const codexReader: SessionReader = {
  harness: 'codex',

  available() {
    return existsSync(join(codexHome(), 'sessions')) || existsSync(join(codexHome(), DB_FILE))
  },

  find(options) {
    const limit = options.limit ?? 10
    const needle = options.query
    const files = rolloutFiles()
    const titles = titleIndex()
    const db = openThreadHistory()
    const candidates = threadCandidates(files, db)
    const matches: SessionMatch[] = []
    const warnings: string[] = []
    let fallbackBytesRead = 0
    let skippedUnknownCwd = 0
    if (!db) warnings.push('codex thread history is unavailable (missing DB or unexpected schema); falling back to rollout files.')

    try {
      let scanned = 0
      for (const candidate of candidates) {
        if (matches.length >= limit) break
        if (scanned >= SCAN_CAP) {
          warnings.push(
            `codex: stopped after the ${SCAN_CAP} newest of ${candidates.length} sessions; older sessions were not searched.`,
          )
          break
        }
        scanned += 1
        const { file, sessionId } = candidate

        // cwd first: the DB answers without reading the 18 GB of rollouts.
        let cwd = db ? cwdFromDb(db, sessionId) : undefined
        let meta: SessionMeta | undefined
        if (!cwd && file) {
          meta = readMeta(file.path)
          cwd = meta.cwd
        }
        if (!options.all && options.cwd && !cwd) {
          skippedUnknownCwd += 1
          continue
        }
        if (!options.all && options.cwd && cwd !== options.cwd) continue

        const evidence: SessionMatch['evidence'] = []
        if (needle !== undefined) {
          const rows = db ? queryEvidence(db, sessionId, needle) : []
          if (rows.length > 0) {
            for (const row of rows) {
              if (evidence.length >= MAX_EVIDENCE) break
              const entry = itemToEntry(row, `db:${row.item_id}`)
              if (!entry) continue
              if (!options.includeInjected && entry.kind === 'injected') continue
              evidence.push({
                entryId: entry.id,
                kind: entry.kind,
                preview: evidencePreview(entry.text, row.item_json, needle),
              })
            }
          } else if (file && (!db || !threadHasItems(db, sessionId))) {
            const remaining = FALLBACK_BYTE_BUDGET - fallbackBytesRead
            if (remaining <= 0) {
              warnings.push(`codex: raw rollout search stopped at the ${FALLBACK_BYTE_BUDGET} byte read budget.`)
              break
            }
            const scannedFile = scanRolloutEvidence(file.path, needle, options.includeInjected, remaining)
            fallbackBytesRead += scannedFile.bytesRead
            evidence.push(...scannedFile.evidence)
            if (!scannedFile.complete) {
              warnings.push(`codex: raw rollout search stopped within ${sessionId} at the byte read budget.`)
              break
            }
          }
          if (evidence.length === 0) continue
        }

        meta ??= file ? readMeta(file.path) : undefined
        matches.push({
          session: buildInfo({
            sessionId: meta?.ownId ?? sessionId,
            title: titles.get(sessionId),
            cwd,
            startedAt: meta?.startedAt,
            updatedAt: db ? lastActivityFromDb(db, sessionId) : undefined,
            parentId: meta?.parentId,
            store: file?.path ?? join(codexHome(), DB_FILE),
          }),
          evidence,
        })
      }
    } finally {
      db?.close()
    }

    if (skippedUnknownCwd > 0) {
      warnings.push(`codex: ${skippedUnknownCwd} session(s) have no recorded cwd and were skipped; use --all to include them.`)
    }

    return { matches, warnings }
  },

  load(sessionId) {
    const file = rolloutFiles().find((f) => f.sessionId === sessionId)
    const db = openThreadHistory()
    try {
      if (db) {
        let rows: ThreadItemRow[] = []
        try {
          rows = db
            .query('select item_id, item_type, item_json, created_at_ms from thread_items where thread_id = ? order by rollout_ordinal')
            .all(sessionId) as ThreadItemRow[]
        } catch {
          rows = []
        }
        if (rows.length > 0) {
          const warnings: string[] = []
          const entries: SessionEntry[] = []
          for (const row of rows) {
            const entry = itemToEntry(row, `db:${row.item_id}`)
            if (entry) entries.push(entry)
          }
          const meta = file ? readMeta(file.path, true) : { metaCount: 0 }
          if (meta.metaCount > 1) {
            warnings.push(
              `This session was resumed or forked from ${meta.parentId ?? 'a parent session'}; records inherited from the parent may be present.`,
            )
          }
          const first = rows[0]
          const last = rows.at(-1)
          return {
            session: buildInfo({
              sessionId,
              title: titleIndex().get(sessionId),
              cwd: meta.cwd ?? cwdFromDb(db, sessionId),
              startedAt: meta.startedAt ?? (first ? new Date(first.created_at_ms).toISOString() : undefined),
              updatedAt: last ? new Date(last.created_at_ms).toISOString() : undefined,
              parentId: meta.parentId,
              store: join(codexHome(), DB_FILE),
            }),
            entries,
            warnings,
          }
        }
      }
    } finally {
      db?.close()
    }
    return file ? parseRollout(file.path, sessionId) : undefined
  },
}

/** Evidence rows for a query, scoped to one thread so the index stays indexed. */
function queryEvidence(db: SqliteDatabase, threadId: string, needle: string): ThreadItemRow[] {
  try {
    return db
      .query(
        `select item_id, item_type, item_json, created_at_ms from thread_items
         where thread_id = ? and instr(lower(item_json), lower(?)) > 0 order by rollout_ordinal limit ${EVIDENCE_SCAN}`,
      )
      .all(threadId, needle) as ThreadItemRow[]
  } catch {
    return []
  }
}
