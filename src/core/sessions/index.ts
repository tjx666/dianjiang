/**
 * Session reading facade: one API over the three harness readers.
 *
 * The contract (see the design skill) is locate + normalize + budget. Callers
 * get evidence and pointers into the raw store, never a promise that what they
 * received is the whole session.
 */

import type { HarnessName } from '../types.ts'
import { HARNESS_NAMES } from '../types.ts'
import { claudeReader } from './claude.ts'
import { codexReader } from './codex.ts'
import { grokReader } from './grok.ts'
import { applyBudget, applyCursor, capText, PREVIEW_CHARS } from './shared.ts'
import type {
  FindOptions,
  LoadedSession,
  SessionEntry,
  SessionEntryKind,
  SessionMatch,
  SessionOverview,
  SessionReadResult,
  SessionReader,
  SessionSearchResult,
  SessionView,
} from './types.ts'

export * from './types.ts'
export { encodeProjectDir } from './claude.ts'
export { DEFAULT_LIMIT, DEFAULT_MAX_CHARS, ENTRY_TEXT_CAP } from './shared.ts'

export const sessionReaders: Record<HarnessName, SessionReader> = {
  claude: claudeReader,
  codex: codexReader,
  grok: grokReader,
}

/** How many entries an overview shows per section. */
const OVERVIEW_REQUESTS = 3
const OVERVIEW_ACTIVITY = 5

/** Text length for entries shown inside an overview. */
const OVERVIEW_TEXT = PREVIEW_CHARS * 3

/** Entries on either side of the target for `read --around`. */
const AROUND_RADIUS = 5

export interface ReadOptions {
  view?: SessionView
  /** For `view: 'around'`: the entry id to center on. */
  around?: string
  /** Resume paging from this entry id (a previous response's `nextCursor`). */
  cursor?: string
  limit?: number
  maxChars?: number
  /**
   * Include injected content (system reminders, attachments, prompt frames).
   * Off by default: it is the bulk of a transcript and none of the conversation.
   */
  includeInjected?: boolean
}

export interface FindResult {
  matches: SessionMatch[]
  warnings: string[]
}

/** Find sessions across every available harness store, newest first. */
export function findSessions(options: FindOptions): FindResult {
  const warnings: string[] = []
  const limit = options.limit ?? 10
  const harnesses = options.harness ? [options.harness] : HARNESS_NAMES
  const matches: SessionMatch[] = []

  for (const harness of harnesses) {
    const reader = sessionReaders[harness]
    if (!reader.available()) {
      warnings.push(`No ${harness} session store on this machine; skipped.`)
      continue
    }
    try {
      const result = reader.find({ ...options, limit })
      matches.push(...result.matches)
      warnings.push(...result.warnings)
    } catch (err) {
      warnings.push(`${harness}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  matches.sort((a, b) => sortKey(b).localeCompare(sortKey(a)))
  return { matches: matches.slice(0, limit), warnings }
}

function sortKey(match: SessionMatch): string {
  return match.session.updatedAt ?? match.session.startedAt ?? ''
}

/**
 * Load one session. With no harness hint every store is tried, because a bare
 * session id does not say which harness wrote it.
 */
export function loadSession(sessionId: string, harness?: HarnessName): LoadedSession | undefined {
  const harnesses = harness ? [harness] : HARNESS_NAMES
  for (const name of harnesses) {
    const reader = sessionReaders[name]
    if (!reader.available()) continue
    try {
      const loaded = reader.load(sessionId)
      if (loaded) return loaded
    } catch {
      // A store that fails to read is not a match; keep trying the others.
    }
  }
  return undefined
}

/** Entries a view should consider, honouring the injected-content default. */
function visibleEntries(entries: SessionEntry[], includeInjected?: boolean): SessionEntry[] {
  return includeInjected ? entries : entries.filter((entry) => entry.kind !== 'injected')
}

function shorten(entry: SessionEntry): SessionEntry {
  const { text, truncated } = capText(entry.text, OVERVIEW_TEXT)
  return { ...entry, text, ...(truncated || entry.truncated ? { truncated: true } : {}) }
}

function buildOverview(entries: SessionEntry[]): { overview: SessionOverview; shown: number } {
  const counts: Partial<Record<SessionEntryKind, number>> = {}
  for (const entry of entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1

  const requests = entries.filter((entry) => entry.kind === 'user')
  const firstRequest = requests[0]
  const recentRequests = requests.slice(-OVERVIEW_REQUESTS).filter((entry) => entry.id !== firstRequest?.id)
  const lastAssistant = entries.filter((entry) => entry.kind === 'assistant').at(-1)
  const recentActivity = entries.filter((entry) => entry.kind === 'tool_call' || entry.kind === 'tool_result').slice(-OVERVIEW_ACTIVITY)

  const overview: SessionOverview = {
    ...(firstRequest ? { firstRequest: shorten(firstRequest) } : {}),
    recentRequests: recentRequests.map(shorten),
    ...(lastAssistant ? { lastAssistant: shorten(lastAssistant) } : {}),
    recentActivity: recentActivity.map(shorten),
    counts,
  }
  const shown = (firstRequest ? 1 : 0) + recentRequests.length + (lastAssistant ? 1 : 0) + recentActivity.length
  return { overview, shown }
}

/**
 * Read one session. The default `overview` view answers "what happened here"
 * without dumping the transcript; `requests` replays only what humans asked;
 * `around` expands one entry in context; `all` walks the whole thing by page.
 */
export function readSession(sessionId: string, options: ReadOptions = {}, harness?: HarnessName): SessionReadResult | undefined {
  const loaded = loadSession(sessionId, harness)
  if (!loaded) return undefined
  const view: SessionView = options.view ?? (options.around ? 'around' : 'overview')
  const entries = visibleEntries(loaded.entries, options.includeInjected)
  const warnings = [...loaded.warnings]

  if (view === 'overview') {
    const { overview, shown } = buildOverview(entries)
    return {
      session: loaded.session,
      view,
      overview,
      page: { returned: shown, selected: shown, total: entries.length, truncated: shown < entries.length },
      warnings,
    }
  }

  let selected: SessionEntry[]
  if (view === 'requests') {
    selected = entries.filter((entry) => entry.kind === 'user')
  } else if (view === 'around') {
    // `around` deliberately searches the FULL entry list: an id worth expanding
    // may be an injected record the default view hides.
    const index = loaded.entries.findIndex((entry) => entry.id === options.around)
    if (index === -1) {
      warnings.push(`Entry ${options.around} not found in this session; showing the tail instead.`)
      selected = entries.slice(-AROUND_RADIUS * 2)
    } else {
      selected = loaded.entries.slice(Math.max(0, index - AROUND_RADIUS), index + AROUND_RADIUS + 1)
    }
  } else {
    selected = entries
  }

  const { entries: budgeted, page } = applyBudget(applyCursor(selected, options.cursor), entries.length, options)
  return { session: loaded.session, view, entries: budgeted, page, warnings }
}

/** Search inside one session; hits carry ids for `read --around`. */
export function searchSession(
  sessionId: string,
  query: string,
  options: ReadOptions = {},
  harness?: HarnessName,
): SessionSearchResult | undefined {
  const loaded = loadSession(sessionId, harness)
  if (!loaded) return undefined
  const needle = query.toLowerCase()
  const entries = visibleEntries(loaded.entries, options.includeInjected)
  const hits = entries.filter((entry) => entry.text.toLowerCase().includes(needle)).map(shorten)
  const { entries: budgeted, page } = applyBudget(applyCursor(hits, options.cursor), hits.length, options)
  return { session: loaded.session, query, hits: budgeted, page, warnings: loaded.warnings }
}
