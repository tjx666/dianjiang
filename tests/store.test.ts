import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunRecord } from '../src/core/types.ts'
import { getRun, insertRun, updateRun } from '../src/core/store.ts'

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
