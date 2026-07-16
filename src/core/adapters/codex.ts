/**
 * Codex adapter.
 *
 * One-shot:  codex exec --json -o <file> --dangerously-bypass-approvals-and-sandbox
 *              [-m <m>] [-c model_reasoning_effort=<e>] <finalPrompt>
 * Resume:    codex exec resume <sessionId> --json -o <file> ... <finalPrompt>
 * Result:    stdout is a JSONL event stream; the final message is easiest read
 *            from the `-o` output file. Session id comes from the stream.
 *
 * Codex has no system-prompt flag, so instructions are prepended to the prompt.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DispatchSpec, HarnessAdapter, HarnessResult, RunUsage } from '../types.ts'
import { asRecord, num, withInstructions } from './shared.ts'

export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

/** Temp file codex writes its final message to (read + deleted after exit). */
function outputFileFor(runId: string): string {
  return join(tmpdir(), `dianjiang-${runId}.txt`)
}

/**
 * Accumulate usage across a codex JSONL stream. Observed live shape (codex
 * 0.144.4, `codex exec --json`): usage rides on `turn.completed` events —
 *   { "type": "turn.completed", "usage": { "input_tokens", "cached_input_tokens",
 *     "output_tokens", "reasoning_output_tokens" } }
 * There is no `total_tokens`, no `num_turns`, and no cost. We sum token fields
 * over every `turn.completed` and count those events as `turns`. codex reports
 * no cost, so `costUsd` stays undefined. Fully defensive: non-number → skipped.
 */
class CodexUsageAccumulator {
  private inputTokens: number | undefined
  private outputTokens: number | undefined
  private cacheReadTokens: number | undefined
  private turns = 0

  /** Fold one `turn.completed` event's usage into the running totals. */
  add(evt: Record<string, unknown>): void {
    if (evt['type'] !== 'turn.completed') return
    this.turns += 1
    const u = asRecord(evt['usage'])
    if (!u) return
    this.inputTokens = sum(this.inputTokens, num(u['input_tokens']))
    this.outputTokens = sum(this.outputTokens, num(u['output_tokens']))
    this.cacheReadTokens = sum(this.cacheReadTokens, num(u['cached_input_tokens']))
  }

  /** Undefined when no `turn.completed` was seen at all. */
  finalize(): RunUsage | undefined {
    if (this.turns === 0) return undefined
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      turns: this.turns,
    }
  }
}

/** Add two possibly-undefined numbers; undefined + undefined stays undefined. */
function sum(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a + b
}

/**
 * Pull the agent's final message out of a codex JSONL event. Tolerant of a few
 * event shapes since this is only a fallback when the `-o` file is empty.
 */
function extractAgentMessage(evt: Record<string, unknown>): string | undefined {
  // Newer: { type: "item.completed", item: { type: "agent_message", text } }
  const item = asRecord(evt['item'])
  if (evt['type'] === 'item.completed' && item && item['type'] === 'agent_message' && typeof item['text'] === 'string') {
    return item['text']
  }
  // Older: { msg: { type: "agent_message", message } }
  const msg = asRecord(evt['msg'])
  if (msg && msg['type'] === 'agent_message' && typeof msg['message'] === 'string') {
    return msg['message']
  }
  // Flat: { type: "agent_message", text }
  if (evt['type'] === 'agent_message' && typeof evt['text'] === 'string') {
    return evt['text']
  }
  return undefined
}

export const codexAdapter: HarnessAdapter = {
  name: 'codex',
  efforts: CODEX_EFFORTS,
  versionArgs: ['--version'],

  buildCommand(spec: DispatchSpec) {
    const outputFile = outputFileFor(spec.runId)
    const cmd = ['codex', 'exec']
    if (spec.resumeSessionId) cmd.push('resume', spec.resumeSessionId)
    cmd.push('--json', '-o', outputFile, '--dangerously-bypass-approvals-and-sandbox')
    if (spec.model) cmd.push('-m', spec.model)
    if (spec.effort) cmd.push('-c', `model_reasoning_effort=${spec.effort}`)
    cmd.push(withInstructions(spec))
    return { cmd, outputFile }
  },

  parseResult(spec: DispatchSpec, stdout: string, outputFileContents?: string): HarnessResult {
    let harnessSessionId = ''
    let lastAgentMessage = ''
    const usageAcc = new CodexUsageAccumulator()
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let evt: Record<string, unknown>
      try {
        evt = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        // Non-JSON noise line; skip.
        continue
      }
      // Version sniff: codex renamed session.created/session_id -> thread.started/thread_id.
      if (evt['type'] === 'thread.started' && typeof evt['thread_id'] === 'string') {
        harnessSessionId = evt['thread_id']
      } else if (evt['type'] === 'session.created' && typeof evt['session_id'] === 'string') {
        harnessSessionId = evt['session_id']
      }
      usageAcc.add(evt)
      const text = extractAgentMessage(evt)
      if (text) lastAgentMessage = text
    }

    // Prefer the -o file; fall back to the last agent message from the stream.
    const fromFile = outputFileContents?.trim()
    const result = fromFile && fromFile.length > 0 ? fromFile : lastAgentMessage

    // On resume the stream may omit a thread event; keep the known session id.
    if (!harnessSessionId && spec.resumeSessionId) harnessSessionId = spec.resumeSessionId

    return { result, harnessSessionId, usage: usageAcc.finalize() }
  },
}
