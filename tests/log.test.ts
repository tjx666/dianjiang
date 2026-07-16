import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logEvent } from '../src/core/log.ts'
import { opLogPath } from '../src/core/paths.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dianjiang-log-'))
  process.env.DIANJIANG_HOME = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.DIANJIANG_HOME
})

test('logEvent writes one valid JSONL line per call', () => {
  logEvent('dispatch', { runId: 'r1', harness: 'codex' })
  logEvent('exec.done', { runId: 'r1', exitCode: 0, status: 'completed' })

  const lines = readFileSync(opLogPath(), 'utf8').trim().split('\n')
  expect(lines).toHaveLength(2)
  const [line0, line1] = lines as [string, string]

  const first = JSON.parse(line0)
  expect(first.event).toBe('dispatch')
  expect(first.runId).toBe('r1')
  expect(first.harness).toBe('codex')
  expect(typeof first.ts).toBe('string')
  // ts is a valid ISO-8601 timestamp
  expect(Number.isNaN(Date.parse(first.ts))).toBe(false)

  const second = JSON.parse(line1)
  expect(second.event).toBe('exec.done')
  expect(second.exitCode).toBe(0)
  expect(second.status).toBe('completed')
})

test('logEvent works with no fields', () => {
  logEvent('spawn')
  const line = readFileSync(opLogPath(), 'utf8').trim()
  const parsed = JSON.parse(line)
  expect(parsed.event).toBe('spawn')
  expect(Object.keys(parsed).sort()).toEqual(['event', 'ts'])
})

test('logEvent never throws when the log dir cannot be created', () => {
  // Point DIANJIANG_HOME at a path whose parent is a regular file: mkdir will
  // fail with ENOTDIR. This works even when the test runs as root (unlike
  // chmod-based read-only dirs).
  const blocker = join(home, 'not-a-dir')
  writeFileSync(blocker, 'x')
  process.env.DIANJIANG_HOME = join(blocker, 'home')

  expect(() => logEvent('cli.error', { message: 'boom', exitCode: 1 })).not.toThrow()
})
