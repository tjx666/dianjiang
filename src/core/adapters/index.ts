/** Adapter registry keyed by harness name. */

import type { HarnessAdapter, HarnessName, KnownModel } from '../types.ts'
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

/** Probe one harness CLI's `--version`. Missing binary → not installed. */
function probeVersion(adapter: HarnessAdapter): { installed: boolean; version: string | null } {
  try {
    const proc = Bun.spawnSync([adapter.name, ...adapter.versionArgs])
    if (proc.exitCode === 0) return { installed: true, version: proc.stdout.toString().trim() }
  } catch {
    // Binary not found or not executable.
  }
  return { installed: false, version: null }
}

/**
 * Probe each harness CLI's `--version`. Backs the `setup` installed-scan and
 * the smoke script — vendor CLIs break often, so this is our early warning.
 */
export function harnessVersions(): HarnessVersion[] {
  return HARNESS_NAMES.map((name) => ({ name, ...probeVersion(adapters[name]) }))
}

/** Where a harness's model list came from: live CLI enumeration or the snapshot. */
export interface HarnessModels {
  source: 'live' | 'curated'
  /** ISO date of the curated snapshot; null for live enumeration. */
  verifiedAt: string | null
  list: KnownModel[]
}

/** A harness self-check entry enriched with efforts + models. */
export interface HarnessDescription {
  name: HarnessName
  installed: boolean
  version: string | null
  efforts: readonly string[]
  models: HarnessModels
}

/**
 * Merge live model names against an adapter's curated snapshot: a name present
 * in `knownModels` keeps its curated efforts/isDefault/note; an unmatched live
 * name gets the harness-level effort set and a note that its efforts are
 * unverified. Pure (no I/O) so it is unit-testable without the CLI installed.
 */
export function mergeLiveModels(liveNames: string[], adapter: HarnessAdapter): KnownModel[] {
  return liveNames.map((name) => {
    const curated = adapter.knownModels.find((m) => m.name === name)
    if (curated) return { ...curated }
    return { name, efforts: adapter.efforts, note: 'not in curated set — efforts unverified' }
  })
}

/**
 * Describe a harness for `config harnesses`: install/version plus its effort
 * space and model list. Prefers live enumeration (`listModels`) when the
 * adapter supports it and it returns names (source 'live', no verifiedAt);
 * otherwise serves the curated snapshot (source 'curated', with verifiedAt).
 * An uninstalled harness still reports its curated models.
 */
export function describeHarness(name: HarnessName): HarnessDescription {
  const adapter = adapters[name]
  const { installed, version } = probeVersion(adapter)
  const liveNames = adapter.listModels?.()
  const models: HarnessModels =
    liveNames && liveNames.length > 0
      ? { source: 'live', verifiedAt: null, list: mergeLiveModels(liveNames, adapter) }
      : { source: 'curated', verifiedAt: adapter.modelsVerifiedAt, list: [...adapter.knownModels] }
  return { name, installed, version, efforts: adapter.efforts, models }
}
