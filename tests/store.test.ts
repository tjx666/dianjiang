import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunRecord } from '../src/core/types.ts'
import { getRun, insertRun, listRuns, updateRun } from '../src/core/store.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dianjiang-store-'))
  process.env.DIANJIANG_HOME = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.DIANJIANG_HOME
})

function record(): RunRecord {
  return {
    runId: 'r1',
    agent: 'implement',
    harness: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    status: 'running',
    cwd: '/tmp/project',
    task: 'do the thing',
    startedAt: '2026-07-16T10:00:00.000Z',
  }
}

test('insert + get roundtrip', () => {
  insertRun(record())
  const got = getRun('r1')
  expect(got).toBeDefined()
  expect(got?.runId).toBe('r1')
  expect(got?.agent).toBe('implement')
  expect(got?.harness).toBe('codex')
  expect(got?.model).toBe('gpt-5.6-sol')
  expect(got?.effort).toBe('high')
  expect(got?.status).toBe('running')
  expect(got?.cwd).toBe('/tmp/project')
  expect(got?.task).toBe('do the thing')
  expect(got?.startedAt).toBe('2026-07-16T10:00:00.000Z')
  // unset optional columns come back as undefined, not null
  expect(got?.exitCode).toBeUndefined()
  expect(got?.harnessSessionId).toBeUndefined()
})

test('update patches only the given fields', () => {
  insertRun(record())
  updateRun('r1', {
    status: 'completed',
    exitCode: 0,
    result: 'all done',
    harnessSessionId: 'thread-xyz',
    finishedAt: '2026-07-16T10:03:03.000Z',
  })
  const got = getRun('r1')
  expect(got?.status).toBe('completed')
  expect(got?.exitCode).toBe(0)
  expect(got?.result).toBe('all done')
  expect(got?.harnessSessionId).toBe('thread-xyz')
  expect(got?.finishedAt).toBe('2026-07-16T10:03:03.000Z')
  // untouched fields survive
  expect(got?.task).toBe('do the thing')
})

test('getRun returns undefined for a missing run', () => {
  expect(getRun('nope')).toBeUndefined()
})

test('update with empty patch is a no-op', () => {
  insertRun(record())
  expect(() => updateRun('r1', {})).not.toThrow()
  expect(getRun('r1')?.status).toBe('running')
})

test('usage roundtrips through flat columns', () => {
  insertRun(record())
  updateRun('r1', {
    status: 'completed',
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, turns: 3, costUsd: 0.0123 },
  })
  const got = getRun('r1')
  expect(got?.usage).toEqual({
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 80,
    turns: 3,
    costUsd: 0.0123,
  })
  // totalTokens was never reported → absent from the reconstructed object.
  expect(got?.usage?.totalTokens).toBeUndefined()
})

test('a run with no usage reads back with usage undefined', () => {
  insertRun(record())
  expect(getRun('r1')?.usage).toBeUndefined()
})

test('lazy migration: an OLD-schema DB gains usage columns and old rows survive', () => {
  // Reproduce the real ~/.dianjiang/runs.sqlite that predates the usage columns:
  // create the table WITHOUT them, insert a row, then reopen through the store.
  const path = join(home, 'runs.sqlite')
  const old = new Database(path, { create: true })
  old.exec(`CREATE TABLE runs (
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
    parent_run_id TEXT
  );`)
  old.query(
    `INSERT INTO runs (run_id, harness, status, cwd, task, started_at)
     VALUES ('old1', 'grok', 'completed', '/tmp', 'legacy', '2026-07-16T09:00:00.000Z')`,
  ).run()
  old.close()

  // Reopen via the store: openStore runs the ALTER-TABLE migration.
  const legacy = getRun('old1')
  expect(legacy).toBeDefined()
  expect(legacy?.result).toBeUndefined()
  // Old row reads fine with usage null (undefined).
  expect(legacy?.usage).toBeUndefined()

  // The added columns are usable: a fresh usage write roundtrips.
  updateRun('old1', { usage: { inputTokens: 5, turns: 1 } })
  expect(getRun('old1')?.usage).toEqual({ inputTokens: 5, turns: 1 })
})

test('listRuns returns every run oldest-first', () => {
  insertRun(record())
  insertRun({ ...record(), runId: 'r2', startedAt: '2026-07-16T11:00:00.000Z' })
  const ids = listRuns().map((r) => r.runId)
  expect(ids).toEqual(['r1', 'r2'])
})
