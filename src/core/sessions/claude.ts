/**
 * Claude Code session reader.
 *
 * Claude is the one harness with no index at all — just JSONL transcripts under
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` — so this is the only
 * reader that parses from scratch. Two transcript facts drive the code:
 *
 * 1. A transcript is a `parentUuid` TREE, not a list. Rewinding or editing a
 *    message starts a new branch and leaves the abandoned one in the file, so a
 *    linear read reports withdrawn requests as real ones. The live chain is
 *    walked back from the last `last-prompt` record's `leafUuid`.
 * 2. `attachment` records dominate by count (190 vs 116 assistant / 69 user in a
 *    sampled session) and carry injected content, not conversation. They are
 *    reduced to a label at load time and never held in full.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { FindOptions, LoadedSession, SessionEntry, SessionInfo, SessionMatch, SessionReader } from './types.ts'
import { capText, claudeProjectsDir, evidencePreview, parseJsonLine, shellQuote } from './shared.ts'

/** Max transcript bytes one `find` call will read before it stops and warns. */
const SCAN_BYTE_BUDGET = 512 * 1024 * 1024

/** Max evidence entries collected per matching session. */
const MAX_EVIDENCE = 3

interface ClaudeRecord {
  type?: string
  uuid?: string
  parentUuid?: string | null
  sessionId?: string
  timestamp?: string
  cwd?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  leafUuid?: string
  aiTitle?: string
  customTitle?: string
  attachment?: { type?: string }
  message?: { role?: string; content?: unknown }
}

/**
 * Claude encodes a cwd into a directory name by replacing `/` and `.` with `-`
 * (`/Users/tj/code/x/.claude/worktrees/y` → `-Users-tj-code-x--claude-worktrees-y`).
 * The mapping is lossy, so it is only ever used to LOOK UP a directory; a
 * session's real cwd is read back from its records.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replaceAll(/[/.]/g, '-')
}

/** Flatten a message `content` (string or block array) into text + block kinds. */
function readContent(content: unknown): { text: string; toolNames: string[]; kinds: Set<string> } {
  const kinds = new Set<string>()
  const toolNames: string[] = []
  if (typeof content === 'string') {
    kinds.add('text')
    return { text: content, toolNames, kinds }
  }
  if (!Array.isArray(content)) return { text: '', toolNames, kinds }
  const parts: string[] = []
  for (const raw of content) {
    const block = raw as { type?: string; text?: string; name?: string; input?: unknown; content?: unknown }
    const type = block.type ?? 'unknown'
    kinds.add(type)
    switch (type) {
      case 'text':
      case 'thinking':
        parts.push(block.text ?? '')
        break
      case 'tool_use':
        if (block.name) toolNames.push(block.name)
        parts.push(`${block.name ?? 'tool'}(${JSON.stringify(block.input ?? {})})`)
        break
      case 'tool_result': {
        const inner = block.content
        parts.push(typeof inner === 'string' ? inner : JSON.stringify(inner ?? ''))
        break
      }
      default:
        parts.push(`[${type}]`)
    }
  }
  return { text: parts.join('\n').trim(), toolNames, kinds }
}

/** Strip `<system-reminder>` blocks; what remains is what a human actually typed. */
function stripInjected(text: string): string {
  return text.replaceAll(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

/**
 * Classify a user-role record. Slash-command plumbing, meta records and
 * reminder-only messages are `injected`; tool results are their own kind.
 */
function classifyUser(record: ClaudeRecord, text: string, kinds: Set<string>): { kind: SessionEntry['kind']; text: string } {
  if (record.isCompactSummary) return { kind: 'compaction', text }
  if (kinds.has('tool_result')) return { kind: 'tool_result', text }
  if (record.isMeta) return { kind: 'injected', text }
  const human = stripInjected(text)
  if (!human) return { kind: 'injected', text }
  if (/^<(command-name|command-message|local-command-stdout|user-prompt-submit-hook)/.test(human)) {
    return { kind: 'injected', text: human }
  }
  return { kind: 'user', text: human }
}

/** Normalize one transcript record; undefined for records that carry no content. */
function toEntry(record: ClaudeRecord, file: string, line: number, fileSessionId: string): SessionEntry | undefined {
  const source = `${file}:${line}`
  const base = {
    timestamp: record.timestamp,
    source,
    // A forked transcript copies the parent's records verbatim, and those keep
    // the PARENT's sessionId — the one reliable inheritance signal here.
    ...(record.sessionId && record.sessionId !== fileSessionId ? { inherited: true } : {}),
    ...(record.isSidechain ? { sidechain: true } : {}),
  }

  if (record.type === 'attachment') {
    // Never hold attachment bodies: they are the bulk of a transcript and none
    // of the conversation. A label is enough to know one was there.
    return { id: record.uuid ?? source, kind: 'injected', text: `[attachment: ${record.attachment?.type ?? 'unknown'}]`, ...base }
  }

  if (record.type === 'user') {
    const { text, kinds } = readContent(record.message?.content)
    if (!text) return undefined
    const classified = classifyUser(record, text, kinds)
    return { id: record.uuid ?? source, kind: classified.kind, ...capText(classified.text), ...base }
  }

  if (record.type === 'assistant') {
    const { text, toolNames, kinds } = readContent(record.message?.content)
    if (!text) return undefined
    const kind: SessionEntry['kind'] = kinds.has('tool_use') ? 'tool_call' : kinds.has('thinking') && kinds.size === 1 ? 'reasoning' : 'assistant'
    return {
      id: record.uuid ?? source,
      kind,
      ...capText(text),
      ...(toolNames.length > 0 ? { tool: toolNames.join(', ') } : {}),
      ...base,
    }
  }

  return undefined
}

/** Conversation-spine records: the ones a rewind actually branches. */
function isSpine(record: ClaudeRecord): boolean {
  return record.type === 'user' || record.type === 'assistant'
}

/**
 * Keep only records on the live branch. Claude appends every attempt to the
 * same file, so after a rewind the file still holds the abandoned messages;
 * walking up `parentUuid` from the newest `leafUuid` yields the chain that
 * actually happened. Sidechain (sub-agent) records hang off their own chains
 * and are kept regardless.
 */
function liveBranchUuids(records: Array<{ record: ClaudeRecord }>): Set<string> | undefined {
  const byUuid = new Map<string, ClaudeRecord>()
  let leaf: string | undefined
  for (const { record } of records) {
    if (record.uuid) byUuid.set(record.uuid, record)
    if (record.type === 'last-prompt' && record.leafUuid) leaf = record.leafUuid
  }
  // No last-prompt record (older transcripts): fall back to the newest record.
  if (!leaf || !byUuid.has(leaf)) {
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const candidate = records[i]?.record
      if (candidate?.uuid && !candidate.isSidechain) {
        leaf = candidate.uuid
        break
      }
    }
  }
  if (!leaf) return undefined
  const live = new Set<string>()
  let cursor: string | undefined = leaf
  while (cursor && byUuid.has(cursor) && !live.has(cursor)) {
    live.add(cursor)
    cursor = byUuid.get(cursor)?.parentUuid ?? undefined
  }
  return live
}

/** All project directories, optionally narrowed to one cwd's encoded name. */
function projectDirs(options: FindOptions): string[] {
  const root = claudeProjectsDir()
  let names: string[]
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
  if (!options.all && options.cwd) {
    const encoded = encodeProjectDir(options.cwd)
    return names.includes(encoded) ? [join(root, encoded)] : []
  }
  return names.map((name) => join(root, name))
}

/** Transcript files under the given dirs, newest first. */
function transcriptFiles(dirs: string[]): Array<{ path: string; mtimeMs: number; size: number }> {
  const files: Array<{ path: string; mtimeMs: number; size: number }> = []
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(dir, name)
      try {
        const stat = statSync(path)
        files.push({ path, mtimeMs: stat.mtimeMs, size: stat.size })
      } catch {
        // A session file can vanish between readdir and stat; skip it.
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function sessionIdOf(path: string): string {
  return basename(path, '.jsonl')
}

/** Newest record carrying a timestamp, scanning from the end of the file. */
function lastTimestampedRecord(lines: string[]): ClaudeRecord | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!line?.trim()) continue
    const record = parseJsonLine<ClaudeRecord>(line)
    if (record?.timestamp) return record
  }
  return undefined
}

function buildInfo(path: string, records: { first?: ClaudeRecord; last?: ClaudeRecord; title?: string }): SessionInfo {
  const sessionId = sessionIdOf(path)
  const cwd = records.first?.cwd
  return {
    sessionId,
    harness: 'claude',
    ...(records.title ? { title: records.title } : {}),
    ...(cwd ? { cwd } : {}),
    ...(records.first?.timestamp ? { startedAt: records.first.timestamp } : {}),
    ...(records.last?.timestamp ? { updatedAt: records.last.timestamp } : {}),
    store: path,
    resumeCommand: cwd ? `cd ${shellQuote(cwd)} && claude --resume ${sessionId}` : `claude --resume ${sessionId}`,
  }
}

export const claudeReader: SessionReader = {
  harness: 'claude',

  available() {
    try {
      return statSync(claudeProjectsDir()).isDirectory()
    } catch {
      return false
    }
  },

  find(options) {
    const limit = options.limit ?? 10
    const needle = options.query?.toLowerCase()
    const files = transcriptFiles(projectDirs(options))
    const matches: SessionMatch[] = []
    const warnings: string[] = []
    let bytesRead = 0
    let scanned = 0

    for (const file of files) {
      if (matches.length >= limit) break
      if (bytesRead + file.size > SCAN_BYTE_BUDGET) {
        warnings.push(
          `claude: stopped after ${scanned} of ${files.length} transcripts (read budget reached); older sessions were not searched.`,
        )
        break
      }
      scanned += 1
      let text: string
      try {
        text = readFileSync(file.path, 'utf8')
      } catch {
        continue
      }
      bytesRead += file.size
      const lines = text.split('\n')

      let first: ClaudeRecord | undefined
      let title: string | undefined
      const evidence: SessionMatch['evidence'] = []
      const fileSessionId = sessionIdOf(file.path)
      // Most lines are skipped by the pre-filter below, so the last timestamp
      // is taken from the final record explicitly — deriving it from whatever
      // line happened to be parsed would report a stale `updatedAt` and
      // mis-sort the results.
      const last = lastTimestampedRecord(lines)

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]
        if (!line) continue
        // Cheap pre-filter: only lines that can matter get JSON-parsed.
        const isTitle = line.includes('"ai-title"') || line.includes('"customTitle"')
        const hit = needle !== undefined && line.toLowerCase().includes(needle)
        if (!isTitle && !hit && first && i !== lines.length - 1) continue
        const record = parseJsonLine<ClaudeRecord>(line)
        if (!record) continue
        if (!first && record.cwd) first = record
        if (record.aiTitle) title = record.aiTitle
        if (record.customTitle) title = record.customTitle
        if (hit && evidence.length < MAX_EVIDENCE) {
          const entry = toEntry(record, file.path, i + 1, fileSessionId)
          if (entry && (options.includeInjected || entry.kind !== 'injected')) {
            evidence.push({
              entryId: entry.id,
              kind: entry.kind,
              preview: evidencePreview(entry.text, line, options.query ?? ''),
              ...(entry.inherited ? { inherited: true } : {}),
            })
          }
        }
      }

      if (needle !== undefined && evidence.length === 0) continue
      matches.push({ session: buildInfo(file.path, { first, last, title }), evidence })
    }

    return { matches, warnings }
  },

  load(sessionId) {
    const dirs = projectDirs({ all: true })
    const path = dirs.map((dir) => join(dir, `${sessionId}.jsonl`)).find((candidate) => {
      try {
        return statSync(candidate).isFile()
      } catch {
        return false
      }
    })
    if (!path) return undefined

    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return undefined
    }

    const warnings: string[] = []
    const lines = text.split('\n')
    const parsed: Array<{ record: ClaudeRecord; line: number }> = []
    let unreadable = 0
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (!line?.trim()) continue
      const record = parseJsonLine<ClaudeRecord>(line)
      if (!record) {
        unreadable += 1
        continue
      }
      parsed.push({ record, line: i + 1 })
    }
    if (unreadable > 0) warnings.push(`${unreadable} unreadable line(s) skipped (a session still being written ends mid-line).`)

    const live = liveBranchUuids(parsed)
    let abandoned = 0
    const entries: SessionEntry[] = []
    let first: ClaudeRecord | undefined
    let last: ClaudeRecord | undefined
    let title: string | undefined

    for (const { record, line } of parsed) {
      if (!first && record.cwd) first = record
      if (record.timestamp) last = record
      if (record.aiTitle) title = record.aiTitle
      if (record.customTitle) title = record.customTitle
      // Abandoned branches are dropped, not silently merged: they are requests
      // the human took back. Only the conversation spine is checked — side
      // records (attachments) hang off a message without being on the chain
      // themselves, so treating them as abandoned would be wrong.
      if (live && record.uuid && !record.isSidechain && isSpine(record) && !live.has(record.uuid)) {
        abandoned += 1
        continue
      }
      const entry = toEntry(record, path, line, sessionId)
      if (entry) entries.push(entry)
    }

    if (abandoned > 0) {
      warnings.push(`${abandoned} record(s) on abandoned branches (rewound or edited) were excluded.`)
    }
    const subagentDir = join(path.replace(/\.jsonl$/, ''), 'subagents')
    try {
      const count = readdirSync(subagentDir).filter((n) => n.endsWith('.jsonl')).length
      if (count > 0) warnings.push(`${count} sub-agent transcript(s) exist in ${subagentDir} and are not included.`)
    } catch {
      // No sub-agent directory: nothing to report.
    }

    return { session: buildInfo(path, { first, last, title }), entries, warnings }
  },
}
