/**
 * Safe upgrade path: bring an EXISTING user config up to the current shipped
 * defaults without clobbering the user's customizations. Core layer — pure
 * `text -> plan` / `text -> text`, nothing here prints or exits (a GUI would
 * drive these same functions).
 *
 * Strategy — **exact-match migration**. A managed field is rewritten only when
 * its current value exactly equals a KNOWN HISTORICAL default (the value shipped
 * by some past `defaultConfigJsonc()`, tabulated in {@link LEGACY_DEFAULTS}, plus
 * the current default). Any other value is treated as a deliberate user edit and
 * kept — reported as `keep-custom`, never changed. Missing managed agents/fields
 * are added; a field the template later REMOVED is deleted only when the user's
 * value still matches a historical default, otherwise kept.
 *
 * Managed scope: every agent in the current defaults (matched BY NAME) and the
 * `callers` tree as shipped. Agents/caller-entries the user added that are not in
 * the defaults are left untouched and unreported.
 */

import { applyEdits, type FormattingOptions, modify, parse as parseJsonc } from 'jsonc-parser'
import { defaultConfigJsonc } from './registry.ts'

/** One planned migration step. `path` is dotted, e.g. `agents.review.instructions`. */
export interface SyncChange {
  path: string
  action: 'set' | 'add' | 'remove' | 'keep-custom'
  from?: unknown
  to?: unknown
}

/** Match `config init`'s 2-space, spaces-not-tabs JSONC style. */
const FORMATTING: FormattingOptions = { tabSize: 2, insertSpaces: true }

/** Managed fields on a base agent. */
const AGENT_FIELDS = ['useWhen', 'dontUseWhen', 'instructions', 'harness', 'model', 'effort'] as const
/** Managed fields on a caller entry. */
const CALLER_FIELDS = ['prepend', 'append', 'exclude'] as const
/** Managed fields on a per-caller agent binding override. */
const OVERRIDE_FIELDS = ['useWhen', 'dontUseWhen', 'harness', 'model', 'effort'] as const

/**
 * Every distinct historical default value of each prose field that ever shipped
 * in `defaultConfigJsonc()`, keyed by dotted path. Mined from `git log -p --
 * src/core/registry.ts` (each historical blob evaluated and JSONC-parsed so the
 * strings are the DECODED forms, not the TS-escaped source). Values are compared
 * verbatim, so a match means "this is an old default, safe to migrate"; anything
 * else is a user customization.
 *
 * Includes four never-committed intermediate defaults that shipped to a live
 * config via `config init --force` and so are invisible to git: the two
 * "focused/deep review" review descriptions, the intermediate review
 * `instructions`, and the codex `append` variant with the multi-runId waiter
 * sentence.
 */
const LEGACY_DEFAULTS: Record<string, string[]> = {
  'agents.review.useWhen': [
    'you want an independent cross-vendor code review of a diff; runs gpt-5.6-sol at xhigh — stronger reasoning than opus, slightly below fable',
    'you want an independent cross-vendor code review of a diff',
    'you want a second opinion on a diff from a different vendor than the implementer and caller',
    "you want an independent cross-vendor code review of a diff; focused and findings-only by default — say 'deep review' in the task for a comprehensive audit; runs gpt-5.6-sol at xhigh — stronger reasoning than opus, slightly below fable",
  ],
  'agents.review.dontUseWhen': ['a quick lint/style pass your own subagents already cover'],
  'agents.review.instructions': [
    "Default to a FOCUSED review: cover exactly the risks, files, and acceptance criteria the task names. Verifying a specific falsifiable hypothesis in depth is fine; a fixed all-dimension fan-out is not. Run a comprehensive deep review only when the task explicitly asks for one. Output contract: actionable findings only, ordered by severity — each with file:line, impact, how to trigger it, and a suggested fix; if nothing qualifies, output 'clean' plus one line on what you checked. Do not restate background or emit process narration, statistics, workflow/skill feedback, or non-blocking nits unless the task asks for them. Record `git rev-parse HEAD` (and whether the tree is dirty) before reading code and name that state in your verdict; if the tree changes mid-review, report 'snapshot changed' and state which state each finding applies to — never claim you covered a moving target. When resumed to verify fixes, check only the named findings and the fix delta — report each as fixed or still open, plus any regression the fix itself introduced; do not re-run the full review.",
  ],
  'agents.second-opinion.useWhen': [
    "consult-only: a hard debugging hypothesis or an architecture/design decision where you're stuck or the call is expensive to reverse; runs fable — Anthropic's strongest reasoning model",
    "consult-only: a hard debugging hypothesis or an architecture/design decision where you're stuck or the call is expensive to reverse",
    'consult-only: hard debugging hypotheses or architecture/design review needing maximum firepower',
  ],
  'agents.second-opinion.dontUseWhen': ['the task requires editing code (this agent must not make changes)'],
  'agents.search-twitter.useWhen': [
    "live X/Twitter lookups: find tweets, threads, account activity, or what people say about a topic right now — grok's native X search is real-time and extremely fast",
    'live X/Twitter lookups: find tweets, threads, account activity, or what people say about a topic right now',
  ],
  'agents.search-twitter.dontUseWhen': [
    'general web research (use your own web/search tools) or anything needing code changes',
    'general web research or anything needing code changes',
    'general web research (use explore) or anything needing code changes',
  ],
  'agents.search-twitter.instructions': ['Use your live X/Twitter search tools. Cite the tweet URL for every claim.'],
  'agents.design-frontend.useWhen': [
    'UI/UX work needing visual taste: components, layouts, styling, interaction polish, or design review of front-end code',
  ],
  'agents.design-frontend.dontUseWhen': ['backend logic or refactors with no visual/UX judgment involved'],
  'agents.rewrite-prompt.useWhen': [
    'rewriting, compressing, or restructuring prompts and agent instructions, especially when a large corpus must be read first; runs opus 4.6 with 1M context — better prose style (文风) than later opus generations',
    'rewriting, compressing, or restructuring prompts and agent instructions, especially when a large corpus must be read first',
  ],
  'agents.rewrite-prompt.dontUseWhen': ['ordinary coding tasks'],
  'agents.rewrite-prompt.instructions': ['Output only the rewritten prompt unless asked otherwise.'],
  'callers.claude.prepend': [
    'If your session model is fable, act as an orchestrator to preserve fable tokens: delegate execution work (implementation, mechanical edits, running tests/builds) to your built-in subagents with `model: opus`, keeping only planning, task decomposition, tricky debugging, and verification of subagent output for yourself. Delegate coherent, independently verifiable chunks (a new file, a test suite, a bulk edit); keep small in-context edits yourself — the cost of writing the brief must not exceed the task. For cross-vendor perspectives or capabilities your subagents lack, use the dianjiang roster below.',
    'If your session model is fable, act as an orchestrator to preserve fable tokens: delegate execution work (implementation, mechanical edits, running tests/builds) to your built-in subagents with `model: opus`, keeping only planning, task decomposition, tricky debugging, and verification of subagent output for yourself. For cross-vendor perspectives or capabilities your subagents lack, use the dianjiang roster below.',
    'If your session model is fable, act as an orchestrator to preserve fable tokens: delegate execution work (implementation, mechanical edits, broad searches, running tests/builds) to your built-in subagents with model: opus, keeping only planning, task decomposition, tricky debugging, and verification of subagent output for yourself.',
  ],
  'callers.claude.agents.second-opinion.useWhen': [
    "consult-only: a hard debugging hypothesis or an architecture/design decision where you're stuck or the call is expensive to reverse; runs gpt-5.6-sol at xhigh — stronger reasoning than opus, slightly below fable",
  ],
  'callers.codex.append': [
    'Your shell sessions do NOT wake you when a background command finishes, and polling is easy to forget. To collect a dianjiang run without blocking, use your subagent notification channel: `spawn_agent` with `fork_turns: "none"` and the message "Run `dianjiang result <runId> --wait --timeout 300`. If it prints status \'running\', run it again. When the status is terminal, return the full JSON verbatim." — its completion notification wakes you with the result while you keep working. If you have nothing else to do, just run `dianjiang result <runId> --wait --timeout 300` in the foreground. Either way, never end your turn with a dispatched run uncollected.',
    'Your shell sessions do NOT wake you when a background command finishes, and polling is easy to forget. To collect a dianjiang run without blocking, use your subagent notification channel: `spawn_agent` with `fork_turns: "none"` and the message "Run `dianjiang result <runId> --wait --timeout 300`. If it prints status \'running\', run it again. When the status is terminal, return the full JSON verbatim." — its completion notification wakes you with the result while you keep working. One waiter can collect several runIds — list them all in its message rather than spawning one waiter per run. If you have nothing else to do, just run `dianjiang result <runId> --wait --timeout 300` in the foreground. Either way, never end your turn with a dispatched run uncollected.',
  ],
  'callers.codex.agents.review.useWhen': [
    'you want an independent cross-vendor code review of a diff; runs claude opus at xhigh',
    "you want an independent cross-vendor code review of a diff; focused and findings-only by default — say 'deep review' in the task for a comprehensive audit; runs claude opus at xhigh",
  ],
  'agents.explore.useWhen': [
    'broad codebase search, research, or summarization',
    'broad codebase search, research, or summarization where cheap and fast matters',
  ],
  'agents.explore.dontUseWhen': ['the task needs deep reasoning or code changes'],
  'callers.claude.append': [
    'Default your built-in subagents to the opus model for execution work — implementation, mechanical edits, running tests. Do not route implementation through dianjiang.',
    'For implementation work, use your built-in subagents (model: opus) — do not route implementation through dianjiang.',
  ],
  'agents.implement.useWhen': [
    "a well-scoped feature or module can be built independently of the caller's conversation context",
  ],
  'agents.implement.dontUseWhen': ["the task needs the caller's live conversation context or ongoing back-and-forth"],
}

interface RawConfig {
  agents?: Array<Record<string, unknown> & { name?: string }>
  callers?: Record<string, RawCaller | undefined>
  [key: string]: unknown
}
interface RawCaller {
  agents?: Record<string, Record<string, unknown> | undefined>
  [key: string]: unknown
}

/** Structural (deep) equality for the value types we compare (strings, string arrays). */
function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function parse(text: string): RawConfig {
  return (parseJsonc(text, [], { allowTrailingComma: true }) as RawConfig | undefined) ?? {}
}

function findAgent(config: RawConfig, name: string): Record<string, unknown> | undefined {
  return config.agents?.find((a) => a?.name === name)
}

/**
 * Classify one managed field and, if it changed, push its {@link SyncChange}.
 * `userVal` is the value on disk (undefined = missing); `currentDefault` is the
 * value in the shipped defaults (undefined = the field was removed).
 */
function classifyField(
  changes: SyncChange[],
  path: string,
  userVal: unknown,
  currentDefault: unknown,
): void {
  const known: unknown[] = [...(LEGACY_DEFAULTS[path] ?? [])]
  if (currentDefault !== undefined) known.push(currentDefault)
  const isKnownDefault = (v: unknown) => known.some((k) => eq(k, v))

  if (userVal === undefined) {
    // Missing managed field: add it if the current defaults still ship it.
    if (currentDefault !== undefined) changes.push({ path, action: 'add', to: currentDefault })
    return
  }
  if (currentDefault === undefined) {
    // Field removed from the template: delete it only if the user's value is a
    // recognized old default; otherwise it's a user extension — keep it.
    if (isKnownDefault(userVal)) changes.push({ path, action: 'remove', from: userVal })
    else changes.push({ path, action: 'keep-custom', from: userVal })
    return
  }
  if (eq(userVal, currentDefault)) return // already current
  if (isKnownDefault(userVal)) changes.push({ path, action: 'set', from: userVal, to: currentDefault })
  else changes.push({ path, action: 'keep-custom', from: userVal })
}

/**
 * Diff a user config's JSONC text against the current shipped defaults and the
 * legacy table. Pure and side-effect free — returns the ordered plan; apply it
 * with {@link applySyncDefaults}.
 */
export function planSyncDefaults(userText: string): SyncChange[] {
  const user = parse(userText)
  const defaults = parse(defaultConfigJsonc())
  const changes: SyncChange[] = []

  for (const defAgent of defaults.agents ?? []) {
    const name = defAgent.name
    if (typeof name !== 'string') continue
    const base = `agents.${name}`
    const userAgent = findAgent(user, name)
    if (userAgent === undefined) {
      // A managed default agent the user deleted (or never had) — re-add it whole.
      changes.push({ path: base, action: 'add', to: defAgent })
      continue
    }
    for (const field of AGENT_FIELDS) {
      classifyField(changes, `${base}.${field}`, userAgent[field], defAgent[field])
    }
  }

  for (const [caller, defCaller] of Object.entries(defaults.callers ?? {})) {
    if (!defCaller) continue
    const base = `callers.${caller}`
    const userCaller = user.callers?.[caller]
    if (userCaller === undefined) {
      changes.push({ path: base, action: 'add', to: defCaller })
      continue
    }
    for (const field of CALLER_FIELDS) {
      classifyField(changes, `${base}.${field}`, userCaller[field], defCaller[field])
    }
    for (const [agentName, defOverride] of Object.entries(defCaller.agents ?? {})) {
      if (!defOverride) continue
      const opath = `${base}.agents.${agentName}`
      const userOverride = userCaller.agents?.[agentName]
      if (userOverride === undefined) {
        changes.push({ path: opath, action: 'add', to: defOverride })
        continue
      }
      for (const field of OVERRIDE_FIELDS) {
        classifyField(changes, `${opath}.${field}`, userOverride[field], defOverride[field])
      }
    }
  }

  return changes
}

/** Resolve a dotted plan path to a jsonc-parser segment array against `config`. */
function pathToSegments(
  config: RawConfig,
  path: string,
  action: SyncChange['action'],
): { segments: Array<string | number>; isArrayInsertion: boolean } {
  const parts = path.split('.') as string[]
  if (parts[0] === 'agents') {
    const name = parts[1]
    const idx = config.agents?.findIndex((a) => a?.name === name) ?? -1
    if (parts.length === 2) {
      // Whole-agent op. An add for a missing agent appends to the array.
      if (action === 'add' && idx < 0) {
        return { segments: ['agents', config.agents?.length ?? 0], isArrayInsertion: true }
      }
      return { segments: ['agents', idx], isArrayInsertion: false }
    }
    return { segments: ['agents', idx, parts[2]!], isArrayInsertion: false }
  }
  // callers.*
  const caller = parts[1]!
  if (parts.length === 2) return { segments: ['callers', caller], isArrayInsertion: false }
  if (parts[2] === 'agents') {
    const agentName = parts[3]!
    if (parts.length === 4) return { segments: ['callers', caller, 'agents', agentName], isArrayInsertion: false }
    return { segments: ['callers', caller, 'agents', agentName, parts[4]!], isArrayInsertion: false }
  }
  return { segments: ['callers', caller, parts[2]!], isArrayInsertion: false }
}

/**
 * Apply a sync plan to the config text, preserving comments and formatting via
 * jsonc-parser edits. `keep-custom` entries are report-only (no edit). Pure:
 * text in, text out — the caller re-validates and writes.
 */
export function applySyncDefaults(userText: string, changes?: SyncChange[]): string {
  const plan = changes ?? planSyncDefaults(userText)
  let text = userText
  for (const change of plan) {
    if (change.action === 'keep-custom') continue
    // Re-parse each round so name→index resolution reflects prior edits.
    const config = parse(text)
    const { segments, isArrayInsertion } = pathToSegments(config, change.path, change.action)
    const value = change.action === 'remove' ? undefined : change.to
    const edits = modify(text, segments, value, { formattingOptions: FORMATTING, isArrayInsertion })
    text = applyEdits(text, edits)
  }
  return text
}
