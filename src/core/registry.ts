/**
 * Config loading + validation. The config file is the human's "compiled"
 * scorecard: it maps named agents to a harness/model/effort. Validation keeps
 * the runtime honest since JSONC parses to `any`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser'
import type { AgentBinding, AgentConfig, DianjiangConfig, HarnessName } from './types.ts'
import { HARNESS_NAMES } from './types.ts'
import { adapters } from './adapters/index.ts'
import { configPath } from './paths.ts'

/**
 * Validate a harness/model/effort binding. Model-aware: when the binding's
 * model matches a curated `knownModels` entry, the effort must be in THAT
 * model's effort set (a model with an empty set — e.g. grok-composer-2.5-fast —
 * rejects any effort). For an unknown model (or no model), fall back to the
 * permissive harness-level whitelist so new models ship without a hard reject.
 * Reusable for base agents and per-caller overrides; `label` names the
 * offending entry in error messages.
 */
function validateBinding(binding: AgentBinding, label: string): void {
  if (binding.effort === undefined) return
  const adapter = adapters[binding.harness]
  const known = binding.model === undefined ? undefined : adapter.knownModels.find((m) => m.name === binding.model)
  if (known) {
    if (known.efforts.length === 0) {
      throw new Error(`Invalid config: ${label} sets an effort, but model "${known.name}" does not support effort.`)
    }
    if (!known.efforts.includes(binding.effort)) {
      throw new Error(
        `Invalid config: ${label} has invalid effort "${binding.effort}" for model "${known.name}" (expected one of: ${known.efforts.join(', ')}).`,
      )
    }
    return
  }
  const allowed = adapter.efforts
  if (!allowed.includes(binding.effort)) {
    throw new Error(
      `Invalid config: ${label} has invalid effort "${binding.effort}" for harness "${binding.harness}" (expected one of: ${allowed.join(', ')}).`,
    )
  }
}

/** Validate one agent's effort against its harness (and model exceptions). */
function validateEffort(agent: AgentConfig): void {
  validateBinding(agent, `agent "${agent.name}"`)
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
  validateCallers(config, seen)
}

/** Throw `message` unless `value` is a non-null object. */
function assertObject(value: unknown, message: string): void {
  if (value === null || typeof value !== 'object') throw new Error(message)
}

/** Validate the optional `callers` namespace against the base roster. */
function validateCallers(config: DianjiangConfig, agentNames: Set<string>): void {
  if (config.callers === undefined) return
  assertObject(config.callers, 'Invalid config: "callers" must be an object keyed by harness name.')
  for (const [caller, callerConfig] of Object.entries(config.callers)) {
    if (!HARNESS_NAMES.includes(caller as HarnessName)) {
      throw new Error(
        `Invalid config: callers.${caller} is not a known harness (expected one of: ${HARNESS_NAMES.join(', ')}).`,
      )
    }
    if (callerConfig === undefined) continue
    assertObject(callerConfig, `Invalid config: callers.${caller} must be an object.`)
    const overrides = callerConfig.agents ?? {}
    if (callerConfig.agents !== undefined) {
      assertObject(
        callerConfig.agents,
        `Invalid config: callers.${caller}.agents must be an object keyed by agent name.`,
      )
      for (const [name, binding] of Object.entries(callerConfig.agents)) {
        const label = `callers.${caller}.agents.${name}`
        if (!agentNames.has(name)) {
          throw new Error(`Invalid config: ${label} overrides an unknown agent (not in the base roster).`)
        }
        assertObject(binding, `Invalid config: ${label} must be a binding object with a "harness".`)
        if (!HARNESS_NAMES.includes(binding.harness)) {
          throw new Error(
            `Invalid config: ${label} has unknown harness "${String(binding.harness)}" (expected one of: ${HARNESS_NAMES.join(', ')}).`,
          )
        }
        for (const field of ['useWhen', 'dontUseWhen'] as const) {
          const value = binding[field]
          if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
            throw new Error(`Invalid config: ${label}.${field} must be a non-empty string.`)
          }
        }
        validateBinding(binding, label)
      }
    }
    for (const field of ['prepend', 'append'] as const) {
      const value = callerConfig[field]
      if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
        throw new Error(`Invalid config: callers.${caller}.${field} must be a non-empty string.`)
      }
    }
    if (callerConfig.exclude !== undefined) {
      if (!Array.isArray(callerConfig.exclude) || callerConfig.exclude.some((n) => typeof n !== 'string')) {
        throw new Error(`Invalid config: callers.${caller}.exclude must be an array of agent names.`)
      }
      for (const name of callerConfig.exclude) {
        if (!agentNames.has(name)) {
          throw new Error(`Invalid config: callers.${caller}.exclude references unknown agent "${name}".`)
        }
        if (name in overrides) {
          throw new Error(`Invalid config: callers.${caller} excludes "${name}" but also overrides it in "agents".`)
        }
      }
    }
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

/**
 * Resolve an agent for a given caller. Looks up the base agent by name, then —
 * if `caller` has an override for that name — returns the base agent with its
 * harness/model/effort REPLACED by the override. The override's undefined
 * model/effort mean "harness default", not the base agent's values. `useWhen`/
 * `dontUseWhen` may be overridden per caller (caller-relative descriptions),
 * each falling back to the base agent when omitted; `name`/`instructions`
 * always stay single-source from the base.
 */
export function resolveAgent(config: DianjiangConfig, name: string, caller?: HarnessName): AgentConfig {
  const agent = findAgent(config, name)
  const callerConfig = caller ? config.callers?.[caller] : undefined
  if (callerConfig?.exclude?.includes(name)) {
    throw new Error(`Agent "${name}" is not available to caller "${caller}" (excluded in config).`)
  }
  const override = callerConfig?.agents?.[name]
  if (!override) return agent
  return {
    ...agent,
    harness: override.harness,
    model: override.model,
    effort: override.effort,
    useWhen: override.useWhen ?? agent.useWhen,
    dontUseWhen: override.dontUseWhen ?? agent.dontUseWhen,
  }
}

/** The commented JSONC template written by `dianjiang config init` (roster v1). */
export function defaultConfigJsonc(): string {
  return `{
  // Recursion guard: dianjiang refuses to dispatch when DIANJIANG_DEPTH >= maxDepth.
  "maxDepth": 2,

  // The roster. The delegating AI picks an agent by task shape — never a model.
  // Names are verb/deliverable-style; keep the roster small (v1: 5, hard cap ~8).
  "agents": [
    {
      "name": "review",
      // Base is codex; the callers section rebinds it to a different vendor for
      // the codex caller so review is never same-model as the code under review.
      "useWhen": "you want an independent cross-vendor code review of a diff; runs gpt-5.6-sol at xhigh — stronger reasoning than opus, slightly below fable",
      "dontUseWhen": "a quick lint/style pass your own subagents already cover",
      "harness": "codex",
      "model": "gpt-5.6-sol",
      "effort": "xhigh"
    },
    {
      "name": "second-opinion",
      // Consult-only; base is claude/fable, rebound to a different vendor for the
      // claude caller so consulting never lands on the caller's own model.
      "useWhen": "consult-only: a hard debugging hypothesis or an architecture/design decision where you're stuck or the call is expensive to reverse; runs fable — Anthropic's strongest reasoning model",
      "dontUseWhen": "the task requires editing code (this agent must not make changes)",
      "harness": "claude",
      "model": "fable",
      "effort": "high"
    },
    {
      "name": "search-twitter",
      // grok has native live X search tools; verified working headless.
      "useWhen": "live X/Twitter lookups: find tweets, threads, account activity, or what people say about a topic right now — grok's native X search is real-time and extremely fast",
      "dontUseWhen": "general web research (use your own web/search tools) or anything needing code changes",
      "harness": "grok",
      "model": "grok-4.5",
      "effort": "high",
      "instructions": "Use your live X/Twitter search tools. Cite the tweet URL for every claim."
    },
    {
      "name": "design-frontend",
      "useWhen": "UI/UX work needing visual taste: components, layouts, styling, interaction polish, or design review of front-end code",
      "dontUseWhen": "backend logic or refactors with no visual/UX judgment involved",
      "harness": "claude",
      "model": "fable",
      "effort": "high"
    },
    {
      "name": "rewrite-prompt",
      // 1M-context opus: can ingest a huge corpus before rewriting.
      "useWhen": "rewriting, compressing, or restructuring prompts and agent instructions, especially when a large corpus must be read first; runs opus 4.6 with 1M context — better prose style (文风) than later opus generations",
      "dontUseWhen": "ordinary coding tasks",
      "harness": "claude",
      "model": "claude-opus-4-6[1m]",
      "instructions": "Output only the rewritten prompt unless asked otherwise."
    }
  ],

  // Per-caller adjustments. The built-in bindings follow these rules:
  //   review, second-opinion — always a different vendor than the caller (avoid same-model blind spots)
  //   implementation         — not a dianjiang agent at all: callers build with their own subagents (see claude's \`prepend\`)
  // Base bindings are just the compiled view for the most common callers; \`exclude\`
  // hides an agent from a caller entirely. \`setup\` stamps \`--caller <harness>\`
  // into each vendor's instruction file so these resolve without env sniffing.
  "callers": {
    "claude": {
      "agents": {
        "second-opinion": {
          "harness": "codex",
          "model": "gpt-5.6-sol",
          "effort": "xhigh",
          "useWhen": "consult-only: a hard debugging hypothesis or an architecture/design decision where you're stuck or the call is expensive to reverse; runs gpt-5.6-sol at xhigh — stronger reasoning than opus, slightly below fable"
        }
      },
      // design-frontend is claude/fable itself — the claude caller gains nothing over its own subagents.
      "exclude": ["design-frontend"],
      // Caller-behavior guidance rendered at the top of this caller's injected block.
      "prepend": "If your session model is fable, act as an orchestrator to preserve fable tokens: delegate execution work (implementation, mechanical edits, running tests/builds) to your built-in subagents with \`model: opus\`, keeping only planning, task decomposition, tricky debugging, and verification of subagent output for yourself. Delegate coherent, independently verifiable chunks (a new file, a test suite, a bulk edit); keep small in-context edits yourself — the cost of writing the brief must not exceed the task. For cross-vendor perspectives or capabilities your subagents lack, use the dianjiang roster below."
    },
    "codex": {
      "agents": {
        "review": {
          "harness": "claude",
          "model": "opus",
          "effort": "xhigh",
          "useWhen": "you want an independent cross-vendor code review of a diff; runs claude opus at xhigh"
        }
      }
    }
  }
}
`
}
