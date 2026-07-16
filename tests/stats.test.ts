import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunRecord } from '../src/core/types.ts'
import { computeStats } from '../src/core/stats.ts'
import { insertRun, listRuns } from '../src/core/store.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dianjiang-stats-'))
  process.env.DIANJIANG_HOME = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.DIANJIANG_HOME
})

function run(overrides: Partial<RunRecord>): RunRecord {
  return {
    runId: crypto.randomUUID(),
    harness: 'codex',
    status: 'completed',
    cwd: '/tmp',
    task: 't',
    startedAt: '2026-07-16T10:00:00.000Z',
    finishedAt: '2026-07-16T10:00:10.000Z', // +10s
    ...overrides,
  }
}

test('empty store → empty array', () => {
  expect(computeStats(listRuns())).toEqual([])
})

test('aggregates per agent with token sums and null semantics', () => {
  // Two `implement` runs on claude: one reports full usage incl. cost, the
  // other reports nothing.
  insertRun(
    run({
      agent: 'implement',
      harness: 'claude',
      finishedAt: '2026-07-16T10:00:20.000Z', // +20s
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, turns: 2, costUsd: 0.01 },
    }),
  )
  insertRun(run({ agent: 'implement', harness: 'claude', status: 'failed' /* +10s, no usage */ }))
  // A raw codex dispatch (agent null) with tokens but no cost.
  insertRun(
    run({ harness: 'codex', usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 10, turns: 1 } }),
  )

  const stats = computeStats(listRuns())
  expect(stats.length).toBe(2)

  const impl = stats.find((s) => s.agent === 'implement')!
  expect(impl.harness).toBe('claude')
  expect(impl.runs).toBe(2)
  expect(impl.completed).toBe(1)
  expect(impl.failed).toBe(1)
  expect(impl.totalDurationMs).toBe(30_000) // 20s + 10s
  expect(impl.avgDurationMs).toBe(15_000)
  // Sums come only from the reporting run.
  expect(impl.inputTokens).toBe(100)
  expect(impl.outputTokens).toBe(20)
  expect(impl.cacheReadTokens).toBe(80)
  expect(impl.turns).toBe(2)
  expect(impl.costUsd).toBe(0.01)
  // No run reported totalTokens → null.
  expect(impl.totalTokens).toBeNull()

  const raw = stats.find((s) => s.agent === null)!
  expect(raw.harness).toBe('codex')
  expect(raw.runs).toBe(1)
  expect(raw.inputTokens).toBe(50)
  // codex reports no cost → null.
  expect(raw.costUsd).toBeNull()
})

test('sums the same field across multiple reporting runs', () => {
  insertRun(run({ agent: 'explore', harness: 'grok', usage: { inputTokens: 10, turns: 1 } }))
  insertRun(run({ agent: 'explore', harness: 'grok', usage: { inputTokens: 5, turns: 3 } }))
  const entry = computeStats(listRuns())[0]!
  expect(entry.inputTokens).toBe(15)
  expect(entry.turns).toBe(4)
})

test('--agent filter restricts to one group', () => {
  insertRun(run({ agent: 'implement', harness: 'claude' }))
  insertRun(run({ agent: 'explore', harness: 'grok' }))
  const stats = computeStats(listRuns(), 'explore')
  expect(stats.length).toBe(1)
  expect(stats[0]?.agent).toBe('explore')
})

test('a group with only running runs has null durations', () => {
  insertRun(run({ agent: 'implement', harness: 'claude', status: 'running', finishedAt: undefined }))
  const entry = computeStats(listRuns())[0]!
  expect(entry.completed).toBe(0)
  expect(entry.failed).toBe(0)
  expect(entry.totalDurationMs).toBe(0)
  expect(entry.avgDurationMs).toBeNull()
})

test('raw dispatches group per harness', () => {
  insertRun(run({ harness: 'codex' }))
  insertRun(run({ harness: 'grok' }))
  const stats = computeStats(listRuns())
  expect(stats.map((s) => s.harness).sort()).toEqual(['codex', 'grok'])
  expect(stats.every((s) => s.agent === null)).toBe(true)
})
