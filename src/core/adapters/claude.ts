/**
 * Claude Code adapter.
 *
 * One-shot:  claude -p --output-format json --session-id <uuid> --dangerously-skip-permissions
 *              [--model <m>] [--effort <e>] [--append-system-prompt <instr>] <prompt>
 * Resume:    same, but --session-id <uuid> is swapped for --resume <sessionId>.
 * Result:    stdout is a single JSON object; the final message is `.result`.
 *
 * dianjiang pre-generates the session UUID and injects it, so the harness
 * session id equals the run id for new sessions.
 */

import type { DispatchSpec, HarnessAdapter, HarnessResult, RunUsage } from '../types.ts'
import { asRecord, finalizeUsage, num } from './shared.ts'

/**
 * Extract claude's usage from `--output-format json`:
 *   { "usage": { "input_tokens", "output_tokens", "cache_read_input_tokens",
 *     "cache_creation_input_tokens" }, "total_cost_usd", "num_turns" }
 * claude is the only harness that reports a cost. Defensive throughout: any
 * missing/non-number field → undefined; nothing found → undefined.
 */
function extractUsage(obj: Record<string, unknown>): RunUsage | undefined {
  const u = asRecord(obj['usage'])
  return finalizeUsage({
    inputTokens: num(u?.['input_tokens']),
    outputTokens: num(u?.['output_tokens']),
    cacheReadTokens: num(u?.['cache_read_input_tokens']),
    turns: num(obj['num_turns']),
    costUsd: num(obj['total_cost_usd']),
  })
}

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const claudeAdapter: HarnessAdapter = {
  name: 'claude',
  efforts: CLAUDE_EFFORTS,
  versionArgs: ['--version'],

  buildCommand(spec: DispatchSpec) {
    const cmd = ['claude', '-p', '--output-format', 'json']
    if (spec.resumeSessionId) {
      cmd.push('--resume', spec.resumeSessionId)
    } else {
      cmd.push('--session-id', spec.runId)
    }
    cmd.push('--dangerously-skip-permissions')
    if (spec.model) cmd.push('--model', spec.model)
    if (spec.effort) cmd.push('--effort', spec.effort)
    // claude has a real system-prompt flag, so use it instead of prepending.
    if (spec.instructions) cmd.push('--append-system-prompt', spec.instructions)
    cmd.push(spec.prompt)
    return { cmd }
  },

  parseResult(spec: DispatchSpec, stdout: string): HarnessResult {
    const obj = JSON.parse(stdout) as Record<string, unknown>
    const result = typeof obj['result'] === 'string' ? obj['result'] : ''
    return { result, harnessSessionId: spec.resumeSessionId ?? spec.runId, usage: extractUsage(obj) }
  },
}
