/**
 * Grok Build session reader.
 *
 * Grok stores sessions as `~/.grok/sessions/<url-encoded-cwd>/<session-id>/`,
 * with `summary.json` (id, cwd, timestamps, model) next to a structured
 * `chat_history.jsonl`. Reading that store directly beats the two CLI surfaces:
 * `grok sessions list` prints a human table with no `--json`, and
 * `grok export` emits markdown with no per-entry ids, which `read --around`
 * needs. It is also the only reader that gets cwd filtering for free — the
 * directory name IS the cwd.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { FindOptions, LoadedSession, SessionEntry, SessionInfo, SessionMatch, SessionReader } from './types.ts'
import { capText, evidencePreview, grokHome, parseJsonLine, shellQuote } from './shared.ts'

const MAX_EVIDENCE = 3

interface GrokSummary {
  info?: { id?: string; cwd?: string }
  session_summary?: string
  created_at?: string
  updated_at?: string
}

interface GrokRecord {
  type?: string
  id?: string
  content?: unknown
  tool_calls?: Array<{ id?: string; name?: string; arguments?: string }>
  tool_call_id?: string
  summary?: Array<{ text?: string }>
}

interface GrokSessionDir {
  sessionId: string
  dir: string
  cwd: string
  mtimeMs: number
}

function sessionsRoot(): string {
  return join(grokHome(), 'sessions')
}

/** Every `<cwd>/<session-id>` directory, newest first. */
function sessionDirs(options: FindOptions): GrokSessionDir[] {
  const root = sessionsRoot()
  const out: GrokSessionDir[] = []
  let cwdDirs: string[]
  try {
    cwdDirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return out
  }
  for (const encoded of cwdDirs) {
    // The directory name is the URL-encoded cwd, so filtering costs no reads.
    let cwd: string
    try {
      cwd = decodeURIComponent(encoded)
    } catch {
      cwd = encoded
    }
    if (!options.all && options.cwd && cwd !== options.cwd) continue
    let children: string[]
    try {
      children = readdirSync(join(root, encoded))
    } catch {
      continue
    }
    for (const child of children) {
      const dir = join(root, encoded, child)
      try {
        const stat = statSync(dir)
        if (!stat.isDirectory()) continue
        out.push({ sessionId: child, dir, cwd, mtimeMs: stat.mtimeMs })
      } catch {
        // Removed between readdir and stat; skip.
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function readSummary(dir: string): GrokSummary | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as GrokSummary
  } catch {
    return undefined
  }
}

function buildInfo(session: GrokSessionDir, summary: GrokSummary | undefined): SessionInfo {
  const title = summary?.session_summary?.trim()
  return {
    sessionId: summary?.info?.id ?? session.sessionId,
    harness: 'grok',
    ...(title ? { title } : {}),
    cwd: summary?.info?.cwd ?? session.cwd,
    ...(summary?.created_at ? { startedAt: summary.created_at } : {}),
    ...(summary?.updated_at ? { updatedAt: summary.updated_at } : {}),
    store: join(session.dir, 'chat_history.jsonl'),
    resumeCommand: `cd ${shellQuote(summary?.info?.cwd ?? session.cwd)} && grok --resume ${session.sessionId}`,
  }
}

/** Grok content is a string or a block array; both carry plain text. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block as { text?: string }).text ?? '')
    .join('\n')
    .trim()
}

/**
 * The whole prompt frame (user info, rules, skills listing) is delivered as
 * user-role text here, so wrapper-tag detection is what separates a request
 * from the scaffolding around it.
 */
function isInjectedUserText(text: string): boolean {
  return /^(<user_info>|<system-reminder>|<rules>|<environment_context>)/.test(text.trimStart())
}

function toEntry(record: GrokRecord, file: string, line: number): SessionEntry | undefined {
  const id = record.id ?? record.tool_call_id ?? `L${line}`
  const source = `${file}:${line}`
  switch (record.type) {
    case 'system':
      return { id, kind: 'injected', ...capText(contentText(record.content)), source }
    case 'user': {
      const text = contentText(record.content)
      if (!text) return undefined
      return { id, kind: isInjectedUserText(text) ? 'injected' : 'user', ...capText(text), source }
    }
    case 'assistant': {
      const text = contentText(record.content)
      const calls = record.tool_calls ?? []
      if (calls.length > 0) {
        const rendered = calls.map((call) => `${call.name ?? 'tool'}(${call.arguments ?? ''})`).join('\n')
        return {
          id: calls[0]?.id ?? id,
          kind: 'tool_call',
          tool: calls.map((call) => call.name ?? 'tool').join(', '),
          ...capText(text ? `${text}\n${rendered}` : rendered),
          source,
        }
      }
      if (!text) return undefined
      return { id, kind: 'assistant', ...capText(text), source }
    }
    case 'reasoning': {
      const text = (record.summary ?? []).map((s) => s.text ?? '').join('\n').trim()
      if (!text) return undefined
      return { id, kind: 'reasoning', ...capText(text), source }
    }
    case 'tool_result':
      return { id, kind: 'tool_result', ...capText(contentText(record.content)), source }
    default:
      return { id, kind: 'other', ...capText(`[${record.type ?? 'unknown'}]`), source }
  }
}

/** Raw transcript lines, for previewing hits that sit past an entry's text cap. */
function readRawLines(dir: string): string[] {
  try {
    return readFileSync(join(dir, 'chat_history.jsonl'), 'utf8').split('\n')
  } catch {
    return []
  }
}

/** Line number out of an entry's `path:line` source pointer. */
function lineOf(source: string): number {
  return Number(source.slice(source.lastIndexOf(':') + 1)) || 0
}

function loadDir(session: GrokSessionDir): LoadedSession | undefined {
  const file = join(session.dir, 'chat_history.jsonl')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const warnings: string[] = []
  const entries: SessionEntry[] = []
  const lines = text.split('\n')
  let unreadable = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line?.trim()) continue
    const record = parseJsonLine<GrokRecord>(line)
    if (!record) {
      unreadable += 1
      continue
    }
    const entry = toEntry(record, file, i + 1)
    if (entry) entries.push(entry)
  }
  if (unreadable > 0) warnings.push(`${unreadable} unreadable line(s) skipped (a session still being written ends mid-line).`)
  return { session: buildInfo(session, readSummary(session.dir)), entries, warnings }
}

export const grokReader: SessionReader = {
  harness: 'grok',

  available() {
    try {
      return statSync(sessionsRoot()).isDirectory()
    } catch {
      return false
    }
  },

  find(options) {
    const limit = options.limit ?? 10
    const needle = options.query?.toLowerCase()
    const matches: SessionMatch[] = []

    for (const session of sessionDirs(options)) {
      if (matches.length >= limit) break
      const summary = readSummary(session.dir)
      const evidence: SessionMatch['evidence'] = []
      if (needle !== undefined) {
        const loaded = loadDir(session)
        if (!loaded) continue
        const rawLines = readRawLines(session.dir)
        for (const entry of loaded.entries) {
          if (evidence.length >= MAX_EVIDENCE) break
          if (!options.includeInjected && entry.kind === 'injected') continue
          const raw = rawLines[lineOf(entry.source) - 1] ?? entry.text
          if (entry.text.toLowerCase().includes(needle) || raw.toLowerCase().includes(needle)) {
            evidence.push({ entryId: entry.id, kind: entry.kind, preview: evidencePreview(entry.text, raw, needle) })
          }
        }
        if (evidence.length === 0) continue
      }
      matches.push({ session: buildInfo(session, summary), evidence })
    }
    return { matches, warnings: [] }
  },

  load(sessionId) {
    const session = sessionDirs({ all: true }).find((s) => s.sessionId === sessionId)
    return session ? loadDir(session) : undefined
  },
}
