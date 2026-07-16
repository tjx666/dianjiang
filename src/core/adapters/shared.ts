/** Helpers shared across harness adapters. */

import type { DispatchSpec, RunUsage } from '../types.ts'

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
