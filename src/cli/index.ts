#!/usr/bin/env bun
/**
 * dianjiang CLI — a thin frontend over the core library. Every command that
 * produces machine output prints exactly one JSON object/array on stdout; human
 * chatter goes to stderr. Exit codes: 0 ok, 1 error/failed run, 2 depth limit.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { confirm, isCancel, multiselect, select, text as textPrompt } from '@clack/prompts'
import { defineCommand, runMain } from 'citty'
import type { AgentConfig, DianjiangConfig, HarnessName } from '../core/types.ts'
import { HARNESS_NAMES } from '../core/types.ts'
import { adapters, harnessVersions } from '../core/adapters/index.ts'
import {
  appendAgent,
  readConfigText,
  removeAgent,
  setAgentField,
  writeConfigText,
} from '../core/config-edit.ts'
import { logEvent } from '../core/log.ts'
import { configPath } from '../core/paths.ts'
import { defaultConfigJsonc, findAgent, loadConfig, resolveAgent } from '../core/registry.ts'
import {
  buildReport,
  dispatch,
  DepthLimitError,
  executeRun,
  reconcileRun,
  type DispatchOptions,
} from '../core/runner.ts'
import { defaultTargets, filterTargets, runRemove, runSetup, type SetupTargets } from '../core/setup.ts'
import { computeStats } from '../core/stats.ts'
import { getRun, listRuns } from '../core/store.ts'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Print a JSON value on stdout (the single machine-readable line). */
function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** Route every clack prompt to stderr so stdout stays the single JSON value. */
const CLACK_OUT = { output: process.stderr } as const

/** Print a `{status:"failed", error}` object and set the exit code. */
function fail(message: string, code = 1): void {
  logEvent('cli.error', { message, exitCode: code })
  emit({ status: 'failed', error: message })
  process.exitCode = code
}

/**
 * Narrow a harness-name arg. On an unknown name, emit the standard failure
 * (setting the exit code) and return undefined — the caller should then
 * `return`. `noun` names the offending arg in the message ("harness"/"caller").
 */
function parseHarnessArg(value: string, noun: string): HarnessName | undefined {
  if (HARNESS_NAMES.includes(value as HarnessName)) return value as HarnessName
  fail(`Unknown ${noun} "${value}" (expected one of: ${HARNESS_NAMES.join(', ')}).`)
  return undefined
}

/** Load config, reporting a friendly error if it's missing/invalid. */
function tryLoadConfig(): DianjiangConfig | undefined {
  try {
    return loadConfig()
  } catch (err) {
    fail(errorMessage(err), 1)
    return undefined
  }
}

/** Run a dispatch, print its report, and translate errors to exit codes. */
async function runDispatch(opts: DispatchOptions, config: DianjiangConfig): Promise<void> {
  try {
    const report = await dispatch(opts, config)
    emit(report)
    if (report.status === 'failed') process.exitCode = 1
  } catch (err) {
    if (err instanceof DepthLimitError) {
      fail(err.message, 2)
    } else {
      fail(errorMessage(err), 1)
    }
  }
}

const run = defineCommand({
  meta: { name: 'run', description: 'Dispatch a task to an agent (or a raw harness).' },
  args: {
    agent: { type: 'positional', required: false, description: 'Agent name (or the task itself in --harness mode)' },
    task: { type: 'positional', required: false, description: 'Task text' },
    harness: { type: 'string', description: 'Raw escape hatch: dispatch directly to a harness, bypassing the registry' },
    model: { type: 'string', alias: 'm', description: 'Override model (raw mode / advanced)' },
    effort: { type: 'string', description: 'Override effort (raw mode / advanced)' },
    detach: { type: 'boolean', default: false, description: 'Return immediately; run in the background' },
    cwd: { type: 'string', default: process.cwd(), description: 'Working directory for the harness' },
    caller: {
      type: 'string',
      description: 'Which harness is calling (stamped by setup); resolves per-caller agent bindings',
    },
  },
  async run({ args }) {
    const config = tryLoadConfig()
    if (!config) return
    const cwd = resolve(args.cwd)

    // Validate --caller when provided; raw --harness mode ignores it.
    let caller: HarnessName | undefined
    if (args.caller) {
      caller = parseHarnessArg(args.caller, 'caller')
      if (!caller) return
    }

    if (args.harness) {
      // Raw mode: the sole positional is the task; validate the harness name.
      const harness = parseHarnessArg(args.harness, 'harness')
      if (!harness) return
      const task = args.agent ?? args.task
      if (!task) return fail('Missing task. Usage: dianjiang run --harness <name> "<task>".')
      await runDispatch(
        {
          harness,
          model: args.model,
          effort: args.effort,
          task,
          cwd,
          detach: args.detach,
        },
        config,
      )
      return
    }

    // Agent mode: <agent> <task> resolved through the registry.
    if (!args.agent || !args.task) {
      return fail('Usage: dianjiang run <agent> "<task>"  (or: run --harness <name> "<task>").')
    }
    let agent
    try {
      agent = resolveAgent(config, args.agent, caller)
    } catch (err) {
      return fail(errorMessage(err))
    }
    await runDispatch(
      {
        agent,
        harness: agent.harness,
        // Flags override the agent preset when given.
        model: args.model ?? agent.model,
        effort: args.effort ?? agent.effort,
        task: args.task,
        cwd,
        detach: args.detach,
      },
      config,
    )
  },
})

const resume = defineCommand({
  meta: { name: 'resume', description: 'Follow up on an existing run in the same harness session.' },
  args: {
    runId: { type: 'positional', required: true, description: 'The run to follow up on' },
    task: { type: 'positional', required: true, description: 'Follow-up message' },
    detach: { type: 'boolean', default: false, description: 'Return immediately; run in the background' },
  },
  async run({ args }) {
    const original = getRun(args.runId)
    if (!original) return fail(`Run ${args.runId} not found.`)
    // Without a harness session id, dispatching would silently start a FRESH
    // session while the caller believes it is following up — fail instead.
    if (!original.harnessSessionId) {
      return fail(
        `Run ${args.runId} has no harness session to resume (status: ${original.status}). Only completed runs can be resumed.`,
      )
    }
    const config = tryLoadConfig()
    if (!config) return

    // Reuse the original agent's config (for instructions) if still present.
    let agent
    if (original.agent) {
      agent = config.agents.find((a) => a.name === original.agent)
    }

    await runDispatch(
      {
        agent,
        harness: original.harness,
        model: original.model,
        effort: original.effort,
        task: args.task,
        cwd: original.cwd,
        detach: args.detach,
        parentRunId: original.runId,
      },
      config,
    )
  },
})

/** `status` and `result` are the same command: report a run by id. */
function reportCommand(name: string, description: string) {
  return defineCommand({
    meta: { name, description },
    args: { runId: { type: 'positional', required: true, description: 'Run id' } },
    run({ args }) {
      const record = getRun(args.runId)
      if (!record) return fail(`Run ${args.runId} not found.`)
      emit(buildReport(reconcileRun(record)))
    },
  })
}

const status = reportCommand('status', 'Print the current state of a run.')
const result = reportCommand('result', 'Fetch the final result of a run (same shape as status).')

const setup = defineCommand({
  meta: {
    name: 'setup',
    description: 'Inject (or remove, with --remove) the delegation roster in the global instruction files.',
  },
  args: {
    all: { type: 'boolean', default: false, description: 'Target every installed harness without prompting' },
    harness: {
      type: 'string',
      description: 'Comma-separated subset of harnesses to target (e.g. claude,codex)',
    },
    remove: { type: 'boolean', default: false, description: 'Remove the managed block instead of injecting it' },
  },
  async run({ args }) {
    const installed = harnessVersions().filter((v) => v.installed)
    const installedNames = installed.map((v) => v.name)

    let selected: HarnessName[]
    if (args.harness) {
      // Explicit subset: every name must be a known harness AND installed.
      const names = args.harness
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      for (const n of names) {
        const harness = parseHarnessArg(n, 'harness')
        if (!harness) return
        if (!installedNames.includes(harness)) {
          return fail(`Harness "${n}" is not installed.`)
        }
      }
      selected = names as HarnessName[]
    } else if (args.all || !process.stdin.isTTY) {
      // --all, or a non-interactive stdin (piped/CI): every installed harness,
      // no prompt — keeps the one-JSON machine-readable contract.
      selected = installedNames
    } else {
      // Interactive TTY: multiselect over installed harnesses (all pre-checked,
      // version shown as a hint). clack writes its UI to stdout by default, so
      // we redirect it to stderr to keep stdout a single JSON value.
      if (installedNames.length === 0) return fail('No installed harnesses to set up.')
      const picked = await multiselect<HarnessName>({
        message: args.remove ? 'Remove the roster from which harnesses?' : 'Inject the roster into which harnesses?',
        options: installed.map((v) => ({ value: v.name, label: v.name, hint: v.version ?? undefined })),
        initialValues: installedNames,
        required: false,
        ...CLACK_OUT,
      })
      if (isCancel(picked)) return fail('Setup cancelled.')
      selected = picked
    }

    const targets: Partial<SetupTargets> = filterTargets(selected, defaultTargets())
    let results
    if (args.remove) {
      results = runRemove(targets)
    } else {
      const config = tryLoadConfig()
      if (!config) return
      results = runSetup(config, targets)
    }
    for (const r of results) process.stderr.write(`${r.action}: ${r.file}\n`)
    emit(results)
  },
})

const configInit = defineCommand({
  meta: { name: 'init', description: 'Write a starter config.jsonc.' },
  args: { force: { type: 'boolean', default: false, description: 'Overwrite an existing config' } },
  run({ args }) {
    const path = configPath()
    const existed = existsSync(path)
    if (existed && !args.force) {
      return fail(`Config already exists at ${path}. Use --force to overwrite.`)
    }
    writeFileSync(path, defaultConfigJsonc())
    process.stderr.write(`Wrote config to ${path}\n`)
    emit({ file: path, action: existed ? 'updated' : 'written' })
  },
})

/** One accepted mutation, summarized for the editor's final JSON. */
interface EditChange {
  op: 'set' | 'add' | 'delete'
  agent: string
  /** For `set`: which field changed (`binding` for a harness/model/effort edit). */
  field?: string
}

/** A resolved harness/model/effort binding gathered from the binding prompts. */
interface BindingChoice {
  harness: HarnessName
  model?: string
  effort?: string
}

/** Thrown when the user cancels any prompt; unwinds to the editor's top loop. */
class EditorCancelled extends Error {}

/** Reject clack's cancel symbol as a control-flow exception; else the value. */
function unwrap<T>(value: T | symbol): T {
  if (isCancel(value)) throw new EditorCancelled()
  return value as T
}

/** `name (harness/model/effort)` line shown when picking an agent. */
function bindingLabel(agent: AgentConfig): string {
  return `${agent.harness}/${agent.model ?? 'default'}/${agent.effort ?? 'none'}`
}

/**
 * Open `$EDITOR` (fallback `vi`) on a temp file seeded with `initial`, then
 * return the trimmed contents. Blocks on the child's terminal (stdio inherit).
 */
function editInEditor(initial: string): string {
  const file = join(tmpdir(), `dianjiang-edit-${Date.now()}-${Math.random().toString(36).slice(2)}.md`)
  writeFileSync(file, initial)
  // $EDITOR may carry args (e.g. "code -w"); split it into an argv.
  const editor = (process.env.EDITOR ?? 'vi').trim() || 'vi'
  try {
    Bun.spawnSync({ cmd: [...editor.split(/\s+/), file], stdio: ['inherit', 'inherit', 'inherit'] })
    return readFileSync(file, 'utf8').trim()
  } finally {
    try {
      unlinkSync(file)
    } catch {
      // Best-effort cleanup; a leftover temp file is harmless.
    }
  }
}

/** Prompt for harness -> model -> effort. `current` seeds initial values. */
async function promptBinding(current?: AgentConfig): Promise<BindingChoice> {
  const harness = unwrap(
    await select({
      message: 'Harness',
      options: HARNESS_NAMES.map((h) => ({ value: h, label: h })),
      initialValue: current?.harness,
      ...CLACK_OUT,
    }),
  ) as HarnessName

  const modelInput = unwrap(
    await textPrompt({
      message: 'Model (leave empty for the harness default)',
      // Preserve the current model only when the harness is unchanged.
      initialValue: current?.harness === harness ? (current.model ?? '') : '',
      ...CLACK_OUT,
    }),
  )
  const model = modelInput.trim() ? modelInput.trim() : undefined

  const efforts = adapters[harness].efforts
  let effort: string | undefined
  if (efforts.length > 0) {
    // Sentinel for "no effort"; parenthesized so it can never collide with a
    // real effort value (adapters only accept bare words like "high").
    const NONE = '(none)'
    const choice = unwrap(
      await select({
        message: 'Effort',
        options: [...efforts.map((e) => ({ value: e, label: e })), { value: NONE, label: '(none)' }],
        initialValue: current?.effort && efforts.includes(current.effort) ? current.effort : NONE,
        ...CLACK_OUT,
      }),
    )
    effort = choice === NONE ? undefined : choice
  }
  return { harness, model, effort }
}

/** Persist a pure mutation applied to the freshest on-disk config text. */
function applyEdit(mutate: (text: string) => string): void {
  writeConfigText(mutate(readConfigText()))
}

/**
 * Persist one accepted editor mutation and record it. On failure (writeConfigText's
 * validate-before-write gate rejected the result), report to stderr with
 * `failLabel` and keep the session alive — the on-disk config is left untouched.
 */
function applyChange(
  changes: EditChange[],
  mutate: (text: string) => string,
  change: EditChange,
  failLabel: string,
): void {
  try {
    applyEdit(mutate)
    changes.push(change)
  } catch (err) {
    process.stderr.write(`${failLabel}: ${errorMessage(err)}\n`)
  }
}

/** Edit one prose field via $EDITOR; empty removes it (except required useWhen). */
function editProse(
  agent: AgentConfig,
  index: number,
  field: 'useWhen' | 'dontUseWhen' | 'instructions',
  changes: EditChange[],
): void {
  const edited = editInEditor(agent[field] ?? '')
  if (edited === '') {
    if (field === 'useWhen') {
      process.stderr.write('useWhen is required and cannot be empty; no change made.\n')
      return
    }
    applyEdit((t) => setAgentField(t, index, field, undefined))
  } else {
    applyEdit((t) => setAgentField(t, index, field, edited))
  }
  changes.push({ op: 'set', agent: agent.name, field })
}

/** Action menu for a single agent (edit binding / prose / delete). */
async function editAgent(agent: AgentConfig, index: number, changes: EditChange[]): Promise<void> {
  const action = unwrap(
    await select({
      message: `Agent "${agent.name}"`,
      options: [
        { value: 'binding', label: 'edit binding (harness/model/effort)' },
        { value: 'useWhen', label: 'edit useWhen' },
        { value: 'dontUseWhen', label: 'edit dontUseWhen' },
        { value: 'instructions', label: 'edit instructions' },
        { value: 'delete', label: 'delete' },
        { value: 'back', label: 'back' },
      ],
      ...CLACK_OUT,
    }),
  )

  switch (action) {
    case 'back':
      return
    case 'binding': {
      const binding = await promptBinding(agent)
      // Apply all three fields, then validate once: an intermediate state
      // (e.g. new harness before clearing an unsupported effort) may be
      // invalid, so writeConfigText is the single gate.
      applyChange(
        changes,
        (t) => {
          let next = setAgentField(t, index, 'harness', binding.harness)
          next = setAgentField(next, index, 'model', binding.model)
          next = setAgentField(next, index, 'effort', binding.effort)
          return next
        },
        { op: 'set', agent: agent.name, field: 'binding' },
        'Not applied',
      )
      return
    }
    case 'delete': {
      const ok = unwrap(await confirm({ message: `Delete agent "${agent.name}"?`, initialValue: false, ...CLACK_OUT }))
      if (!ok) return
      applyChange(changes, (t) => removeAgent(t, index), { op: 'delete', agent: agent.name }, 'Not deleted')
      return
    }
    default:
      editProse(agent, index, action as 'useWhen' | 'dontUseWhen' | 'instructions', changes)
  }
}

/** Add a new agent: name -> useWhen ($EDITOR) -> binding. */
async function addAgent(config: DianjiangConfig, changes: EditChange[]): Promise<void> {
  const existing = new Set(config.agents.map((a) => a.name))
  const name = unwrap(
    await textPrompt({
      message: 'New agent name',
      validate(value) {
        const trimmed = (value ?? '').trim()
        if (!trimmed) return 'Name is required.'
        if (existing.has(trimmed)) return `An agent named "${trimmed}" already exists.`
        return undefined
      },
      ...CLACK_OUT,
    }),
  ).trim()

  const useWhen = editInEditor('')
  if (!useWhen) {
    process.stderr.write('useWhen is required; agent not added.\n')
    return
  }

  const binding = await promptBinding()
  const agent: AgentConfig = { name, useWhen, harness: binding.harness }
  if (binding.model !== undefined) agent.model = binding.model
  if (binding.effort !== undefined) agent.effort = binding.effort

  applyChange(changes, (t) => appendAgent(t, agent), { op: 'add', agent: name }, 'Not added')
}

/**
 * Interactive agent editor. Reloads config each loop so accepted edits (written
 * immediately, so a later cancel keeps earlier work) show up live. Returns a
 * summary of what changed for the single stdout JSON.
 */
async function runAgentEditor(): Promise<{ file: string; changes: EditChange[] }> {
  const changes: EditChange[] = []
  try {
    for (;;) {
      const config = loadConfig()
      const pick = unwrap(
        await select({
          message: 'Edit which agent?',
          options: [
            ...config.agents.map((a, i) => ({ value: String(i), label: `${a.name} (${bindingLabel(a)})` })),
            { value: 'add', label: '+ add agent' },
            { value: 'done', label: 'done' },
          ],
          ...CLACK_OUT,
        }),
      )
      if (pick === 'done') break
      if (pick === 'add') {
        await addAgent(config, changes)
        continue
      }
      const index = Number(pick)
      const agent = config.agents[index]
      if (agent) await editAgent(agent, index, changes)
    }
  } catch (err) {
    // A cancel at any prompt ends the session gracefully, preserving the edits
    // already written to disk; anything else is a real error.
    if (!(err instanceof EditorCancelled)) throw err
  }
  return { file: configPath(), changes }
}

const configAgents = defineCommand({
  meta: { name: 'agents', description: 'Print the configured agents as JSON (or edit them with --edit).' },
  args: {
    caller: {
      type: 'string',
      description: 'Emit the roster resolved for this caller (per-caller bindings applied)',
    },
    edit: { type: 'boolean', default: false, description: 'Open the interactive agent editor (needs a TTY)' },
  },
  async run({ args }) {
    if (args.edit) {
      if (!process.stdin.isTTY) {
        return fail('The interactive agent editor needs a TTY.')
      }
      // Ensure the config exists and is valid before entering the editor.
      const config = tryLoadConfig()
      if (!config) return
      try {
        emit(await runAgentEditor())
      } catch (err) {
        return fail(errorMessage(err))
      }
      return
    }
    const config = tryLoadConfig()
    if (!config) return
    if (!args.caller) {
      emit(config.agents)
      return
    }
    const caller = parseHarnessArg(args.caller, 'caller')
    if (!caller) return
    // Emit each agent with its binding resolved for the given caller, so
    // per-caller overrides are inspectable.
    emit(config.agents.map((a) => resolveAgent(config, a.name, caller)))
  },
})

const configHarnesses = defineCommand({
  meta: { name: 'harnesses', description: 'Self-check: which harness CLIs are installed and their versions.' },
  args: { json: { type: 'boolean', default: false, description: 'JSON output (default is already JSON)' } },
  run() {
    emit(harnessVersions())
  },
})

const configCmd = defineCommand({
  meta: { name: 'config', description: 'Manage config and inspect harnesses.' },
  subCommands: { init: configInit, agents: configAgents, harnesses: configHarnesses },
})

const stats = defineCommand({
  meta: {
    name: 'stats',
    description: 'Aggregate run usage per agent (runs, success, duration, tokens, turns, cost).',
  },
  args: {
    agent: { type: 'string', description: 'Restrict the report to a single agent' },
  },
  run({ args }) {
    // Token/cost fields are harness-reported sums, null when unreported; only
    // claude reports a cost, so costUsd is null for codex/grok groups.
    emit(computeStats(listRuns(), args.agent))
  },
})

// Internal worker entry used by detached dispatch (the `_` prefix marks it as
// non-public; citty's CommandMeta has no `hidden` flag). Output goes to a log.
const exec = defineCommand({
  meta: { name: '_exec', description: 'Internal: run a detached worker.', hidden: true },
  args: { runId: { type: 'positional', required: true } },
  async run({ args }) {
    await executeRun(args.runId)
  },
})

const main = defineCommand({
  meta: { name: 'dianjiang', description: '点将 — summon the right coding-agent CLI for a task.' },
  subCommands: {
    run,
    resume,
    status,
    result,
    setup,
    stats,
    config: configCmd,
    _exec: exec,
  },
})

void runMain(main)
