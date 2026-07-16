#!/usr/bin/env bun
/**
 * dianjiang CLI — a thin frontend over the core library. Every command that
 * produces machine output prints exactly one JSON object/array on stdout; human
 * chatter goes to stderr. Exit codes: 0 ok, 1 error/failed run, 2 depth limit.
 */

import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isCancel, multiselect } from '@clack/prompts'
import { defineCommand, runMain } from 'citty'
import type { DianjiangConfig, HarnessName } from '../core/types.ts'
import { HARNESS_NAMES } from '../core/types.ts'
import { harnessVersions } from '../core/adapters/index.ts'
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
import { getRun } from '../core/store.ts'

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

const configAgents = defineCommand({
  meta: { name: 'agents', description: 'Print the configured agents as JSON (or edit them with --edit).' },
  args: {
    caller: {
      type: 'string',
      description: 'Emit the roster resolved for this caller (per-caller bindings applied)',
    },
  },
  async run({ args }) {
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
    config: configCmd,
    _exec: exec,
  },
})

void runMain(main)
