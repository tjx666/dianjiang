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

import type { DispatchSpec, HarnessAdapter, HarnessResult, KnownModel, RunUsage } from '../types.ts'
import {
  asRecord,
  finalizeUsage,
  isQuotaExhaustedMessage,
  num,
  quotaExhaustedFailure,
} from './shared.ts'

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

/**
 * Locally-verified claude models (2026-07-16). Aliases only; the CLI also
 * accepts full model IDs and the `[1m]` 1M-context suffix — e.g.
 * `claude-opus-4-6[1m]` (verified) — which validation passes through as
 * unknown-but-permitted names. The CLI has no headless model-list command, so
 * there is no `listModels`.
 */
export const CLAUDE_MODELS: readonly KnownModel[] = [
  {
    name: 'fable',
    efforts: CLAUDE_EFFORTS,
    isDefault: true,
    note: 'Full model IDs and the [1m] 1M-context suffix are also accepted (e.g. claude-opus-4-6[1m], verified).',
  },
  { name: 'opus', efforts: CLAUDE_EFFORTS },
  { name: 'sonnet', efforts: CLAUDE_EFFORTS },
]

export const claudeAdapter: HarnessAdapter = {
  name: 'claude',
  efforts: CLAUDE_EFFORTS,
  knownModels: CLAUDE_MODELS,
  modelsVerifiedAt: '2026-07-16',
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

  classifyFailure(stdout: string, stderr: string, exitCode: number) {
    let detail = ''
    let hasStructuredError = false
    let parsedJson = false
    try {
      const obj = JSON.parse(stdout) as Record<string, unknown>
      parsedJson = true
      const nestedError = asRecord(obj['error'])
      for (const value of [obj['result'], obj['message'], obj['error'], nestedError?.['message']]) {
        if (typeof value === 'string' && value.trim()) {
          detail = value.trim()
          break
        }
      }
      hasStructuredError =
        obj['is_error'] === true ||
        obj['terminal_reason'] === 'api_error' ||
        typeof obj['api_error_status'] === 'number' ||
        obj['type'] === 'error' ||
        typeof obj['error'] === 'string' ||
        nestedError !== undefined
    } catch {
      // Older/alternate Claude builds may emit plain text; use the strict prose
      // matcher below rather than treating every non-JSON failure as quota.
    }
    if (exitCode === 0 && !hasStructuredError) return undefined
    if (!detail) detail = (stderr.trim() || stdout.trim()).slice(-2000)
    // A non-zero wrapper exit does not turn a successful assistant response
    // into an error envelope; in that case only stderr may classify the cause.
    const evidenceParts = parsedJson && !hasStructuredError ? [stderr.trim()] : [detail, stderr.trim(), stdout.trim()]
    const quotaDetail = evidenceParts.find(isQuotaExhaustedMessage)
    if (quotaDetail) {
      return quotaExhaustedFailure('claude', quotaDetail.slice(-2000))
    }
    return undefined
  },

  parseResult(spec: DispatchSpec, stdout: string): HarnessResult {
    const obj = JSON.parse(stdout) as Record<string, unknown>
    const result = typeof obj['result'] === 'string' ? obj['result'] : ''
    return { result, harnessSessionId: spec.resumeSessionId ?? spec.runId, usage: extractUsage(obj) }
  },
}
