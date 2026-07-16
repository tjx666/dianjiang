/**
 * Filesystem layout for dianjiang state. Everything lives under a single home
 * directory (`~/.dianjiang` by default, overridable via `DIANJIANG_HOME` — the
 * override is what lets tests run against an isolated temp dir).
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Root state dir. `DIANJIANG_HOME` wins; otherwise `~/.dianjiang`. */
export function dianjiangHome(): string {
  return process.env.DIANJIANG_HOME ?? join(homedir(), '.dianjiang')
}

/** `mkdir -p` a directory and return it. */
function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Absolute path of the JSONC config file (parent dir ensured). */
export function configPath(): string {
  return join(ensureDir(dianjiangHome()), 'config.jsonc')
}

/** Absolute path of the SQLite run store (parent dir ensured). */
export function dbPath(): string {
  return join(ensureDir(dianjiangHome()), 'runs.sqlite')
}

/** Directory holding detached-worker logs (created on demand). */
export function logsDir(): string {
  return ensureDir(join(dianjiangHome(), 'logs'))
}

/** Log file for one detached run. */
export function logFilePath(runId: string): string {
  return join(logsDir(), `${runId}.log`)
}

/**
 * Append-only operational log (`<DIANJIANG_HOME>/dianjiang.log`). Distinct from
 * per-run harness stream logs: this records dispatch/spawn/exit/reconcile/error
 * events across all runs. Parent dir ensured (lazy mkdir).
 */
export function opLogPath(): string {
  return join(ensureDir(dianjiangHome()), 'dianjiang.log')
}
