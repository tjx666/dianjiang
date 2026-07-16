/**
 * Append-only operational log: one JSON object per line at
 * `<DIANJIANG_HOME>/dianjiang.log`. Records the lifecycle of dispatches
 * (dispatch / spawn / exec.start / exec.done / exec.error / reconcile.failed /
 * cli.error), correlated by runId.
 *
 * NOT a public library export (kept out of the core barrel): it's an internal
 * observability sink, not part of the contract a GUI would build on. It also
 * NEVER logs harness stdout — that already streams to `logs/<runId>.log`.
 */

import { appendFileSync } from 'node:fs'
import { opLogPath } from './paths.ts'

/**
 * Append one event line: `{ts, event, ...fields}`. Logging failure must never
 * break a dispatch, so every error (unwritable dir, serialization) is swallowed.
 */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields })
    appendFileSync(opLogPath(), `${line}\n`)
  } catch {
    // Observability is best-effort; a failed log write cannot fail the run.
  }
}
