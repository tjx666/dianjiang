/**
 * Grok adapter.
 *
 * One-shot:  grok -p <finalPrompt> --output-format json --session-id <uuid>
 *              --always-approve [-m <m>] [--reasoning-effort <e>]
 * Resume:    same, but --session-id <uuid> is swapped for --resume <sessionId>.
 *
 * Unlike claude (where -p is a boolean and the prompt is positional), grok's
 * `-p` is `--single <PROMPT>` and CONSUMES the prompt as its value — verified
 * live: a trailing positional fails with "a value is required for '--single'".
 * Result:    stdout is expected to be a single JSON object.
 *
 * Like codex, grok has no system-prompt flag, so instructions are prepended.
 * dianjiang pre-generates and injects the session UUID, so the harness session
 * id equals the run id for new sessions.
 */

import type { DispatchSpec, HarnessAdapter, HarnessResult, KnownModel, RunUsage } from '../types.ts'
import { runSync } from '../exec.ts'
import {
  asRecord,
  finalizeUsage,
  isQuotaExhaustedMessage,
  num,
  quotaExhaustedFailure,
  withInstructions,
} from './shared.ts'

const GROK_QUOTA_CODES = ['personal-team-blocked:spending-limit', 'subscription:free-usage-exhausted']

/**
 * Extract grok's usage. Verified live, stdout carries:
 *   { "usage": { "input_tokens", "cache_read_input_tokens", "output_tokens",
 *     "reasoning_tokens", "total_tokens" }, "num_turns": 2 }
 * Grok reports no cost. Every field defensive: missing/non-number → undefined.
 */
function extractUsage(obj: Record<string, unknown>): RunUsage | undefined {
  const u = asRecord(obj['usage'])
  return finalizeUsage({
    inputTokens: num(u?.['input_tokens']),
    outputTokens: num(u?.['output_tokens']),
    cacheReadTokens: num(u?.['cache_read_input_tokens']),
    totalTokens: num(u?.['total_tokens']),
    turns: num(obj['num_turns']),
  })
}

export const GROK_EFFORTS = ['low', 'medium', 'high'] as const

/**
 * Locally-verified grok models (2026-07-28). grok-composer-2.5-fast was
 * delisted by the vendor between 2026-07-16 and 2026-07-28 (dispatching it now
 * fails with "unknown model id"). grok also supports live enumeration via
 * `grok models`, so this snapshot is a fallback only.
 */
export const GROK_MODELS: readonly KnownModel[] = [{ name: 'grok-4.5', efforts: GROK_EFFORTS, isDefault: true }]

/**
 * Parse the output of `grok models` into model names. The command works even
 * unauthenticated (it may print a warning preamble first). Under an
 * "Available models:" header each model is a bullet line:
 *   `  * grok-4.5 (default)`  — `*` marks the default, ` (default)` suffix
 *   `  - grok-composer-2.5-fast`  — `-` marks a plain entry
 * Returns the parsed names, or undefined when nothing parses.
 */
export function parseGrokModels(stdout: string): string[] | undefined {
  const names: string[] = []
  let inList = false
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (/^Available models:/i.test(line)) {
      inList = true
      continue
    }
    if (!inList) continue
    const match = /^[*-]\s+(\S+)/.exec(line)
    const name = match?.[1]
    if (!name) continue
    names.push(name.replace(/\s*\(default\)\s*$/i, ''))
  }
  return names.length > 0 ? names : undefined
}

export const grokAdapter: HarnessAdapter = {
  name: 'grok',
  efforts: GROK_EFFORTS,
  knownModels: GROK_MODELS,
  modelsVerifiedAt: '2026-07-28',
  versionArgs: ['--version'],

  listModels(): string[] | undefined {
    try {
      const proc = runSync(['grok', 'models'])
      if (proc.exitCode !== 0) return undefined
      return parseGrokModels(proc.stdout)
    } catch {
      // Binary not found or not executable.
      return undefined
    }
  },

  buildCommand(spec: DispatchSpec) {
    const cmd = ['grok', '-p', withInstructions(spec), '--output-format', 'json']
    if (spec.resumeSessionId) {
      cmd.push('--resume', spec.resumeSessionId)
    } else {
      cmd.push('--session-id', spec.runId)
    }
    cmd.push('--always-approve')
    if (spec.model) cmd.push('-m', spec.model)
    if (spec.effort) cmd.push('--reasoning-effort', spec.effort)
    return { cmd }
  },

  classifyFailure(stdout: string, stderr: string, exitCode: number) {
    let detail = ''
    let hasErrorEnvelope = false
    let parsedJson = false
    try {
      const obj = JSON.parse(stdout) as Record<string, unknown>
      parsedJson = true
      const nestedError = asRecord(obj['error'])
      hasErrorEnvelope =
        obj['type'] === 'error' || typeof obj['error'] === 'string' || nestedError !== undefined
      for (const value of [
        obj['result'],
        obj['response'],
        obj['text'],
        obj['message'],
        obj['error'],
        nestedError?.['message'],
      ]) {
        if (typeof value === 'string' && value.trim()) {
          detail = value.trim()
          break
        }
      }
    } catch {
      // Grok Build has emitted both JSON and plain-text failures across versions.
    }
    if (exitCode === 0 && !hasErrorEnvelope) return undefined
    if (!detail) detail = (stderr.trim() || stdout.trim()).slice(-2000)
    // Grok's successful `text`/`result` fields are model prose, even if a
    // wrapper later exits non-zero; only an error envelope may classify them.
    const evidenceParts = parsedJson && !hasErrorEnvelope ? [stderr.trim()] : [detail, stderr.trim(), stdout.trim()]
    const quotaDetail = evidenceParts.find(
      (part) =>
        GROK_QUOTA_CODES.some((code) => part.includes(code)) ||
        /\bstatus 402 Payment Required\b|["']?http_status["']?\s*[:=]\s*402\b/i.test(part) ||
        isQuotaExhaustedMessage(part),
    )
    if (quotaDetail) {
      return quotaExhaustedFailure('grok', quotaDetail.slice(-2000))
    }
    return undefined
  },

  parseResult(spec: DispatchSpec, stdout: string): HarnessResult {
    // TODO(smoke): the exact JSON field name for grok's final message is not yet
    // verified on this machine. Try the likely candidates in order and calibrate
    // against a real `--live` smoke run once available.
    let result = ''
    let usage: RunUsage | undefined
    try {
      const obj = JSON.parse(stdout) as Record<string, unknown>
      for (const key of ['result', 'response', 'text']) {
        const value = obj[key]
        if (typeof value === 'string') {
          result = value
          break
        }
      }
      if (!result) result = stdout.trim()
      usage = extractUsage(obj)
    } catch {
      result = stdout.trim()
    }
    return { result, harnessSessionId: spec.resumeSessionId ?? spec.runId, usage }
  },
}
