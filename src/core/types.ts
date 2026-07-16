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

export interface DianjiangConfig {
  /** Recursion guard: refuse to dispatch when DIANJIANG_DEPTH >= maxDepth. */
  maxDepth: number
  agents: AgentConfig[]
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

export interface HarnessResult {
  /** Final assistant message. */
  result: string
  /** Harness-side session id (codex thread_id; equals runId for claude/grok). */
  harnessSessionId: string
}

export interface HarnessAdapter {
  name: HarnessName
  /** Effort values this harness accepts; empty means no effort support. */
  efforts: readonly string[]
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
}
