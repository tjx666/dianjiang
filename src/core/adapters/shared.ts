/** Helpers shared across harness adapters. */

import type { DispatchSpec } from '../types.ts'

/**
 * Cross-vendor baseline for harnesses with no system-prompt flag (codex, grok):
 * prepend the agent instructions to the prompt. claude uses its native
 * --append-system-prompt instead and never calls this.
 */
export function withInstructions(spec: DispatchSpec): string {
  return spec.instructions ? `${spec.instructions}\n\n---\n\n${spec.prompt}` : spec.prompt
}
