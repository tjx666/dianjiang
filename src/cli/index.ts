#!/usr/bin/env bun
/**
 * dianjiang CLI — a thin frontend over the core library. Every command that
 * produces machine output prints exactly one JSON object/array on stdout; human
 * chatter goes to stderr. Exit codes: 0 ok, 1 error/failed run, 2 depth limit.
 */

import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineCommand, runMain } from 'citty'
import type { DianjiangConfig, HarnessName } from '../core/types.ts'
import { HARNESS_NAMES } from '../core/types.ts'
import { harnessVersions } from '../core/adapters/index.ts'
import { configPath } from '../core/paths.ts'
import { defaultConfigJsonc, findAgent, loadConfig } from '../core/registry.ts'
import {
  buildReport,
  dispatch,
  DepthLimitError,
  executeRun,
  reconcileRun,
  type DispatchOptions,
} from '../core/runner.ts'
import { runSetup } from '../core/setup.ts'
import { getRun } from '../core/store.ts'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Print a JSON value on stdout (the single machine-readable line). */
function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** Print a `{status:"failed", error}` object and set the exit code. */
function fail(message: string, code = 1): void {
  emit({ status: 'failed', error: message })
  process.exitCode = code
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
  },
  async run({ args }) {
    const config = tryLoadConfig()
    if (!config) return
    const cwd = resolve(args.cwd)

    if (args.harness) {
      // Raw mode: the sole positional is the task; validate the harness name.
      const harness = args.harness as HarnessName
      if (!HARNESS_NAMES.includes(harness)) {
        return fail(`Unknown harness "${args.harness}" (expected one of: ${HARNESS_NAMES.join(', ')}).`)
      }
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
      agent = findAgent(config, args.agent)
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
  meta: { name: 'setup', description: 'Inject the delegation roster into the global instruction files.' },
  run() {
    const config = tryLoadConfig()
    if (!config) return
    const results = runSetup(config)
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
  meta: { name: 'agents', description: 'Print the configured agents as JSON.' },
  run() {
    const config = tryLoadConfig()
    if (!config) return
    emit(config.agents)
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
  meta: { name: '_exec', description: 'Internal: run a detached worker.' },
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
