/** Turn completed harness process streams into one persisted run outcome. */

import type { DispatchSpec, HarnessAdapter, RunFailure, RunRecord } from './types.ts'

export interface HarnessProcessOutcome {
  adapter: HarnessAdapter
  spec: DispatchSpec
  exitCode: number
  stdout: string
  stderr: string
  outputFileContents?: string
  finishedAt: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Keep failure reports useful even when a harness writes only to stdout. */
function fallbackFailureResult(exitCode: number, stdout: string, stderr: string): string {
  const stdoutText = stdout.trim()
  const stderrText = stderr.trim()
  if (stdoutText && stderrText) {
    return `[stdout]\n${stdoutText.slice(-950)}\n[stderr]\n${stderrText.slice(-950)}`
  }
  const reported = stderrText || stdoutText
  if (reported) return reported.slice(-2000)
  return `Harness exited with code ${exitCode} without any output.`
}

/**
 * Resolve one terminal process outcome. Failure classification runs before the
 * exit-code branch because vendor CLIs may put structured failures on stdout,
 * leave stderr empty, or even exit zero for an error payload.
 */
export function resolveHarnessOutcome(input: HarnessProcessOutcome): Partial<RunRecord> {
  const { adapter, spec, exitCode, stdout, stderr, outputFileContents, finishedAt } = input

  let failure: RunFailure | undefined
  try {
    failure = adapter.classifyFailure?.(stdout, stderr, exitCode)
  } catch {
    // Classification is enrichment: an adapter parser drift must still surface
    // the underlying process output through the generic failure path below.
  }
  if (failure) {
    return {
      status: 'failed',
      exitCode,
      result: failure.message,
      failure,
      finishedAt,
    }
  }

  if (exitCode !== 0) {
    return {
      status: 'failed',
      exitCode,
      result: fallbackFailureResult(exitCode, stdout, stderr),
      finishedAt,
    }
  }

  try {
    const parsed = adapter.parseResult(spec, stdout, outputFileContents)
    return {
      status: 'completed',
      exitCode,
      result: parsed.result,
      harnessSessionId: parsed.harnessSessionId,
      usage: parsed.usage,
      finishedAt,
    }
  } catch (err) {
    return {
      status: 'failed',
      exitCode,
      result: `parseResult failed: ${errorMessage(err)}`,
      finishedAt,
    }
  }
}
