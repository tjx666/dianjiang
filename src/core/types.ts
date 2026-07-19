/**
 * Core contracts for dianjiang. Terminology (see DESIGN.md):
 * - agent:   a named, human-compiled preset (harness + model + effort + instructions)
 * - harness: an underlying coding-agent CLI (claude / codex / grok)
 * - adapter: the code-level module that adapts one harness to these contracts
 * - run:     one dispatched execution, persisted in SQLite
 */

export type HarnessName = 'claude' | 'codex' | 'grok'

export const HARNESS_NAMES: readonly HarnessName[] = ['claude', 'codex', 'grok']

export type RunStatus = 'running' | 'completed' | 'failed' | 'detached'

/** One entry of the roster in config.jsonc. */
export interface AgentConfig {
  /** Verb/deliverable-style name, e.g. `implement`, `review`. */
  name: string
  /** When the delegating AI should pick this agent. Drives delegation accuracy. */
  useWhen: string
  /** When NOT to pick this agent. */
  dontUseWhen?: string
  harness: HarnessName
  /** Harness-native model name; omit to use the harness's default. */
  model?: string
  /** Harness-native effort value; validated per harness by the registry. */
  effort?: string
  /** Optional agent system prompt, kept short. */
  instructions?: string
}

/**
 * A per-caller override of an agent's binding. The harness/model/effort trio
 * REPLACES the whole binding: there is no field merging, so a cross-vendor
 * override never inherits another vendor's model name, and an omitted
 * `model`/`effort` means "harness default", NOT the base agent's value.
 *
 * `useWhen`/`dontUseWhen` are the exception: each independently overrides the
 * base agent's description for this caller only, falling back to the base agent
 * when omitted. Use them for caller-relative wording (e.g. model-strength notes
 * that only make sense relative to the caller's own model).
 */
export interface AgentBinding {
  harness: HarnessName
  /** Harness-native model name; omit to use the harness's default. */
  model?: string
  /** Harness-native effort value; validated per harness by the registry. */
  effort?: string
  /**
   * Caller-relative override of the base agent's `useWhen`; falls back to the
   * base agent when omitted. For descriptions that only make sense relative to
   * this caller (e.g. model-strength notes).
   */
  useWhen?: string
  /**
   * Caller-relative override of the base agent's `dontUseWhen`; falls back to
   * the base agent when omitted.
   */
  dontUseWhen?: string
}

/**
 * Per-caller configuration. Future per-caller fields (e.g. inject `target`) are
 * anticipated; `agents` and `exclude` exist today.
 */
export interface CallerConfig {
  /** Sparse per-caller binding overrides, keyed by base agent name. */
  agents?: Record<string, AgentBinding>
  /** Agent names hidden from this caller: not injected into its roster and rejected at dispatch. */
  exclude?: string[]
  /**
   * Free-form markdown rendered at the TOP of this caller's injected roster
   * block, before the intro. For scoping rules the caller should read before
   * the roster (e.g. "implementation stays native").
   */
  prepend?: string
  /** Free-form markdown appended to this caller's injected roster block, after the rules. */
  append?: string
}

export interface DianjiangConfig {
  /** Recursion guard: refuse to dispatch when DIANJIANG_DEPTH >= maxDepth. */
  maxDepth: number
  agents: AgentConfig[]
  /**
   * Per-caller binding overrides. Some agents are defined relative to the
   * caller (e.g. `review` must be a different vendor than the caller); this
   * namespace lets each caller harness rebind them.
   */
  callers?: Partial<Record<HarnessName, CallerConfig>>
}

/** What the runner asks an adapter to execute. */
export interface DispatchSpec {
  /** Pre-generated UUID; claude/grok adapters inject it as --session-id. */
  runId: string
  /** The task text from the caller (instructions NOT yet applied). */
  prompt: string
  model?: string
  effort?: string
  /**
   * Agent instructions. Cross-vendor baseline: adapters prepend them to the
   * prompt; adapters with a real system-prompt flag (claude
   * --append-system-prompt) use that instead.
   */
  instructions?: string
  /** When set, resume this harness session instead of starting a new one. */
  resumeSessionId?: string
}

/** A fully-built harness invocation; the runner spawns it verbatim. */
export interface HarnessCommand {
  /** argv; cmd[0] is the binary. */
  cmd: string[]
  env?: Record<string, string>
  /**
   * Set by adapters that read the final message from a file (codex -o). The
   * runner reads it after exit and passes the contents to parseResult.
   */
  outputFile?: string
}

/**
 * Usage as reported by the harness; every field optional — never estimated.
 * dianjiang records only what a harness actually prints: tokens/turns where
 * available, and `costUsd` only where the harness reports a cost (claude).
 */
export interface RunUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  totalTokens?: number
  turns?: number
  costUsd?: number
}

export interface HarnessResult {
  /** Final assistant message. */
  result: string
  /** Harness-side session id (codex thread_id; equals runId for claude/grok). */
  harnessSessionId: string
  /** Harness-reported usage, when the output carried any; never estimated. */
  usage?: RunUsage
}

/** One model this harness is known to accept (locally verified). */
export interface KnownModel {
  name: string
  /** Effort values valid for THIS model; empty = model takes no effort flag. */
  efforts: readonly string[]
  /** True for the harness's default model. */
  isDefault?: boolean
  note?: string
}

export interface HarnessAdapter {
  name: HarnessName
  /** Effort values this harness accepts; empty means no effort support. */
  efforts: readonly string[]
  /**
   * Curated, locally-verified snapshot of models this harness accepts under the
   * current auth, with per-model effort sets. Drives effort validation (known
   * model → validate against its efforts; unknown model → permissive) and the
   * `config harnesses` self-check.
   */
  knownModels: readonly KnownModel[]
  /** ISO date the `knownModels` snapshot was last verified locally. */
  modelsVerifiedAt: string
  /**
   * Live model enumeration where the CLI supports it (only grok today). Returns
   * the accepted model names, or undefined when the CLI can't be queried
   * (spawn failure, unparseable output) — callers fall back to `knownModels`.
   */
  listModels?(): string[] | undefined
  buildCommand(spec: DispatchSpec): HarnessCommand
  /**
   * Parse the finished process's stdout (and outputFile contents, if the
   * command declared one) into the unified result.
   */
  parseResult(spec: DispatchSpec, stdout: string, outputFileContents?: string): HarnessResult
  /** argv appended to the binary for the `config harnesses` self-check. */
  versionArgs: string[]
}

/** One row in runs.sqlite. */
export interface RunRecord {
  runId: string
  /** Agent name; undefined for raw `--harness` dispatches. */
  agent?: string
  harness: HarnessName
  model?: string
  effort?: string
  status: RunStatus
  exitCode?: number
  result?: string
  harnessSessionId?: string
  cwd: string
  /** The task text as passed by the caller. */
  task: string
  /** ISO-8601 UTC. */
  startedAt: string
  finishedAt?: string
  /** PID of the detached worker, when run with --detach. */
  pid?: number
  /** For `resume` runs: the run this one follows up on. */
  parentRunId?: string
  /** Harness-reported usage; stored as flat nullable columns (see store.ts). */
  usage?: RunUsage
}

/** The single JSON object `run`/`resume`/`result` print on stdout. */
export interface RunReport {
  runId: string
  agent: string | null
  harness: HarnessName
  model: string | null
  effort: string | null
  status: RunStatus
  exitCode: number | null
  durationMs: number | null
  result: string | null
  harnessSessionId: string | null
  cwd: string
  startedAt: string
  finishedAt: string | null
  /** Harness-reported usage; null when nothing was reported for this run. */
  usage: RunUsage | null
}
