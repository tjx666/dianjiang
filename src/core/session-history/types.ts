/**
 * Contracts for session reading (`dianjiang session`). See the design skill's
 * "Session reading" section: the promise is locate + normalize + budget, NOT
 * faithful replay of a harness transcript.
 */

import type { HarnessName } from '../types.ts'

/**
 * What one normalized transcript entry is. `injected` is deliberately separate
 * from `user`: not every `role=user` record is a human request (system
 * reminders, attachments, queue notifications all arrive as user-role records),
 * and conflating them is how a reader reports "the user asked X" about text no
 * human ever typed.
 */
export type SessionEntryKind =
  | 'user'
  | 'injected'
  | 'assistant'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'compaction'
  | 'other'

/** One normalized entry of a session transcript. */
export interface SessionEntry {
  /** Stable within its session: claude `uuid`, codex `item_id`, grok line index. */
  id: string
  kind: SessionEntryKind
  /** ISO-8601, when the harness recorded one. */
  timestamp?: string
  /** Display text; already capped at load (see ENTRY_TEXT_CAP). */
  text: string
  /** True when `text` is shorter than the stored original. */
  truncated?: boolean
  /** Tool or command name, for `tool_call` / `tool_result`. */
  tool?: string
  /**
   * True when this entry was copied in from a parent session (resume/fork).
   * Inherited records are evidence about the PARENT's execution, not this one.
   */
  inherited?: boolean
  /** True for sub-agent records (claude sidechains, codex sub-agent activity). */
  sidechain?: boolean
  /** Where to look this entry up in the raw store: `path:line` or `db:item_id`. */
  source: string
}

/** Identity and provenance of one session. */
export interface SessionInfo {
  sessionId: string
  harness: HarnessName
  /** Harness-assigned title/summary, when it records one. */
  title?: string
  /** Working directory the session ran in. */
  cwd?: string
  startedAt?: string
  updatedAt?: string
  /**
   * The session this one was resumed or forked from, when the store records it.
   * Its presence means some records here may be inherited history rather than
   * this session's own execution.
   */
  parentSessionId?: string
  /** The file or database the entries were read from. */
  store: string
  /** Copy-pasteable command that resumes this session in its own harness. */
  resumeCommand: string
}

/** A `find` hit: the session plus the entries that matched the query. */
export interface SessionMatch {
  session: SessionInfo
  /** Short previews only — `find` returns grounds for a decision, not content. */
  evidence: Array<{
    entryId: string
    kind: SessionEntryKind
    preview: string
    inherited?: boolean
  }>
}

/** The default `read` view: what happened, without dumping the transcript. */
export interface SessionOverview {
  /** The request the session opened with. */
  firstRequest?: SessionEntry
  /** The most recent human requests (oldest first). */
  recentRequests: SessionEntry[]
  /** The session's last assistant message. */
  lastAssistant?: SessionEntry
  /** The last few tool calls/results — what the session was doing at the end. */
  recentActivity: SessionEntry[]
  /** Entry count per kind, so the caller can see what it is NOT being shown. */
  counts: Partial<Record<SessionEntryKind, number>>
}

/** Paging/budget report. Truncation is always reported, never silent. */
export interface SessionPage {
  /** Entries in this response. */
  returned: number
  /** Entries the view selected before the budget was applied. */
  selected: number
  /** Total normalized entries in the session. */
  total: number
  /** True when entries were dropped or texts cut to fit the budget. */
  truncated: boolean
  /** Pass back as `--cursor` to continue; absent when there is nothing more. */
  nextCursor?: string
}

export type SessionView = 'overview' | 'requests' | 'around' | 'all'

export interface SessionReadResult {
  session: SessionInfo
  view: SessionView
  overview?: SessionOverview
  entries?: SessionEntry[]
  page: SessionPage
  /** Parse gaps, unreadable records, unsupported capabilities. */
  warnings: string[]
}

export interface SessionSearchResult {
  session: SessionInfo
  query: string
  hits: SessionEntry[]
  page: SessionPage
  warnings: string[]
}

/** Everything a reader produces for one session. */
export interface LoadedSession {
  session: SessionInfo
  entries: SessionEntry[]
  warnings: string[]
}

export interface FindOptions {
  /** Case-insensitive substring; omitted means "just list recent sessions". */
  query?: string
  /** Restrict to sessions that ran in this directory; ignored when `all`. */
  cwd?: string
  /** Search every project directory instead of just `cwd`. */
  all?: boolean
  /** Restrict to one harness. */
  harness?: HarnessName
  /** Max sessions to return. */
  limit?: number
  /**
   * Count injected content (prompt frames, skill listings, memory blocks) as
   * evidence. Off by default: those blocks are identical across sessions, so a
   * query that appears in one matches nearly every session in the store.
   */
  includeInjected?: boolean
}

/**
 * One harness's session store. Readers normalize; they never print, and they
 * never claim a capability the underlying store cannot back (see `grok`'s
 * unsupported `--around` note in the design skill).
 */
/** What one reader's `find` produced, including why it may be incomplete. */
export interface ReaderFindResult {
  matches: SessionMatch[]
  /** Scan caps hit, stores skipped — anything that makes the list partial. */
  warnings: string[]
}

export interface SessionReader {
  harness: HarnessName
  /** True when this harness's store exists on this machine. */
  available(): boolean
  find(options: FindOptions): ReaderFindResult
  /** Load and normalize one session; undefined when the id is unknown here. */
  load(sessionId: string): LoadedSession | undefined
}
