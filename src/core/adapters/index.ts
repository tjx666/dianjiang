/** Adapter registry keyed by harness name. */

import type { HarnessAdapter, HarnessName } from '../types.ts'
import { HARNESS_NAMES } from '../types.ts'
import { claudeAdapter } from './claude.ts'
import { codexAdapter } from './codex.ts'
import { grokAdapter } from './grok.ts'

export const adapters: Record<HarnessName, HarnessAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  grok: grokAdapter,
}

export { claudeAdapter, codexAdapter, grokAdapter }

export interface HarnessVersion {
  name: HarnessName
  installed: boolean
  version: string | null
}

/**
 * Probe each harness CLI's `--version`. Backs the `config harnesses` self-check
 * and the smoke script — vendor CLIs break often, so this is our early warning.
 */
export function harnessVersions(): HarnessVersion[] {
  return HARNESS_NAMES.map((name) => {
    try {
      const proc = Bun.spawnSync([name, ...adapters[name].versionArgs])
      if (proc.exitCode === 0) {
        return { name, installed: true, version: proc.stdout.toString().trim() }
      }
    } catch {
      // Binary not found or not executable.
    }
    return { name, installed: false, version: null }
  })
}
