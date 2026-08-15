/**
 * Sync subprocess helper. `node:child_process` works the same under Bun and Node;
 * do not call `Bun.spawn*` from library/CLI code or Node users cannot run us.
 */

import { spawnSync } from 'node:child_process'

export interface RunSyncResult {
  exitCode: number
  stdout: string
}

/**
 * Run `argv[0]` with the remaining args. Throws if the binary cannot be
 * spawned (e.g. ENOENT); a non-zero child exit is returned, not thrown.
 */
export function runSync(argv: string[], opts?: { stdio?: 'pipe' | 'inherit' }): RunSyncResult {
  const [bin, ...args] = argv
  if (!bin) throw new Error('runSync: empty command')
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    stdio: opts?.stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '' }
}
