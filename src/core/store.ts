/**
 * SQLite-backed run store (bun:sqlite). One row per dispatched run; the unified
 * `RunReport` is derived from these rows. Columns are snake_case; the RunRecord
 * fields are camelCase, mapped explicitly below.
 */

import { Database } from 'bun:sqlite'
import type { HarnessName, RunRecord, RunStatus, RunUsage } from './types.ts'
import { dbPath } from './paths.ts'

/** Raw DB row shape (snake_case, nullable columns). */
interface Row {
  run_id: string
  agent: string | null
  harness: string
  model: string | null
  effort: string | null
  status: string
  exit_code: number | null
  result: string | null
  harness_session_id: string | null
  cwd: string
  task: string
  started_at: string
  finished_at: string | null
  pid: number | null
  parent_run_id: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  total_tokens: number | null
  turns: number | null
  cost_usd: number | null
}

/**
 * camelCase field -> snake_case column, for dynamic UPDATE building. `usage` is
 * intentionally absent: it maps to the six flat usage columns (USAGE_COLUMNS),
 * not a single column, and is handled specially by insert/update/read.
 */
const FIELD_TO_COLUMN: Record<Exclude<keyof RunRecord, 'usage'>, string> = {
  runId: 'run_id',
  agent: 'agent',
  harness: 'harness',
  model: 'model',
  effort: 'effort',
  status: 'status',
  exitCode: 'exit_code',
  result: 'result',
  harnessSessionId: 'harness_session_id',
  cwd: 'cwd',
  task: 'task',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  pid: 'pid',
  parentRunId: 'parent_run_id',
}

/** RunUsage field -> flat nullable column on `runs`. */
const USAGE_COLUMNS: Record<keyof RunUsage, string> = {
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
  cacheReadTokens: 'cache_read_tokens',
  totalTokens: 'total_tokens',
  turns: 'turns',
  costUsd: 'cost_usd',
}

/**
 * Add any usage columns that a pre-existing DB is missing. Lazy migration: a
 * real populated `~/.dianjiang/runs.sqlite` predates the usage columns, so on
 * every open we reconcile the schema. Old rows read back with usage null.
 */
function ensureUsageColumns(db: Database): void {
  const existing = new Set(
    (db.query('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name),
  )
  for (const column of Object.values(USAGE_COLUMNS)) {
    if (existing.has(column)) continue
    // Only cost is fractional; the token/turn counts are integers.
    const type = column === 'cost_usd' ? 'REAL' : 'INTEGER'
    db.exec(`ALTER TABLE runs ADD COLUMN ${column} ${type};`)
  }
}

/** Open (or create) a store at `path`, ensuring schema + WAL. */
function openStore(path: string): Database {
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    agent TEXT,
    harness TEXT NOT NULL,
    model TEXT,
    effort TEXT,
    status TEXT NOT NULL,
    exit_code INTEGER,
    result TEXT,
    harness_session_id TEXT,
    cwd TEXT NOT NULL,
    task TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    pid INTEGER,
    parent_run_id TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    total_tokens INTEGER,
    turns INTEGER,
    cost_usd REAL
  );`)
  // Bring DBs created before the usage columns up to the current schema.
  ensureUsageColumns(db)
  return db
}

/** Cache one Database per resolved path (tests use per-test temp homes). */
const cache = new Map<string, Database>()

/** Get the store for the active home (DIANJIANG_HOME-aware). */
export function getStore(path = dbPath()): Database {
  let db = cache.get(path)
  if (!db) {
    db = openStore(path)
    cache.set(path, db)
  }
  return db
}

/** Rebuild the usage object from flat columns; all-null → undefined. */
function rowToUsage(row: Row): RunUsage | undefined {
  const usage: RunUsage = {}
  for (const [field, column] of Object.entries(USAGE_COLUMNS)) {
    const value = row[column as keyof Row]
    if (typeof value === 'number') usage[field as keyof RunUsage] = value
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

function rowToRecord(row: Row): RunRecord {
  return {
    runId: row.run_id,
    agent: row.agent ?? undefined,
    harness: row.harness as HarnessName,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    status: row.status as RunStatus,
    exitCode: row.exit_code ?? undefined,
    result: row.result ?? undefined,
    harnessSessionId: row.harness_session_id ?? undefined,
    cwd: row.cwd,
    task: row.task,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    pid: row.pid ?? undefined,
    parentRunId: row.parent_run_id ?? undefined,
    usage: rowToUsage(row),
  }
}

export function insertRun(record: RunRecord, db = getStore()): void {
  const u = record.usage
  db.query(
    `INSERT INTO runs (
      run_id, agent, harness, model, effort, status, exit_code, result,
      harness_session_id, cwd, task, started_at, finished_at, pid, parent_run_id,
      input_tokens, output_tokens, cache_read_tokens, total_tokens, turns, cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.runId,
    record.agent ?? null,
    record.harness,
    record.model ?? null,
    record.effort ?? null,
    record.status,
    record.exitCode ?? null,
    record.result ?? null,
    record.harnessSessionId ?? null,
    record.cwd,
    record.task,
    record.startedAt,
    record.finishedAt ?? null,
    record.pid ?? null,
    record.parentRunId ?? null,
    u?.inputTokens ?? null,
    u?.outputTokens ?? null,
    u?.cacheReadTokens ?? null,
    u?.totalTokens ?? null,
    u?.turns ?? null,
    u?.costUsd ?? null,
  )
}

export function updateRun(runId: string, patch: Partial<RunRecord>, db = getStore()): void {
  const assignments: string[] = []
  const values: (string | number | null)[] = []
  for (const [field, value] of Object.entries(patch)) {
    if (field === 'runId') continue // never update the primary key
    if (field === 'usage') {
      // `usage` fans out to its six flat columns; a present-but-partial usage
      // object writes null for the fields it omits.
      const usage = value as RunUsage | undefined
      for (const [usageField, column] of Object.entries(USAGE_COLUMNS)) {
        assignments.push(`${column} = ?`)
        values.push(usage?.[usageField as keyof RunUsage] ?? null)
      }
      continue
    }
    const column = FIELD_TO_COLUMN[field as keyof typeof FIELD_TO_COLUMN]
    if (!column) continue
    assignments.push(`${column} = ?`)
    values.push(value === undefined ? null : (value as string | number | null))
  }
  if (assignments.length === 0) return
  values.push(runId)
  db.query(`UPDATE runs SET ${assignments.join(', ')} WHERE run_id = ?`).run(...values)
}

export function getRun(runId: string, db = getStore()): RunRecord | undefined {
  const row = db.query('SELECT * FROM runs WHERE run_id = ?').get(runId) as Row | null
  return row ? rowToRecord(row) : undefined
}

/** All runs, oldest first. Backs `dianjiang stats` aggregation. */
export function listRuns(db = getStore()): RunRecord[] {
  const rows = db.query('SELECT * FROM runs ORDER BY started_at ASC').all() as Row[]
  return rows.map(rowToRecord)
}
