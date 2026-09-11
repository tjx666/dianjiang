/**
 * `skill`: render the on-demand usage doc for a caller harness. Instead of
 * injecting a managed block into vendor global instruction files (the removed
 * `setup` command — always-on injection skewed model behavior too much), an
 * installation exposes a thin skill file whose only job is to run
 * `dianjiang skill` and follow the printed doc. Shared skill files rely on
 * process ancestry; harness-private files may pass `--caller <harness>`
 * explicitly. The doc is rendered fresh from config on every call, so roster
 * edits need no re-inject.
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
 * A third incident (2026-08): "one long wait" was still interpreted as a 60s
 * parent-side poll. The strategy therefore names Codex's maximum supported
 * one-hour wait explicitly, subject to the current session's limits.
 * Tool yields are not CLI timeouts: reuse the live shell session (and outer
 * orchestration cell, when available) before considering another collector.
 */
const COLLECTION_STRATEGY: Record<HarnessName, string> = {
  claude: `Start that command in a background shell (\`run_in_background: true\`)
  immediately after dispatching — its completion notification delivers the
  result while you keep working. Run it in the foreground only when the result
  is the last thing you need before you can proceed.`,
  codex: `That re-run-on-"running" loop belongs INSIDE a waiter subagent —
  never in your own turn. The moment you hold a runId, spawn a waiter —
  \`spawn_agent\` with \`fork_turns: "none"\`. Explicitly choose an available
  low-cost model and low reasoning effort; prefer \`model: "gpt-5.6-luna"\` and
  \`reasoning_effort: "low"\` when available. Include this entire collection protocol
  in its message, plus the runId and the command's required cwd/environment
  (including a custom DIANJIANG_HOME or PATH), plus any existing session/cell ID:
  "Start \`dianjiang result <runId> --wait --timeout 300\` once. If the shell
  tool returns a session ID, continue the same \`session_id\` with \`write_stdin\`
  until the process exits; a tool's running response is NOT a CLI timeout.
  Only re-run the collection command after it exits successfully and its
  JSON explicitly says \`status: "running"\`. Stop only on a terminal status,
  return that full JSON verbatim, preserve the shell \`exit_code\` separately
  from the report's \`exitCode\`, and emit no progress narration. On a tool/command
  error, return the diagnostic, partial output, and known handles instead of
  blindly retrying; never invent an exit code. Do no repository investigation,
  extra status probes, or changes: the parent interprets the collected result.
  If your environment exposes \`functions.exec\` JavaScript orchestration with
  \`tools.exec_command\` and \`tools.write_stdin\`, put the mechanical same-process
  waits in an awaited loop there. When \`store\`/\`load\` are available, save an
  attempt-specific record before launch: phase, accumulated output, session ID,
  and terminal exit code. Inspect an existing record instead of launching again,
  and save it after every tool return. Accumulate output chunks in order, then emit
  the complete output and terminal shell exit code. This is tool orchestration,
  not a shell script. If the outer call returns a cell ID, use \`functions.wait\`
  on that same cell until completion; never restart the script or command while
  it is running. Retain the cell ID alongside the shell ID; never start a competing
  collector or call \`yield_control()\` between continuations. After interruption,
  collect the active cell first; only once it ends may you resume a nonterminal
  shell with \`write_stdin\`. An exited record is already collected. A starting
  record without a handle needs process-state diagnosis; report a concrete blocker
  if recovery is unavailable. A new attempt key does not justify another launch.
  Without this capability, call the tools directly with the same
  session discipline. Use the longest waits allowed by current tool schemas and
  higher-priority session limits, including the outer yield/wait; batching only
  saves model turns when that outer wait can cover multiple inner returns.
  Prefer explicit \`yield_time_ms: 3600000\` on outer exec and every outer wait
  when supported and permitted. Shell continuation waits, outer cell yields,
  parent notification waits, and the CLI's 300-second deadline are separate;
  a long tool wait does not extend that deadline.
  Allow enough output budget; recover truncated output before claiming it is
  complete. Preserve stdout/stderr in order; arrange an output artifact at launch
  if needed, and never rerun a finished collector to recover truncated output."
  One waiter per runId; reuse the active waiter after a yield, parent interruption,
  or missing notification. RunIds
  you already hold may share a single waiter, but never delay the first waiter
  for runs you might dispatch later. The waiter's completion notification
  wakes you with the result and does not require \`wait_agent\`. Do not rely on
  shell completion notifications to collect the run. NEVER poll the waiter
  with repeated \`wait_agent\` calls — each one renders visible "Waiting for
  agents" noise. When you need the waiter's result and have no other useful
  work, call \`wait_agent({ timeout_ms: 3600000 })\` ONCE, using the maximum
  supported one-hour timeout only if your tools and higher-priority session
  limits allow it; otherwise use their longest permitted wait. Advice to avoid
  blocking calls longer than 60 seconds is a responsiveness concern, not itself
  a hard cap on interruptible notification waits. Check the actual contract;
  identify a concrete tool limit, mandatory instruction, or observed responsiveness
  problem before shortening the wait. Do not assume shell or outer cell waits
  share the notification wait's limits or interruption behavior. It returns early
  when the waiter finishes or new
  user input arrives; new input does not stop the waiter. If the result is still
  pending afterward, handle any input or other work first, then use another
  maximum-timeout wait only when the waiter is again your sole unfinished work.
  NEVER shorten the timeout to poll, and print no unchanged-status updates
  between waits. After one hour without a terminal result, inspect the existing
  waiter once with \`list_agents\`; if it is running normally, repeat the long wait
  and hourly check. Shorter required waits do not justify extra status queries.
  On an error, unexpected idle state, or unclear progress, ask the same waiter to
  diagnose its retained state without competing for its shell output.
  Do not wait in the foreground first, and do not gate the waiter
  on how long you expect the run to take. Fall back to a foreground wait ONLY if
  subagents are unavailable or no slot is free; the original process owner must
  continue the same resumable session and report the responsiveness limitation.
  For foreground-only tools, keep the CLI deadline within the command time limit.
  Missing capabilities never justify abandoning a run or launching duplicates.
  Every dispatched run must be
  collected before your turn ends.`,
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
  const runPrefix = caller ? `dianjiang run --caller ${caller} <agent>` : 'dianjiang run <agent>'
  const runCmd = `${runPrefix} "<task>"`
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
- \`"<task>"\` and \`"<message>"\` are placeholders, not shell-quoting recipes.
  For long, multiline, or quote-containing text, load it from a single-quoted
  heredoc and pass the variable double-quoted:
  \`\`\`sh
  task=$(cat <<'DIANJIANG_TASK'
  ...task text exactly as written...
  DIANJIANG_TASK
  )
  ${runPrefix} "$task" --detach
  \`\`\`
  Choose a delimiter absent from the text. Use the same pattern with a
  \`message\` variable for \`resume\`; never hand-escape it inside shell quotes.
- Collect every run with \`dianjiang result <runId> --wait --timeout 300\`: it
  exits with the final JSON the moment the run finishes; on timeout it prints
  \`status: "running"\` — just re-run it. ${caller ? COLLECTION_STRATEGY[caller] : DEFAULT_COLLECTION}
- Check \`.status\` first: read \`.result\` only when it is "completed". On
  "failed", inspect \`.failure\` before \`.result\`; \`code: "quota_exhausted"\`
  means the selected harness has no available quota — recommend another
  harness, and never treat \`.result\` as the task's answer. When \`.failure\`
  is null, \`.result\` is still a diagnostic summary, not a task answer.
- Write tasks self-contained (background, file paths, acceptance criteria,
  expected output): the delegate starts fresh in your cwd — it sees your files,
  not your conversation.
- For \`review\`, \`second-opinion\`, and adversarial or comparative discussions
  (including battle-style debates), brief the delegate as an independent
  evaluator: separate evidence (diffs, logs, measurements) from your
  interpretation, and present any conclusion you have reached as a hypothesis
  to test, not as the answer. Require the delegate to examine the strongest
  counterarguments to that hypothesis and disagree plainly when the evidence
  warrants it.
- Follow up in the same session with \`dianjiang resume <runId> "<message>"\` —
  it takes \`--detach\` too; use the same detach-and-collect flow.
- For an external native session, use \`dianjiang session list --harness <harness>\`
  and \`dianjiang session status --harness <harness> --session <native-session-uuid>\`.
  These inspect native sessions; \`status <runId>\` still inspects a dianjiang run.
- Deliver attributed text with \`dianjiang session send --harness <target-harness>
  --session <target-session-uuid> --from-session <your-native-session-uuid>
  --message-id <stable-message-uuid> "<message>"\`. Sender harness is detected from
  process ancestry; pass \`--from-harness\` when running outside an agent. Never
  borrow an inherited environment marker or invent a sender session ID.
  Use the same shell-safe message transport as \`resume\`.
- Native endpoints are local sockets: Codex defaults to its shared app-server
  control socket; Grok requires an existing shared leader. Pass \`--endpoint\`
  for another local backend or Claude's Peer address (strip \`uds:\`). A session
  in a separate private backend is not reachable through the default backend.
  Codex exposes that control socket only while a shared app-server daemon runs;
  without one, a Codex session is live-reachable only through an app-server you
  pass with \`--endpoint\`, and otherwise only through \`--wake\`.
  Claude's inbound policy can hold or refuse messages; dianjiang does not change it.
- \`session send\` returns a receipt, never the target's model response:
  \`accepted\` means native queue admission, \`written\` means no native ACK,
  \`unknown\` means delivery is uncertain, and \`rejected\` means no confirmed
  admission. Read it with \`dianjiang session receipt <message-id>\`. Reusing the
  same message ID returns the existing receipt and never sends again; changed
  content under that ID is refused. Do not blindly use a new ID after uncertainty.
  Default \`--mode queue\` preserves the native queue. \`--mode steer\` requires
  an active Codex turn; Grok requests best-effort mid-turn queue promotion;
  Claude accepts messages between tool calls and does not offer this mode.
- To continue a stopped external conversation, explicitly add \`--wake --cwd
  <original-directory>\` (optionally \`--model\` and \`--effort\`). Stop other
  owners first: state is scoped to the selected backend, not every process on
  the machine. Unknown state or connection failure never triggers a resume.
  A \`resumed\` receipt contains \`runId\`; collect that run using the same
  detached-run collection rule above. This starts a new execution of the
  existing conversation, not a fresh conversation or a reply receipt.
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
