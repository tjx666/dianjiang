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
import { resolveAgent } from './registry.ts'

const BEGIN = '<!-- dianjiang:begin -->'
const END = '<!-- dianjiang:end -->'

/**
 * Per-caller collection strategy: how THIS caller waits for a detached run
 * without stalling its loop. This is harness-intrinsic capability knowledge
 * (see the design skill's capability matrix), so it lives in code — not in
 * config free-text — and renders as the ONE authoritative wait rule inside
 * <rules>. Structural rationale (2026-07 dogfood): a generic "block on result
 * --wait" rule plus a codex-only append produced conflicting guidance, and
 * codex blocked 300s in the foreground before spawning its waiter. claude and
 * grok shells push completion notifications for background commands; codex
 * shells never do, but its spawn_agent completion notifies the parent, so
 * codex routes the wait through a waiter subagent instead.
 */
const COLLECTION_STRATEGY: Record<HarnessName, string> = {
  claude: `Start that command in a background shell (\`run_in_background: true\`)
  immediately after dispatching — its completion notification delivers the
  result while you keep working. Run it in the foreground only when the result
  is the last thing you need before you can proceed.`,
  codex: `The moment you hold a runId, spawn a waiter subagent — \`spawn_agent\`
  with \`fork_turns: "none"\` and the message: "Run \`dianjiang result <runId>
  --wait --timeout 300\`. If it prints status 'running', run it again. When the
  status is terminal, return the full JSON verbatim." Its completion
  notification wakes you with the result; your shell sessions do NOT push
  completion events, so a background-shell wait WILL be forgotten. Do not wait
  in the foreground first, do not poll by hand, and do not gate the waiter on
  how long you expect the run to take. runIds you already hold can share one
  waiter, but never delay the first waiter for runs you might dispatch later.
  Fall back to a foreground wait ONLY if subagents are unavailable or no slot
  is free. Every dispatched run must be collected before your turn ends.`,
  grok: `Start that command as a background task (\`background: true\`)
  immediately after dispatching — its completion notification delivers the
  result while you keep working. Run it in the foreground only when the result
  is the last thing you need before you can proceed.`,
}

/** Caller-less renders can't assume shell capabilities; stay neutral. */
const DEFAULT_COLLECTION = `Run it in the foreground (\`--timeout\` keeps it
  bounded), or in a background shell if your environment pushes completion
  notifications.`

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
 * Render the managed roster block (see the design skill's template). The body
 * is XML (`<dianjiang-roster>` wrapping one `<agent>` element per agent):
 * markdown tables are unreadable as raw text and an injected `##` heading
 * interferes with the host file's outline, while XML sectioning is also what
 * LLM prompting guides recommend. The HTML-comment markers stay — they are the
 * inject/remove contract, not part of the format.
 *
 * When `caller` is set, the blocking-run rule documents
 * `dianjiang run --caller <caller> ...` so per-caller binding overrides resolve
 * without env sniffing; the raw escape-hatch command stays caller-less. When
 * `caller` is undefined the block renders exactly as the caller-less template.
 * A caller's optional `prepend` renders at the top of the block (before the
 * intro — scoping rules read best before the roster), wrapped in a
 * `<caller-guidance>` element so caller-behavior guidance (e.g. "use your own
 * subagents for X") is not read as a dianjiang usage rule; `append` renders
 * after the rules. Both live inside the managed block.
 *
 * Each agent is resolved through `resolveAgent(config, name, caller)` so the
 * injected `<use-when>`/`<dont-use-when>` reflect any caller-relative
 * description overrides (falling back to the base agent when unset). Exclude
 * behavior is unchanged.
 */
export function renderRosterBlock(config: DianjiangConfig, caller?: HarnessName): string {
  const excluded = caller ? config.callers?.[caller]?.exclude ?? [] : []
  const agents = config.agents
    .filter((a) => !excluded.includes(a.name))
    .map((a) => {
      const resolved = resolveAgent(config, a.name, caller)
      // dontUseWhen is optional: omit the element rather than render a blank.
      const dontUse = resolved.dontUseWhen ? `\n  <dont-use-when>${resolved.dontUseWhen}</dont-use-when>` : ''
      return `<agent name="${resolved.name}">\n  <use-when>${resolved.useWhen}</use-when>${dontUse}\n</agent>`
    })
    .join('\n\n')
  const runCmd = caller ? `dianjiang run --caller ${caller} <agent> "<task>"` : 'dianjiang run <agent> "<task>"'
  const callerConfig = caller ? config.callers?.[caller] : undefined
  const prependSection = callerConfig?.prepend
    ? `<caller-guidance>\n${callerConfig.prepend}\n</caller-guidance>\n\n`
    : ''
  const appendSection = callerConfig?.append ? `\n\n${callerConfig.append}` : ''

  return `${BEGIN}
<dianjiang-roster>

${prependSection}\`dianjiang\` is a CLI on this machine that dispatches self-contained tasks to
other coding-agent CLIs (Claude Code / Codex / Grok). Each <agent> below is a
preset the human already compiled — its harness, model, and effort are fixed;
never override or re-route them. Pick an agent by task shape. Model notes
inside <use-when> only calibrate whether a dispatch is worth making — they are
not an invitation to second-guess the binding. dianjiang agents are separate
from your built-in subagents: default to your own tools and subagents, and
reach for dianjiang only when an agent below clearly fits.

${agents}

<rules>
- \`${runCmd} --detach\` prints one JSON object immediately — save \`.runId\`.
  Always dispatch detached: never try to predict how long a task will take, and
  never wait with \`sleep N\`. The run survives even if you or the wait command
  die — \`dianjiang result <runId>\` recovers it any time.
- Collect every run with \`dianjiang result <runId> --wait --timeout 300\`: it
  exits with the final JSON the moment the run finishes; on timeout it prints
  \`status: "running"\` — just re-run it. ${caller ? COLLECTION_STRATEGY[caller] : DEFAULT_COLLECTION}
- Check \`.status\` first: read \`.result\` when it is "completed" — on "failed"
  \`.result\` is the stderr tail, not an answer.
- Write tasks self-contained (background, file paths, acceptance criteria,
  expected output): the delegate starts fresh in your cwd — it sees your files,
  not your conversation.
- Follow up in the same session with \`dianjiang resume <runId> "<message>"\` —
  it takes \`--detach\` too; use the same detach-and-collect flow.
- Overriding a preset is allowed ONLY to relay the human's explicit choice in
  their current request: if they name a vendor, harness, model, or effort, pass
  it through — \`dianjiang run --harness <claude|codex|grok> [-m <model>] [--effort <level>] "<task>"\`,
  or \`-m\`/\`--effort\` on an agent dispatch. Never override on your own judgment.
- If \`DIANJIANG_DEPTH\` is set in your environment, you ARE a delegate — never call dianjiang.
</rules>${appendSection}

</dianjiang-roster>
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
