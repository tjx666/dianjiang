/**
 * `setup`: inject a managed delegation-roster block into each vendor's global
 * instruction file. The block is delimited by begin/end markers so re-running
 * is idempotent (replace in place) and non-destructive (append if absent).
 *
 * Grok's claude-compat is off locally, so all three files must be written.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DianjiangConfig, HarnessName } from './types.ts'

const BEGIN = '<!-- dianjiang:begin -->'
const END = '<!-- dianjiang:end -->'

export type SetupAction = 'written' | 'updated' | 'removed' | 'skipped'

export interface SetupResult {
  file: string
  action: SetupAction
}

/** The three global instruction files, one per harness. */
export interface SetupTargets {
  claude: string
  codex: string
  grok: string
}

export function defaultTargets(home = homedir()): SetupTargets {
  return {
    claude: join(home, '.claude', 'CLAUDE.md'),
    codex: join(home, '.codex', 'AGENTS.md'),
    grok: join(home, '.grok', 'AGENTS.md'),
  }
}

/**
 * Narrow `defaultTargets()` (or any full target set) to the given harness
 * names, preserving the harness key so each file still stamps its own caller.
 * Throws on an unknown harness name.
 */
export function filterTargets(names: HarnessName[], targets = defaultTargets()): Partial<SetupTargets> {
  const out: Partial<SetupTargets> = {}
  for (const name of names) {
    if (!(name in targets)) throw new Error(`Unknown harness "${name}".`)
    out[name] = targets[name]
  }
  return out
}

/**
 * Render the managed markdown block from the roster (see DESIGN.md template).
 * When `caller` is set, the blocking-run rule documents
 * `dianjiang run --caller <caller> ...` so per-caller binding overrides resolve
 * without env sniffing; the raw escape-hatch command stays caller-less. When
 * `caller` is undefined the block renders exactly as the caller-less template.
 */
export function renderRosterBlock(config: DianjiangConfig, caller?: HarnessName): string {
  const rows = config.agents
    .map((a) => `| ${a.name} | ${a.useWhen} | ${a.dontUseWhen ?? '—'} |`)
    .join('\n')
  const runCmd = caller ? `dianjiang run --caller ${caller} <agent> "<task>"` : 'dianjiang run <agent> "<task>"'

  return `${BEGIN}
# Delegation roster (dianjiang)

\`dianjiang\` dispatches self-contained tasks to other coding-agent CLIs.
dianjiang agents are separate from your built-in subagents. Pick one by task
shape — never pick harnesses or models on your own judgment:

| Agent | Use when | Don't use when |
|---|---|---|
${rows}

Rules:
- \`${runCmd}\` blocks until done and prints one JSON object; read \`.result\`.
- Write tasks self-contained: background, file paths, acceptance criteria, expected output.
- Follow up in the same session with \`dianjiang resume <runId> "<message>"\`.
- For tasks likely over ~5 minutes, add \`--detach\`, then poll \`dianjiang status <runId>\`
  and fetch \`dianjiang result <runId>\` when completed.
- If your command times out or is killed, the run keeps going in the background —
  recover it any time with \`dianjiang result <runId>\`.
- If the human explicitly names a vendor, harness, or model, relay their choice:
  \`dianjiang run --harness <claude|codex|grok> [-m <model>] [--effort <level>] "<task>"\`,
  or override an agent preset with \`-m\`/\`--effort\`. Relay only — the choice stays the human's.
- If \`DIANJIANG_DEPTH\` is set in your environment, you ARE a delegate — never call dianjiang.
${END}`
}

/**
 * Write `block` into `filePath`. If a marker pair already exists, replace that
 * region; otherwise append (blank line separated); create the file if missing.
 * Returns whether the file was created (`written`) or already existed (`updated`).
 */
export function injectBlock(filePath: string, block: string): SetupAction {
  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, `${block}\n`)
    return 'written'
  }

  const content = readFileSync(filePath, 'utf8')
  const beginIdx = content.indexOf(BEGIN)
  const endIdx = content.indexOf(END)

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    // Replace the managed region in place (idempotent).
    const next = content.slice(0, beginIdx) + block + content.slice(endIdx + END.length)
    if (next !== content) writeFileSync(filePath, next)
    return 'updated'
  }

  // Append with a single blank line before the block.
  const separator = content.endsWith('\n') ? '\n' : '\n\n'
  writeFileSync(filePath, `${content}${separator}${block}\n`)
  return 'updated'
}

/**
 * Remove the managed block from `filePath`, leaving the rest of the file
 * byte-identical. Strips the block plus the blank-line padding that
 * `injectBlock` added around it (a leading separator and/or a trailing newline)
 * so a later re-inject produces the same result as a first-time inject.
 *
 * Returns `skipped` when the file is missing or has no complete marker pair,
 * `removed` when a block was stripped.
 */
export function removeBlock(filePath: string): SetupAction {
  if (!existsSync(filePath)) return 'skipped'

  const content = readFileSync(filePath, 'utf8')
  const beginIdx = content.indexOf(BEGIN)
  const endIdx = content.indexOf(END)
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return 'skipped'

  let before = content.slice(0, beginIdx)
  let after = content.slice(endIdx + END.length)

  // Drop the blank-line separator injectBlock inserted before the block, and
  // the single trailing newline it appended after it. When the block was the
  // whole file, both sides collapse to empty.
  before = before.replace(/\n{1,2}$/, before.length > 0 && after.length > 0 ? '\n' : '')
  after = after.replace(/^\n/, '')

  writeFileSync(filePath, before + after)
  return 'removed'
}

/**
 * Inject the roster block into the given targets (defaults to all three). Each
 * target is rendered with its own caller stamped in (the SetupTargets keys are
 * the caller harness names) so per-caller binding overrides resolve without env
 * sniffing.
 */
export function runSetup(config: DianjiangConfig, targets: Partial<SetupTargets> = defaultTargets()): SetupResult[] {
  return (Object.entries(targets) as [HarnessName, string][]).map(([caller, file]) => ({
    file,
    action: injectBlock(file, renderRosterBlock(config, caller)),
  }))
}

/**
 * Remove the managed block from the given targets (defaults to all three).
 * Same one-JSON contract as `runSetup`; files without a block report `skipped`.
 */
export function runRemove(targets: Partial<SetupTargets> = defaultTargets()): SetupResult[] {
  return (Object.entries(targets) as [HarnessName, string][]).map(([, file]) => ({
    file,
    action: removeBlock(file),
  }))
}
