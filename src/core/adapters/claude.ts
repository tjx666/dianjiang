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

import type { DispatchSpec, HarnessAdapter, HarnessResult } from '../types.ts'

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
    const obj = JSON.parse(stdout) as { result?: unknown }
    const result = typeof obj.result === 'string' ? obj.result : ''
    return { result, harnessSessionId: spec.resumeSessionId ?? spec.runId }
  },
}
