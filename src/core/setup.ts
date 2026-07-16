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
import type { DianjiangConfig } from './types.ts'

const BEGIN = '<!-- dianjiang:begin -->'
const END = '<!-- dianjiang:end -->'

export type SetupAction = 'written' | 'updated'

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

/** Render the managed markdown block from the roster (see DESIGN.md template). */
export function renderRosterBlock(config: DianjiangConfig): string {
  const rows = config.agents
    .map((a) => `| ${a.name} | ${a.useWhen} | ${a.dontUseWhen ?? '—'} |`)
    .join('\n')

  return `${BEGIN}
# Delegation roster (dianjiang)

\`dianjiang\` dispatches self-contained tasks to other coding-agent CLIs.
dianjiang agents are separate from your built-in subagents. Pick one by task
shape — never pick harnesses or models yourself:

| Agent | Use when | Don't use when |
|---|---|---|
${rows}

Rules:
- \`dianjiang run <agent> "<task>"\` blocks until done and prints one JSON object; read \`.result\`.
- Write tasks self-contained: background, file paths, acceptance criteria, expected output.
- Follow up in the same session with \`dianjiang resume <runId> "<message>"\`.
- For tasks likely over ~5 minutes, add \`--detach\`, then poll \`dianjiang status <runId>\`
  and fetch \`dianjiang result <runId>\` when completed.
- If your command times out or is killed, the run keeps going in the background —
  recover it any time with \`dianjiang result <runId>\`.
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

/** Inject the roster block into all three targets. */
export function runSetup(config: DianjiangConfig, targets = defaultTargets()): SetupResult[] {
  const block = renderRosterBlock(config)
  return Object.values(targets).map((file) => ({
    file,
    action: injectBlock(file, block),
  }))
}
