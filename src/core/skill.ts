/**
 * `skill`: render the on-demand usage doc for a caller harness. Instead of
 * injecting a managed block into vendor global instruction files (the removed
 * `setup` command — always-on injection skewed model behavior too much), each
 * vendor ships a thin skill file whose only job is to run
 * `dianjiang skill --caller <harness>` and follow the printed doc. The doc is
 * rendered fresh from config on every call, so roster edits need no re-inject.
 */

import type { DianjiangConfig, HarnessName } from './types.ts'
import { resolveAgent } from './registry.ts'

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
 * codex routes the wait through a waiter subagent instead. A second incident
 * (2026-07): the generic "on timeout, re-run it" rule was misread as license
 * for the ROOT agent to poll `wait_agent` every 30s — codex renders each short
 * wait as visible "Waiting for agents" noise — so the codex strategy now pins
 * the re-run loop to the waiter and bans short-poll waits on the parent.
 */
const COLLECTION_STRATEGY: Record<HarnessName, string> = {
  claude: `Start that command in a background shell (\`run_in_background: true\`)
  immediately after dispatching — its completion notification delivers the
  result while you keep working. Run it in the foreground only when the result
  is the last thing you need before you can proceed.`,
  codex: `That re-run-on-"running" loop belongs INSIDE a waiter subagent —
  never in your own turn. The moment you hold a runId, spawn a waiter —
  \`spawn_agent\` with \`fork_turns: "none"\` and the message: "Run
  \`dianjiang result <runId> --wait --timeout 300\`. If it prints status
  'running', run it again. Stop only on a terminal status, return that full
  JSON verbatim, and emit no progress narration." One waiter per runId; runIds
  you already hold may share a single waiter, but never delay the first waiter
  for runs you might dispatch later. The waiter's completion notification
  wakes you with the result; your shell sessions do NOT push completion
  events, so a background-shell wait WILL be forgotten. NEVER poll the waiter
  with repeated short \`wait_agent\` (or equivalent) calls — each one renders
  "Waiting for agents" noise. If you must wait explicitly, issue ONE long
  interruptible wait, wait again only if that single wait itself times out,
  and print no "still waiting" updates in between. Do not wait in the
  foreground first, and do not gate the waiter on how long you expect the run
  to take. Fall back to a foreground wait ONLY if subagents are unavailable or
  no slot is free. Every dispatched run must be collected before your turn
  ends.`,
  grok: `Start that command as a background task (\`background: true\`)
  immediately after dispatching — its completion notification delivers the
  result while you keep working. Run it in the foreground only when the result
  is the last thing you need before you can proceed.`,
}

/** Caller-less renders can't assume shell capabilities; stay neutral. */
const DEFAULT_COLLECTION = `Run it in the foreground (\`--timeout\` keeps it
  bounded), or in a background shell if your environment pushes completion
  notifications.`

/**
 * Render the usage doc printed by `dianjiang skill` (see the design skill's
 * template). Roster and rules are XML (`<agent>` elements + `<rules>`): XML
 * sectioning is what LLM prompting guides recommend, and a column-padded
 * markdown table is unreadable as raw terminal output.
 *
 * When `caller` is set, the doc documents `dianjiang run --caller <caller> ...`
 * so per-caller binding overrides resolve without env sniffing, and the
 * collect rule embeds that caller's collection strategy; the raw escape-hatch
 * command stays caller-less. When `caller` is undefined the doc renders a
 * neutral, capability-agnostic variant. A caller's optional `prepend` renders
 * at the top (before the intro — scoping rules read best before the roster),
 * wrapped in a `<caller-guidance>` element so caller-behavior guidance (e.g.
 * "use your own subagents for X") is not read as a dianjiang usage rule;
 * `append` renders after the rules.
 *
 * Each agent is resolved through `resolveAgent(config, name, caller)` so the
 * rendered `<use-when>`/`<dont-use-when>` reflect any caller-relative
 * description overrides (falling back to the base agent when unset). Agents in
 * the caller's `exclude` list are omitted.
 */
export function renderSkillDoc(config: DianjiangConfig, caller?: HarnessName): string {
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

  return `${prependSection}\`dianjiang\` is a CLI on this machine that dispatches self-contained tasks to
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
- Dispatched harnesses run in YOLO mode (permission-bypass flags) — only
  dispatch tasks safe for an unattended agent in that working directory.
- Machine-readable commands print exactly one JSON value on stdout; harness
  logs go to stderr, and the full stream tees to
  \`~/.dianjiang/logs/<runId>.log\`. Exit codes: 0 ok, 1 error/failed run, 2
  recursion-depth limit.
- If \`DIANJIANG_DEPTH\` is set in your environment, you ARE a delegate — never call dianjiang.
</rules>${appendSection}`
}
