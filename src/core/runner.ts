/**
 * The runner: the one place that spawns a harness, waits, parses, and persists.
 *
 * "A tool, not an orchestrator" — dispatch runs exactly one harness and returns.
 *
 * "Job done is holy" (credit agent-mux): EVERY run executes in a detached
 * `_exec <runId>` worker, so the job survives the caller's timeout or death —
 * callers are typically AI agents whose shell tools WILL time out. Sync mode
 * merely waits for the worker; `--detach` returns immediately. The worker log
 * (`logs/<runId>.log`) doubles as the run's artifact path: the full harness
 * stdout/stderr streams into it progressively.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  DianjiangConfig,
  DispatchSpec,
  HarnessName,
  RunRecord,
  RunReport,
} from './types.ts'
import { adapters } from './adapters/index.ts'
import { logEvent } from './log.ts'
import { logFilePath } from './paths.ts'
import { getRun, insertRun, updateRun } from './store.ts'

/** Raised when the recursion guard trips; the CLI maps it to exit code 2. */
export class DepthLimitError extends Error {
  constructor(depth: number, maxDepth: number) {
    super(
      `Depth limit reached (DIANJIANG_DEPTH=${depth} >= maxDepth=${maxDepth}); refusing to dispatch. As a delegate, do not re-delegate.`,
    )
    this.name = 'DepthLimitError'
  }
}

export interface DispatchOptions {
  /** Agent name to record (raw `--harness` dispatches omit it). */
  agent?: string
  /**
   * Resolved agent instructions to freeze onto the run. Frozen at dispatch so
   * the worker and later resumes use this run's original contract, never the
   * live config (which may change or be deleted after dispatch).
   */
  instructions?: string
  harness: HarnessName
  model?: string
  effort?: string
  task: string
  cwd: string
  detach: boolean
  /**
   * For `resume`: the run this follows up on. The worker derives the harness
   * session to continue from this run's persisted row.
   */
  parentRunId?: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Absolute path to the CLI entry, used to re-spawn as a detached worker. */
function cliEntryPath(): string {
  return fileURLToPath(new URL('../cli/index.ts', import.meta.url))
}

/** Build the stdout `RunReport` from a persisted record. */
export function buildReport(record: RunRecord): RunReport {
  const durationMs = record.finishedAt
    ? new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime()
    : null
  return {
    runId: record.runId,
    agent: record.agent ?? null,
    harness: record.harness,
    model: record.model ?? null,
    effort: record.effort ?? null,
    status: record.status,
    exitCode: record.exitCode ?? null,
    durationMs,
    result: record.result ?? null,
    harnessSessionId: record.harnessSessionId ?? null,
    cwd: record.cwd,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt ?? null,
    usage: record.usage ?? null,
  }
}

/**
 * Drain a stream while echoing every chunk to a sink. Inside the worker,
 * process.stdout/stderr ARE the run's log file, so the harness output is
 * persisted progressively — partial output survives even a killed worker.
 */
async function tee(
  stream: ReadableStream<Uint8Array>,
  sink: { write(chunk: string): unknown },
): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of stream) {
    const part = decoder.decode(chunk, { stream: true })
    text += part
    sink.write(part)
  }
  return text + decoder.decode()
}

/**
 * Spawn the harness for an already-persisted `running` record, await it, parse
 * the result, persist the outcome, and return the report. Runs inside the
 * `_exec` worker.
 */
async function runToCompletion(record: RunRecord, spec: DispatchSpec): Promise<RunReport> {
  const adapter = adapters[record.harness]
  const command = adapter.buildCommand(spec)
  // The child is one level deeper; its own guard reads this.
  const childDepth = Number(process.env.DIANJIANG_DEPTH ?? 0) + 1

  const proc = Bun.spawn(command.cmd, {
    cwd: record.cwd,
    env: { ...process.env, ...(command.env ?? {}), DIANJIANG_DEPTH: String(childDepth) },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr] = await Promise.all([
    tee(proc.stdout, process.stdout),
    tee(proc.stderr, process.stderr),
  ])
  const exitCode = await proc.exited
  const finishedAt = new Date().toISOString()

  // Read then remove the adapter's temp output file, if it declared one.
  let outputFileContents: string | undefined
  if (command.outputFile) {
    try {
      outputFileContents = readFileSync(command.outputFile, 'utf8')
    } catch {
      // File never written; fall back to the JSONL stream.
    }
    try {
      unlinkSync(command.outputFile)
    } catch {
      // Already gone; ignore.
    }
  }

  let patch: Partial<RunRecord>
  if (exitCode === 0) {
    try {
      const parsed = adapter.parseResult(spec, stdout, outputFileContents)
      patch = {
        status: 'completed',
        exitCode,
        result: parsed.result,
        harnessSessionId: parsed.harnessSessionId,
        usage: parsed.usage,
        finishedAt,
      }
    } catch (err) {
      // A clean exit but unparseable output is still a failure for us.
      patch = { status: 'failed', exitCode, result: `parseResult failed: ${errorMessage(err)}`, finishedAt }
    }
  } else {
    // Non-zero: keep the tail of stderr as the surfaced result.
    patch = { status: 'failed', exitCode, result: stderr.slice(-2000), finishedAt }
  }

  updateRun(record.runId, patch)
  return buildReport({ ...record, ...patch })
}

/** True if a PID currently maps to a live process (signal 0 probe). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Repair a stale record before reporting: a detached worker that died leaves
 * status "running" forever, which would make a polling caller wait
 * indefinitely. Only detached runs carry a pid, so sync runs are unaffected.
 */
export function reconcileRun(record: RunRecord): RunRecord {
  if (record.status !== 'running' || record.pid === undefined || isProcessAlive(record.pid)) {
    return record
  }
  // Re-read before patching: the worker may have finished (and exited) between
  // our read and the liveness probe.
  const fresh = getRun(record.runId)
  if (fresh && fresh.status !== 'running') return fresh
  const patch: Partial<RunRecord> = {
    status: 'failed',
    result: `Detached worker (pid ${record.pid}) died before completing; see its log under the dianjiang logs dir.`,
    finishedAt: new Date().toISOString(),
  }
  updateRun(record.runId, patch)
  logEvent('reconcile.failed', { runId: record.runId, pid: record.pid })
  return { ...record, ...patch }
}

export interface WaitOptions {
  /** Give up after this long; the run keeps going. Omit to wait indefinitely. */
  timeoutMs?: number
  /** Store poll interval (default 500ms). */
  pollMs?: number
}

/**
 * Block until a run reaches a terminal status (or the timeout elapses) and
 * return its freshest record. The worker is a detached process we cannot
 * `waitpid`, so this polls the store; `reconcileRun` on each tick turns a
 * dead-worker "running" row into "failed" instead of waiting forever. On
 * timeout the record is returned as-is (status still "running") — the run
 * itself is unaffected and can be waited on again.
 */
export async function waitForRun(runId: string, opts: WaitOptions = {}): Promise<RunRecord | undefined> {
  const pollMs = opts.pollMs ?? 500
  const deadline = opts.timeoutMs === undefined ? undefined : Date.now() + opts.timeoutMs
  for (;;) {
    const record = getRun(runId)
    if (!record) return undefined
    const fresh = reconcileRun(record)
    if (fresh.status !== 'running') return fresh
    if (deadline !== undefined && Date.now() >= deadline) return fresh
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * Spawn the `_exec` worker for a persisted record. The worker is a detached
 * session leader: killing the dispatching CLI (Ctrl-C, caller timeout) never
 * kills the job.
 */
function spawnWorker(record: RunRecord, depth: number): ChildProcess {
  const logFd = openSync(logFilePath(record.runId), 'a')
  try {
    const child = spawn(process.execPath, [cliEntryPath(), '_exec', record.runId], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: record.cwd,
      // Worker inherits the current depth; it re-derives childDepth itself.
      env: { ...process.env, DIANJIANG_DEPTH: String(depth) },
    })
    updateRun(record.runId, { pid: child.pid })
    logEvent('spawn', { runId: record.runId, pid: child.pid })
    return child
  } finally {
    closeSync(logFd)
  }
}

/** Main entry: persist a run and execute it (sync or detached). */
export async function dispatch(opts: DispatchOptions, config: DianjiangConfig): Promise<RunReport> {
  const depth = Number(process.env.DIANJIANG_DEPTH ?? 0)
  if (depth >= config.maxDepth) throw new DepthLimitError(depth, config.maxDepth)

  const runId = crypto.randomUUID()
  const record: RunRecord = {
    runId,
    agent: opts.agent,
    harness: opts.harness,
    model: opts.model,
    effort: opts.effort,
    status: 'running',
    cwd: opts.cwd,
    task: opts.task,
    startedAt: new Date().toISOString(),
    parentRunId: opts.parentRunId,
    instructions: opts.instructions,
  }
  insertRun(record)
  logEvent('dispatch', {
    runId,
    agent: opts.agent,
    harness: opts.harness,
    model: opts.model,
    detach: opts.detach,
  })

  const child = spawnWorker(record, depth)

  if (opts.detach) {
    child.unref()
    // DB status stays "running"; only the immediate report says "detached".
    return buildReport({ ...record, status: 'detached', pid: child.pid ?? undefined })
  }

  // Sync mode: wait for the worker, then report the persisted outcome.
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  const fresh = getRun(runId) ?? record
  // A worker that died without persisting an outcome reconciles to "failed".
  return buildReport(reconcileRun(fresh))
}

/**
 * Build the DispatchSpec purely from a persisted run record. Instructions come
 * from the record's frozen `instructions` — never the live config — so a config
 * edit or deletion after dispatch cannot change the run's execution contract.
 */
export function specFromRecord(record: RunRecord, resumeSessionId?: string): DispatchSpec {
  return {
    runId: record.runId,
    prompt: record.task,
    model: record.model,
    effort: record.effort,
    instructions: record.instructions,
    resumeSessionId,
  }
}

/**
 * Detached-worker entry: rebuild the DispatchSpec from the persisted row (plus
 * the parent row for a resume session id) and run it to completion.
 */
export async function executeRun(runId: string): Promise<RunReport> {
  logEvent('exec.start', { runId })
  const record = getRun(runId)
  if (!record) throw new Error(`Run ${runId} not found`)

  // resume + detach: the follow-up session lives on the parent run's row.
  let resumeSessionId: string | undefined
  if (record.parentRunId) resumeSessionId = getRun(record.parentRunId)?.harnessSessionId

  const spec = specFromRecord(record, resumeSessionId)
  try {
    const report = await runToCompletion(record, spec)
    logEvent('exec.done', { runId, exitCode: report.exitCode, status: report.status })
    return report
  } catch (err) {
    logEvent('exec.error', { runId, message: errorMessage(err) })
    throw err
  }
}
