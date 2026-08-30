import { expect, test } from 'bun:test'
import { claudeAdapter } from '../src/core/adapters/claude.ts'
import { resolveHarnessOutcome } from '../src/core/outcome.ts'
import type { DispatchSpec } from '../src/core/types.ts'

const spec: DispatchSpec = { runId: 'run-1', prompt: 'Reply with exactly: OK' }
const finishedAt = '2026-08-30T00:00:00.000Z'

test('non-zero Claude stdout quota payload becomes an actionable failure', () => {
  const stdout = JSON.stringify({
    is_error: true,
    terminal_reason: 'api_error',
    api_error_status: 429,
    result: "You've hit your weekly limit · resets 3pm (Asia/Shanghai)",
  })
  const patch = resolveHarnessOutcome({
    adapter: claudeAdapter,
    spec,
    exitCode: 1,
    stdout,
    stderr: '',
    finishedAt,
  })

  expect(patch.status).toBe('failed')
  expect(patch.result).toBe(
    'The selected Claude Code harness has no available quota. Choose another harness.',
  )
  expect(patch.failure?.code).toBe('quota_exhausted')
})

test('quota payload still fails defensively if a harness exits zero', () => {
  const stdout = JSON.stringify({
    is_error: true,
    terminal_reason: 'api_error',
    api_error_status: 429,
    result: "You've hit your weekly limit",
  })
  const patch = resolveHarnessOutcome({
    adapter: claudeAdapter,
    spec,
    exitCode: 0,
    stdout,
    stderr: '',
    finishedAt,
  })

  expect(patch.status).toBe('failed')
  expect(patch.failure?.code).toBe('quota_exhausted')
})

test('unclassified non-zero stdout is never collapsed to an empty result', () => {
  const patch = resolveHarnessOutcome({
    adapter: claudeAdapter,
    spec,
    exitCode: 1,
    stdout: 'Unexpected harness failure',
    stderr: '',
    finishedAt,
  })

  expect(patch.status).toBe('failed')
  expect(patch.result).toBe('Unexpected harness failure')
  expect(patch.failure).toBeUndefined()
})

test('unclassified failures preserve both stdout and stderr for the caller', () => {
  const patch = resolveHarnessOutcome({
    adapter: claudeAdapter,
    spec,
    exitCode: 1,
    stdout: 'Structured provider detail',
    stderr: 'Wrapper warning',
    finishedAt,
  })

  expect(patch.result).toBe('[stdout]\nStructured provider detail\n[stderr]\nWrapper warning')
})

test('a silent non-zero exit gets a useful generic result', () => {
  const patch = resolveHarnessOutcome({
    adapter: claudeAdapter,
    spec,
    exitCode: 1,
    stdout: '',
    stderr: '',
    finishedAt,
  })

  expect(patch.result).toBe('Harness exited with code 1 without any output.')
})
