/**
 * Helpers shared by the three session readers: store locations, text capping,
 * and the output budget. Nothing here is harness-specific.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionEntry, SessionPage } from './types.ts'

/**
 * Max characters kept per entry at load time. Entries are held in memory for a
 * whole session, and a single codex `commandExecution` can carry 70 KB of
 * output, so the cap is what keeps `read` bounded. Deeper inspection goes
 * through the entry's `source` pointer into the raw store.
 */
export const ENTRY_TEXT_CAP = 4000

/** Preview length used by `find` evidence and overview lists. */
export const PREVIEW_CHARS = 200

/** Default number of entries a non-overview view returns. */
export const DEFAULT_LIMIT = 20

/** Default output budget in characters, across all entry texts in a response. */
export const DEFAULT_MAX_CHARS = 16_000

/** Claude Code's transcript root; `CLAUDE_CONFIG_DIR` is the official override. */
export function claudeProjectsDir(): string {
  const home = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(home, 'projects')
}

/** Codex home; `CODEX_HOME` is the official override. */
export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex')
}

/** Grok home; `GROK_HOME` mirrors the other two for test isolation. */
export function grokHome(): string {
  return process.env.GROK_HOME ?? join(homedir(), '.grok')
}

/** Single-quote a path for a copy-pasteable POSIX shell command. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Collapse whitespace and cut to `max`, marking the cut with an ellipsis. */
export function preview(text: string, max = PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/**
 * Preview centered on the matched text. A hit is often thousands of characters
 * into a tool result, so a head-of-text preview would show the caller something
 * unrelated to why the session matched.
 */
export function previewAround(text: string, needle: string, max = PREVIEW_CHARS): string {
  const at = text.toLowerCase().indexOf(needle.toLowerCase())
  if (at === -1) return preview(text, max)
  const start = Math.max(0, at - Math.floor(max / 3))
  const slice = text.slice(start, start + max)
  const flat = slice.replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${flat}${start + max < text.length ? '…' : ''}`
}

/**
 * Preview for a `find` hit. Entry text is capped at load, but a match often
 * sits deep inside a large tool result, past that cap — so when the needle is
 * not in the normalized text, the raw record is previewed instead. Showing the
 * head of an unrelated paragraph would misrepresent why the session matched.
 */
export function evidencePreview(entryText: string, rawRecord: string, needle: string): string {
  if (!needle) return preview(entryText)
  if (entryText.toLowerCase().includes(needle.toLowerCase())) return previewAround(entryText, needle)
  return previewAround(rawRecord, needle)
}

/** Cap stored entry text, reporting whether anything was cut. */
export function capText(text: string, cap = ENTRY_TEXT_CAP): { text: string; truncated?: boolean } {
  if (text.length <= cap) return { text }
  return { text: `${text.slice(0, cap)}…`, truncated: true }
}

/** Parse a JSON line, returning undefined instead of throwing on a bad line. */
export function parseJsonLine<T = Record<string, unknown>>(line: string): T | undefined {
  if (!line.trim()) return undefined
  try {
    return JSON.parse(line) as T
  } catch {
    return undefined
  }
}

/**
 * Trim a selection of entries to the output budget. Entries are returned in
 * order; when the budget runs out the rest are dropped and `nextCursor` carries
 * the id of the first dropped entry. Truncation is always reported so a caller
 * can never mistake a budgeted answer for the whole story.
 */
export function applyBudget(
  selected: SessionEntry[],
  total: number,
  options: { limit?: number; maxChars?: number } = {},
): { entries: SessionEntry[]; page: SessionPage } {
  const limit = options.limit ?? DEFAULT_LIMIT
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const kept: SessionEntry[] = []
  let used = 0
  let truncated = false
  let nextCursor: string | undefined

  for (const entry of selected) {
    if (kept.length >= limit) {
      nextCursor = entry.id
      truncated = true
      break
    }
    const remaining = maxChars - used
    if (remaining <= 0) {
      nextCursor = entry.id
      truncated = true
      break
    }
    if (entry.text.length > remaining) {
      kept.push({ ...entry, text: `${entry.text.slice(0, remaining)}…`, truncated: true })
      used = maxChars
      truncated = true
      continue
    }
    kept.push(entry)
    used += entry.text.length
    if (entry.truncated) truncated = true
  }

  return {
    entries: kept,
    page: {
      returned: kept.length,
      selected: selected.length,
      total,
      truncated: truncated || selected.length < total,
      ...(nextCursor ? { nextCursor } : {}),
    },
  }
}

/** Drop everything before `cursor` (inclusive start at the cursor entry). */
export function applyCursor(entries: SessionEntry[], cursor?: string): SessionEntry[] {
  if (!cursor) return entries
  const index = entries.findIndex((e) => e.id === cursor)
  return index === -1 ? entries : entries.slice(index)
}
