/**
 * The CLI's single output convention, shared by every command module: one JSON
 * value on stdout, `{status:"failed", error}` plus a `cli.error` log entry on
 * failure. Kept out of `index.ts` so subcommand modules can reuse it without an
 * import cycle.
 */

import { logEvent } from '../core/log.ts'
import { HARNESS_NAMES, type HarnessName } from '../core/types.ts'

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Print a JSON value on stdout (the single machine-readable line). */
export function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** Print a `{status:"failed", error}` object and set the exit code. */
export function fail(message: string, code = 1): void {
  logEvent('cli.error', { message, exitCode: code })
  emit({ status: 'failed', error: message })
  process.exitCode = code
}

/** Narrow a harness-name arg, throwing the standard message. `noun` names the arg. */
export function requireHarness(value: string | undefined, noun = 'harness'): HarnessName {
  if (value && HARNESS_NAMES.includes(value as HarnessName)) return value as HarnessName
  throw new Error(`Unknown ${noun} "${value ?? ''}" (expected one of: ${HARNESS_NAMES.join(', ')}).`)
}

/**
 * Narrow a harness-name arg. On an unknown name, emit the standard failure
 * (setting the exit code) and return undefined — the caller should then
 * `return`. `noun` names the offending arg in the message ("harness"/"caller").
 */
export function parseHarnessArg(value: string, noun: string): HarnessName | undefined {
  try {
    return requireHarness(value, noun)
  } catch (err) {
    fail(errorMessage(err))
    return undefined
  }
}

/** Run an action and print its JSON result, or the standard failure envelope. */
export async function emitResult(action: () => Promise<unknown> | unknown): Promise<void> {
  try {
    emit(await action())
  } catch (err) {
    fail(errorMessage(err))
  }
}
