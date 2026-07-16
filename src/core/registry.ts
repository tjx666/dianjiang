/**
 * Config loading + validation. The config file is the human's "compiled"
 * scorecard: it maps named agents to a harness/model/effort. Validation keeps
 * the runtime honest since JSONC parses to `any`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser'
import type { AgentConfig, DianjiangConfig } from './types.ts'
import { HARNESS_NAMES } from './types.ts'
import { adapters } from './adapters/index.ts'
import { configPath } from './paths.ts'

/** grok's fast composer model has no reasoning-effort flag at all. */
const GROK_NO_EFFORT_MODEL = 'grok-composer-2.5-fast'

/** Validate one agent's effort against its harness (and model exceptions). */
function validateEffort(agent: AgentConfig): void {
  if (agent.effort === undefined) return
  if (agent.harness === 'grok' && agent.model === GROK_NO_EFFORT_MODEL) {
    throw new Error(
      `Invalid config: agent "${agent.name}" sets an effort, but model "${GROK_NO_EFFORT_MODEL}" does not support effort.`,
    )
  }
  const allowed = adapters[agent.harness].efforts
  if (!allowed.includes(agent.effort)) {
    throw new Error(
      `Invalid config: agent "${agent.name}" has invalid effort "${agent.effort}" for harness "${agent.harness}" (expected one of: ${allowed.join(', ')}).`,
    )
  }
}

/** Throw a descriptive Error if the config is structurally invalid. */
export function validateConfig(config: DianjiangConfig): void {
  if (config === null || typeof config !== 'object') {
    throw new Error('Invalid config: expected a JSON object.')
  }
  if (typeof config.maxDepth !== 'number' || !Number.isFinite(config.maxDepth) || config.maxDepth < 1) {
    throw new Error(`Invalid config: "maxDepth" must be a positive number (got ${String(config.maxDepth)}).`)
  }
  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    throw new Error('Invalid config: "agents" must be a non-empty array.')
  }
  const seen = new Set<string>()
  for (const agent of config.agents) {
    if (!agent || typeof agent.name !== 'string' || agent.name.length === 0) {
      throw new Error('Invalid config: every agent needs a non-empty "name".')
    }
    if (seen.has(agent.name)) {
      throw new Error(`Invalid config: duplicate agent name "${agent.name}".`)
    }
    seen.add(agent.name)
    if (typeof agent.useWhen !== 'string' || agent.useWhen.length === 0) {
      throw new Error(`Invalid config: agent "${agent.name}" needs a non-empty "useWhen".`)
    }
    if (!HARNESS_NAMES.includes(agent.harness)) {
      throw new Error(
        `Invalid config: agent "${agent.name}" has unknown harness "${String(agent.harness)}" (expected one of: ${HARNESS_NAMES.join(', ')}).`,
      )
    }
    validateEffort(agent)
  }
}

/** Parse JSONC text into a validated config. */
export function parseConfig(text: string, source = '<config>'): DianjiangConfig {
  const errors: ParseError[] = []
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true }) as DianjiangConfig
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `${printParseErrorCode(e.error)}@${e.offset}`)
      .join(', ')
    throw new Error(`Failed to parse ${source}: ${detail}`)
  }
  validateConfig(parsed)
  return parsed
}

/** Load + validate the config file. */
export function loadConfig(path = configPath()): DianjiangConfig {
  if (!existsSync(path)) {
    throw new Error(`Config not found at ${path}. Run \`dianjiang config init\` to create it.`)
  }
  return parseConfig(readFileSync(path, 'utf8'), path)
}

/** Look up an agent by name; throw with the available names on a miss. */
export function findAgent(config: DianjiangConfig, name: string): AgentConfig {
  const agent = config.agents.find((a) => a.name === name)
  if (!agent) {
    const names = config.agents.map((a) => a.name).join(', ')
    throw new Error(`Unknown agent "${name}". Available agents: ${names}.`)
  }
  return agent
}

/** The commented JSONC template written by `dianjiang config init` (roster v1). */
export function defaultConfigJsonc(): string {
  return `{
  // Recursion guard: dianjiang refuses to dispatch when DIANJIANG_DEPTH >= maxDepth.
  "maxDepth": 2,

  // The roster. The delegating AI picks an agent by task shape — never a model.
  // Names are verb/deliverable-style; keep the roster small (v1: 4, hard cap ~8).
  "agents": [
    {
      "name": "implement",
      // When the delegating AI SHOULD pick this agent.
      "useWhen": "a well-scoped feature or module can be built independently of the caller's conversation context",
      // When it should NOT.
      "dontUseWhen": "the task needs the caller's live conversation context or ongoing back-and-forth",
      "harness": "codex",
      "model": "gpt-5.6-sol",
      "effort": "high"
    },
    {
      "name": "review",
      // Vendor differs from both the implementer (codex) and the typical caller
      // (claude) — avoids same-model blind spots.
      "useWhen": "you want a second opinion on a diff from a different vendor than the implementer and caller",
      "dontUseWhen": "a quick lint/style pass your own subagents already cover",
      "harness": "grok",
      "model": "grok-4.5",
      "effort": "high"
    },
    {
      "name": "second-opinion",
      // Consult-only, maximum firepower ("ultra" exists only on gpt-5.6-sol/terra).
      "useWhen": "consult-only: hard debugging hypotheses or architecture/design review needing maximum firepower",
      "dontUseWhen": "the task requires editing code (this agent must not make changes)",
      "harness": "codex",
      "model": "gpt-5.6-sol",
      "effort": "ultra"
    },
    {
      "name": "explore",
      "useWhen": "broad codebase search, research, or summarization where cheap and fast matters",
      "dontUseWhen": "the task needs deep reasoning or code changes",
      "harness": "grok",
      // grok-composer-2.5-fast has no reasoning-effort flag, so omit "effort".
      "model": "grok-composer-2.5-fast"
    }
  ]
}
`
}
