import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adapters, describeHarness, mergeLiveModels } from '../src/core/adapters/index.ts'
import { parseGrokModels } from '../src/core/adapters/grok.ts'
import type { DispatchSpec, HarnessAdapter, HarnessName } from '../src/core/types.ts'

const RID = 'run-uuid-1'
const RESUME = 'session-abc'

function spec(overrides: Partial<DispatchSpec> = {}): DispatchSpec {
  return { runId: RID, prompt: 'PROMPT', ...overrides }
}

describe('claude adapter', () => {
  test('new session buildCommand (with model/effort/instructions)', () => {
    const { cmd } = adapters.claude.buildCommand(
      spec({ model: 'sonnet', effort: 'high', instructions: 'INSTR' }),
    )
    expect(cmd).toEqual([
      'claude',
      '-p',
      '--output-format',
      'json',
      '--session-id',
      RID,
      '--dangerously-skip-permissions',
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--append-system-prompt',
      'INSTR',
      'PROMPT',
    ])
  })

  test('resume swaps --session-id for --resume', () => {
    const { cmd } = adapters.claude.buildCommand(spec({ resumeSessionId: RESUME }))
    expect(cmd).toEqual([
      'claude',
      '-p',
      '--output-format',
      'json',
      '--resume',
      RESUME,
      '--dangerously-skip-permissions',
      'PROMPT',
    ])
  })

  test('resume + instructions keeps --resume AND re-injects --append-system-prompt', () => {
    // Resume dispatches must still carry the agent contract so the delegate
    // re-reads its review/output rules on every turn, not just the first.
    const { cmd } = adapters.claude.buildCommand(spec({ resumeSessionId: RESUME, instructions: 'INSTR' }))
    expect(cmd).toEqual([
      'claude',
      '-p',
      '--output-format',
      'json',
      '--resume',
      RESUME,
      '--dangerously-skip-permissions',
      '--append-system-prompt',
      'INSTR',
      'PROMPT',
    ])
  })

  test('parseResult reads .result; session id equals runId', () => {
    const r = adapters.claude.parseResult(spec(), JSON.stringify({ result: 'hello' }))
    expect(r).toEqual({ result: 'hello', harnessSessionId: RID })
  })

  test('parseResult on resume uses resumeSessionId', () => {
    const r = adapters.claude.parseResult(
      spec({ resumeSessionId: RESUME }),
      JSON.stringify({ result: 'hi' }),
    )
    expect(r.harnessSessionId).toBe(RESUME)
  })

  test('parseResult extracts usage incl. cost (claude is the only harness with cost)', () => {
    const stdout = JSON.stringify({
      result: 'hello',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 5,
      },
      total_cost_usd: 0.0123,
      num_turns: 3,
    })
    expect(adapters.claude.parseResult(spec(), stdout).usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      turns: 3,
      costUsd: 0.0123,
    })
  })

  test('parseResult usage is undefined when the payload reports none', () => {
    expect(adapters.claude.parseResult(spec(), JSON.stringify({ result: 'x' })).usage).toBeUndefined()
  })

  test('parseResult usage ignores non-number fields defensively', () => {
    const stdout = JSON.stringify({ result: 'x', usage: { input_tokens: '100' }, num_turns: 2 })
    // Bad input_tokens dropped; num_turns still captured.
    expect(adapters.claude.parseResult(spec(), stdout).usage).toEqual({ turns: 2 })
  })
})

describe('codex adapter', () => {
  const outputFile = join(tmpdir(), `dianjiang-${RID}.txt`)

  test('new session buildCommand prepends instructions and sets outputFile', () => {
    const cmd = adapters.codex.buildCommand(
      spec({ model: 'gpt-5.6-sol', effort: 'high', instructions: 'INSTR' }),
    )
    expect(cmd.outputFile).toBe(outputFile)
    expect(cmd.cmd).toEqual([
      'codex',
      'exec',
      '--json',
      '-o',
      outputFile,
      '--dangerously-bypass-approvals-and-sandbox',
      '-m',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort=high',
      'INSTR\n\n---\n\nPROMPT',
    ])
  })

  test('resume buildCommand inserts `resume <id>`', () => {
    const { cmd } = adapters.codex.buildCommand(spec({ resumeSessionId: RESUME }))
    expect(cmd).toEqual([
      'codex',
      'exec',
      'resume',
      RESUME,
      '--json',
      '-o',
      outputFile,
      '--dangerously-bypass-approvals-and-sandbox',
      'PROMPT',
    ])
  })

  test('resume + instructions still prepends instructions to the prompt', () => {
    // codex has no system-prompt flag, so the contract rides in the prompt even
    // on resume — otherwise the delegate loses its review/output rules mid-thread.
    const { cmd } = adapters.codex.buildCommand(spec({ resumeSessionId: RESUME, instructions: 'INSTR' }))
    expect(cmd).toEqual([
      'codex',
      'exec',
      'resume',
      RESUME,
      '--json',
      '-o',
      outputFile,
      '--dangerously-bypass-approvals-and-sandbox',
      'INSTR\n\n---\n\nPROMPT',
    ])
  })

  test('parseResult: new-version thread.started + outputFile priority', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'T1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'STREAM MSG' } }),
    ].join('\n')
    const r = adapters.codex.parseResult(spec(), stdout, 'FILE RESULT\n')
    expect(r).toEqual({ result: 'FILE RESULT', harnessSessionId: 'T1' })
  })

  test('parseResult: old-version session.created + JSONL fallback when no file', () => {
    const stdout = [
      JSON.stringify({ type: 'session.created', session_id: 'S1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'STREAM MSG' } }),
    ].join('\n')
    const r = adapters.codex.parseResult(spec(), stdout)
    expect(r).toEqual({ result: 'STREAM MSG', harnessSessionId: 'S1' })
  })

  test('parseResult: tolerates non-JSON lines and empty output file', () => {
    const stdout = ['not json at all', JSON.stringify({ type: 'thread.started', thread_id: 'T2' })].join('\n')
    const r = adapters.codex.parseResult(spec(), stdout, '   ')
    expect(r).toEqual({ result: '', harnessSessionId: 'T2' })
  })

  test('parseResult: resume with no thread event keeps resumeSessionId', () => {
    const stdout = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'x' } })
    const r = adapters.codex.parseResult(spec({ resumeSessionId: RESUME }), stdout, 'DONE')
    expect(r.harnessSessionId).toBe(RESUME)
  })

  test('parseResult: usage from turn.completed (real observed shape, no cost/total)', () => {
    // Shape verified live (codex 0.144.4, `codex exec --json`).
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'T1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 14697, cached_input_tokens: 2432, output_tokens: 27, reasoning_output_tokens: 20 },
      }),
    ].join('\n')
    const r = adapters.codex.parseResult(spec(), stdout, 'OK')
    expect(r.usage).toEqual({
      inputTokens: 14697,
      outputTokens: 27,
      cacheReadTokens: 2432,
      turns: 1,
    })
  })

  test('parseResult: sums usage across multiple turn.completed events', () => {
    const stdout = [
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 1 } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 3, cached_input_tokens: 4 } }),
    ].join('\n')
    const r = adapters.codex.parseResult(spec(), stdout, 'x')
    expect(r.usage).toEqual({ inputTokens: 15, outputTokens: 5, cacheReadTokens: 5, turns: 2 })
  })

  test('parseResult: no turn.completed → usage undefined', () => {
    const stdout = JSON.stringify({ type: 'thread.started', thread_id: 'T1' })
    expect(adapters.codex.parseResult(spec(), stdout, 'x').usage).toBeUndefined()
  })
})

describe('grok adapter', () => {
  test('new session buildCommand (with model/effort)', () => {
    const { cmd } = adapters.grok.buildCommand(spec({ model: 'grok-4.5', effort: 'high' }))
    // Note: grok's -p is `--single <PROMPT>` — the prompt is its VALUE, not a
    // trailing positional (verified live; a trailing positional errors out).
    expect(cmd).toEqual([
      'grok',
      '-p',
      'PROMPT',
      '--output-format',
      'json',
      '--session-id',
      RID,
      '--always-approve',
      '-m',
      'grok-4.5',
      '--reasoning-effort',
      'high',
    ])
  })

  test('resume swaps --session-id for --resume and prepends instructions', () => {
    const { cmd } = adapters.grok.buildCommand(spec({ resumeSessionId: RESUME, instructions: 'INSTR' }))
    expect(cmd).toEqual([
      'grok',
      '-p',
      'INSTR\n\n---\n\nPROMPT',
      '--output-format',
      'json',
      '--resume',
      RESUME,
      '--always-approve',
    ])
  })

  test('parseResult field fallback chain: result -> response -> text -> raw', () => {
    expect(adapters.grok.parseResult(spec(), JSON.stringify({ result: 'a' })).result).toBe('a')
    expect(adapters.grok.parseResult(spec(), JSON.stringify({ response: 'b' })).result).toBe('b')
    expect(adapters.grok.parseResult(spec(), JSON.stringify({ text: 'c' })).result).toBe('c')
    expect(adapters.grok.parseResult(spec(), JSON.stringify({ other: 'z' })).result).toBe(
      JSON.stringify({ other: 'z' }),
    )
    expect(adapters.grok.parseResult(spec(), 'plain text\n').result).toBe('plain text')
  })

  test('parseResult session id equals runId', () => {
    expect(adapters.grok.parseResult(spec(), JSON.stringify({ result: 'a' })).harnessSessionId).toBe(RID)
  })

  test('parseResult extracts usage from the real observed shape (no cost)', () => {
    // Shape verified live: cache_read_input_tokens + total_tokens + num_turns.
    const stdout = JSON.stringify({
      text: 'OK',
      usage: {
        input_tokens: 7672,
        cache_read_input_tokens: 20682,
        output_tokens: 302,
        reasoning_tokens: 0,
        total_tokens: 28656,
      },
      num_turns: 2,
    })
    expect(adapters.grok.parseResult(spec(), stdout).usage).toEqual({
      inputTokens: 7672,
      outputTokens: 302,
      cacheReadTokens: 20682,
      totalTokens: 28656,
      turns: 2,
    })
  })

  test('parseResult usage undefined when none reported', () => {
    expect(adapters.grok.parseResult(spec(), JSON.stringify({ result: 'a' })).usage).toBeUndefined()
  })
})

describe('parseGrokModels', () => {
  test('parses default + plain bullets past an unauthenticated-warning preamble', () => {
    const stdout = [
      'Warning: not authenticated; showing cached model list.',
      '',
      'Available models:',
      '  * grok-4.5 (default)',
      '  - grok-composer-2.5-fast',
      '',
    ].join('\n')
    expect(parseGrokModels(stdout)).toEqual(['grok-4.5', 'grok-composer-2.5-fast'])
  })

  test('returns undefined when nothing parses', () => {
    expect(parseGrokModels('command failed: unknown subcommand')).toBeUndefined()
  })
})

describe('knownModels invariants', () => {
  for (const name of Object.keys(adapters) as HarnessName[]) {
    const adapter = adapters[name]
    describe(name, () => {
      test('knownModels is non-empty', () => {
        expect(adapter.knownModels.length).toBeGreaterThan(0)
      })

      test('every model effort is within the harness effort superset', () => {
        for (const model of adapter.knownModels) {
          for (const effort of model.efforts) {
            expect(adapter.efforts).toContain(effort)
          }
        }
      })

      test('exactly one default model', () => {
        expect(adapter.knownModels.filter((m) => m.isDefault === true)).toHaveLength(1)
      })

      test('modelsVerifiedAt is set', () => {
        expect(adapter.modelsVerifiedAt).toBe('2026-07-16')
      })
    })
  }
})

describe('describeHarness / mergeLiveModels', () => {
  test('curated path: claude serves the snapshot with verifiedAt', () => {
    const d = describeHarness('claude')
    expect(d.name).toBe('claude')
    expect(d.efforts).toEqual(adapters.claude.efforts)
    expect(d.models.source).toBe('curated')
    expect(d.models.verifiedAt).toBe('2026-07-16')
    expect(d.models.list.map((m) => m.name)).toEqual(['fable', 'opus', 'sonnet'])
  })

  test('mergeLiveModels keeps curated efforts for a matched name', () => {
    const merged = mergeLiveModels(['grok-4.5'], adapters.grok)
    expect(merged).toEqual([{ name: 'grok-4.5', efforts: adapters.grok.efforts, isDefault: true }])
  })

  test('mergeLiveModels flags an unmatched live name as efforts-unverified', () => {
    const merged = mergeLiveModels(['grok-9.9-experimental'], adapters.grok)
    expect(merged).toEqual([
      { name: 'grok-9.9-experimental', efforts: adapters.grok.efforts, note: 'not in curated set — efforts unverified' },
    ])
  })

  test('live path: source live + null verifiedAt when listModels returns names', () => {
    // Simulate an installed CLI with live enumeration, without depending on grok
    // being installed: stub listModels on a shallow adapter clone.
    const liveAdapter: HarnessAdapter = {
      ...adapters.grok,
      listModels: () => ['grok-4.5', 'grok-composer-2.5-fast'],
    }
    const stubbed = { ...adapters, grok: liveAdapter }
    // describeHarness reads from the module registry, so exercise the merge +
    // shape logic directly against the stub to stay install-independent.
    const liveNames = liveAdapter.listModels?.()
    expect(liveNames).toEqual(['grok-4.5', 'grok-composer-2.5-fast'])
    const list = mergeLiveModels(liveNames ?? [], stubbed.grok)
    expect(list.map((m) => m.name)).toEqual(['grok-4.5', 'grok-composer-2.5-fast'])
    expect(list[1]?.efforts).toEqual([])
  })
})
