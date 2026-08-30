/** Helpers shared across harness adapters. */

import type { DispatchSpec, HarnessName, RunFailure, RunUsage } from '../types.ts'

const QUOTA_EXHAUSTED_PATTERNS = [
  /\byou(?:['’]ve| have) (?:hit|reached|exceeded) your (?:daily|weekly|monthly|usage|spend(?:ing)?) limit\b/i,
  /\byou(?:['’]ve| have) reached your .*\busage limit\b/i,
  /\b(?:daily|weekly|monthly|usage|spend(?:ing)?) (?:limit|quota) (?:has been )?(?:reached|exceeded|exhausted)\b/i,
  /\b(?:credit balance|credits?|quota) (?:is |are )?(?:too low|insufficient|exhausted|depleted|empty)\b/i,
  /\b(?:insufficient|not enough|out of) (?:credits?|quota)\b/i,
  /\bquota (?:has been )?(?:exceeded|exhausted)\b/i,
  /\bno (?:available )?(?:credits?|quota) remaining\b/i,
  /\busage balance exhausted\b/i,
]

/** High-confidence prose fallback; deliberately excludes generic/rate-limit 429s. */
export function isQuotaExhaustedMessage(message: string): boolean {
  return QUOTA_EXHAUSTED_PATTERNS.some((pattern) => pattern.test(message))
}

/** Build the stable caller-facing failure while retaining the vendor's detail. */
export function quotaExhaustedFailure(harness: HarnessName, detail: string): RunFailure {
  const harnessLabel: Record<HarnessName, string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    grok: 'Grok Build',
  }
  return {
    code: 'quota_exhausted',
    message: `The selected ${harnessLabel[harness]} harness has no available quota. Choose another harness.`,
    ...(detail ? { detail } : {}),
  }
}

/** Narrow an unknown value to a plain object for keyed access. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * Return `value` only when it is a real number; anything else (missing,
 * string, NaN) yields undefined. Used to keep usage extraction defensive —
 * dianjiang records what a harness reports, never a coerced or guessed number.
 */
export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Collapse a usage object to undefined when it carries no reported field. */
export function finalizeUsage(usage: RunUsage): RunUsage | undefined {
  return Object.values(usage).some((v) => v !== undefined) ? usage : undefined
}

/**
 * Cross-vendor baseline for harnesses with no system-prompt flag (codex, grok):
 * prepend the agent instructions to the prompt. claude uses its native
 * --append-system-prompt instead and never calls this.
 */
export function withInstructions(spec: DispatchSpec): string {
  return spec.instructions ? `${spec.instructions}\n\n---\n\n${spec.prompt}` : spec.prompt
}
