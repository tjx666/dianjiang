/**
 * Public library surface. The CLI (src/cli) is one frontend over this; a GUI
 * is another. Nothing in here prints or exits — callers own the presentation.
 */

export * from './types.ts'
export * from './paths.ts'
export * from './registry.ts'
export * from './config-edit.ts'
export * from './store.ts'
export * from './stats.ts'
export * from './runner.ts'
export * from './skill.ts'
export * from './caller.ts'
export * from './adapters/index.ts'
export * from './sessions/index.ts'
export {
  encodeProjectDir,
  findSessions,
  loadSession,
  readSession,
  searchSession,
  sessionReaders,
} from './session-history/index.ts'
export type {
  FindOptions,
  FindResult,
  LoadedSession,
  ReadOptions,
  ReaderFindResult,
  SessionEntry,
  SessionEntryKind,
  SessionInfo as HistoricalSessionInfo,
  SessionMatch,
  SessionOverview,
  SessionPage,
  SessionReadResult,
  SessionReader,
  SessionSearchResult,
  SessionView,
} from './session-history/index.ts'
