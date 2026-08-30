import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { DianjiangConfig, RunRecord } from '../src/core/types.ts'
import { dispatch, specFromRecord, waitForRun } from '../src/core/runner.ts'
import { opLogPath } from '../src/core/paths.ts'
import { insertRun, updateRun } from '../src/core/store.ts'

let home: string
let originalPath: string | undefined
let originalClaudeConfigDir: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dianjiang-runner-'))
  process.env.DIANJIANG_HOME = home
  originalPath = process.env.PATH
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  delete process.env.DIANJIANG_HOME
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
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

function installFakeClaude(binDir: string, source: string): void {
  mkdirSync(binDir, { recursive: true })
  if (platform() === 'win32') {
    writeFileSync(join(binDir, 'claude.js'), source)
    writeFileSync(join(binDir, 'claude.cmd'), '@node "%~dp0\\claude.js" %*\r\n')
    return
  }
  const fakeClaude = join(binDir, 'claude')
  writeFileSync(fakeClaude, `#!/usr/bin/env node\n${source}`)
  chmodSync(fakeClaude, 0o755)
}

test('specFromRecord freezes the record instructions, independent of config', () => {
  // DIANJIANG_HOME points at an empty temp dir (beforeEach) — there is NO config
  // file here, proving specFromRecord never reads the live config.
  const spec = specFromRecord(
    record({ instructions: 'be terse', model: 'grok-4', effort: 'high' }),
  )
  expect(spec.instructions).toBe('be terse')
  expect(spec.runId).toBe('r1')
  expect(spec.prompt).toBe('do the thing')
  expect(spec.model).toBe('grok-4')
  expect(spec.effort).toBe('high')
  expect(spec.resumeSessionId).toBeUndefined()
})

test('specFromRecord passes a resumeSessionId through', () => {
  const spec = specFromRecord(record(), 'session-abc')
  expect(spec.resumeSessionId).toBe('session-abc')
})

test('specFromRecord leaves instructions undefined when the record has none', () => {
  const spec = specFromRecord(record())
  expect(spec.instructions).toBeUndefined()
})

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

test('claude run records safe user-settings snapshots before and after execution', async () => {
  const binDir = join(home, 'bin')
  const claudeConfigDir = join(home, 'claude-config')
  mkdirSync(claudeConfigDir, { recursive: true })
  writeFileSync(
    join(claudeConfigDir, 'settings.json'),
    JSON.stringify({ model: 'fable', effortLevel: 'high', apiKey: 'SECRET_BEFORE' }),
  )

  installFakeClaude(
    binDir,
    `
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ model: 'sonnet', effortLevel: 'medium', apiKey: 'SECRET_AFTER' }))
process.stdout.write(JSON.stringify({ result: 'OK' }))
`,
  )
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir

  const config: DianjiangConfig = { maxDepth: 2, agents: [] }
  const report = await dispatch(
    {
      harness: 'claude',
      model: 'fable',
      effort: 'high',
      task: 'fake task',
      cwd: home,
      detach: false,
    },
    config,
  )
  expect(report.status).toBe('completed')

  const logText = readFileSync(opLogPath(), 'utf8')
  const events = logText.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  const before = events.find((event) => event.event === 'claude.settings.before')
  const after = events.find((event) => event.event === 'claude.settings.after')

  expect(before).toMatchObject({
    runId: report.runId,
    state: 'present',
    model: 'fable',
    effortLevel: 'high',
  })
  expect(after).toMatchObject({
    runId: report.runId,
    state: 'present',
    model: 'sonnet',
    effortLevel: 'medium',
    contentChanged: true,
    modelChanged: true,
    effortLevelChanged: true,
  })
  expect(typeof before?.fingerprint).toBe('string')
  expect(typeof after?.fingerprint).toBe('string')
  expect(typeof before?.inode).toBe('number')
  expect(typeof after?.inode).toBe('number')
  expect(typeof after?.harnessPid).toBe('number')
  expect(logText).not.toContain('apiKey')
  expect(logText).not.toContain('SECRET_BEFORE')
  expect(logText).not.toContain('SECRET_AFTER')
})

test('claude run records the after snapshot when the harness fails', async () => {
  const binDir = join(home, 'bin')
  const claudeConfigDir = join(home, 'claude-config')
  mkdirSync(claudeConfigDir, { recursive: true })
  writeFileSync(join(claudeConfigDir, 'settings.json'), JSON.stringify({ model: 'fable' }))

  installFakeClaude(
    binDir,
    `
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ model: 'sonnet' }))
process.stderr.write('fake harness failure')
process.exit(1)
`,
  )
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir

  const config: DianjiangConfig = { maxDepth: 2, agents: [] }
  const report = await dispatch(
    {
      harness: 'claude',
      task: 'fake failing task',
      cwd: home,
      detach: false,
    },
    config,
  )
  expect(report.status).toBe('failed')

  const events = readFileSync(opLogPath(), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  expect(events.find((event) => event.event === 'claude.settings.after')).toMatchObject({
    runId: report.runId,
    model: 'sonnet',
    contentChanged: true,
    modelChanged: true,
  })
})
