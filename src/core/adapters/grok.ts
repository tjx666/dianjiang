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
import { asRecord, finalizeUsage, num, withInstructions } from './shared.ts'

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
 * Locally-verified grok models (2026-07-16). grok-composer-2.5-fast takes no
 * reasoning-effort flag at all (efforts: []). grok also supports live
 * enumeration via `grok models`, so this snapshot is a fallback only.
 */
export const GROK_MODELS: readonly KnownModel[] = [
  { name: 'grok-4.5', efforts: GROK_EFFORTS, isDefault: true },
  { name: 'grok-composer-2.5-fast', efforts: [] },
]

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
  modelsVerifiedAt: '2026-07-16',
  versionArgs: ['--version'],

  listModels(): string[] | undefined {
    try {
      const proc = Bun.spawnSync(['grok', 'models'])
      if (proc.exitCode !== 0) return undefined
      return parseGrokModels(proc.stdout.toString())
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
