import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunRecord } from '../src/core/types.ts'
import { waitForRun } from '../src/core/runner.ts'
import { insertRun, updateRun } from '../src/core/store.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dianjiang-runner-'))
  process.env.DIANJIANG_HOME = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.DIANJIANG_HOME
})

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'r1',
    harness: 'grok',
    status: 'running',
    cwd: '/tmp/project',
    task: 'do the thing',
    startedAt: '2026-07-17T10:00:00.000Z',
    ...overrides,
  }
}

test('waitForRun returns a terminal run immediately', async () => {
  insertRun(record({ status: 'completed', result: 'done' }))
  const got = await waitForRun('r1', { timeoutMs: 10_000 })
  expect(got?.status).toBe('completed')
  expect(got?.result).toBe('done')
})

test('waitForRun returns undefined for a missing run', async () => {
  expect(await waitForRun('nope')).toBeUndefined()
})

test('waitForRun resolves once the run completes', async () => {
  insertRun(record())
  setTimeout(() => updateRun('r1', { status: 'completed', result: 'late done' }), 120)
  const got = await waitForRun('r1', { pollMs: 25, timeoutMs: 10_000 })
  expect(got?.status).toBe('completed')
  expect(got?.result).toBe('late done')
})

test('waitForRun returns the still-running record on timeout', async () => {
  insertRun(record())
  const started = Date.now()
  const got = await waitForRun('r1', { pollMs: 25, timeoutMs: 100 })
  expect(got?.status).toBe('running')
  // Sanity: it actually waited, but not forever.
  expect(Date.now() - started).toBeGreaterThanOrEqual(100)
  expect(Date.now() - started).toBeLessThan(5_000)
})

test('waitForRun reconciles a dead detached worker to failed', async () => {
  // A pid far above macOS/Linux defaults: the liveness probe must say "dead".
  insertRun(record({ pid: 2 ** 22 }))
  const got = await waitForRun('r1', { timeoutMs: 10_000 })
  expect(got?.status).toBe('failed')
  expect(got?.result).toContain('died before completing')
})
