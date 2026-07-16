import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendAgent,
  readConfigText,
  removeAgent,
  setAgentField,
  writeConfigText,
} from '../src/core/config-edit.ts'
import { configPath } from '../src/core/paths.ts'
import { parseConfig } from '../src/core/registry.ts'
import type { AgentConfig } from '../src/core/types.ts'

/**
 * A comment-rich fixture in the flavor of `defaultConfigJsonc`: leading
 * comment, per-field comments, and a `callers` override section. The tests
 * assert these survive edits byte-for-byte outside the mutated range.
 */
const FIXTURE = `{
  // Recursion guard.
  "maxDepth": 2,

  // The roster.
  "agents": [
    {
      "name": "implement",
      // When to pick this agent.
      "useWhen": "a well-scoped feature can be built independently",
      "dontUseWhen": "the task needs live conversation context",
      "harness": "codex",
      "model": "gpt-5.6-sol",
      "effort": "high"
    },
    {
      "name": "review",
      "useWhen": "a second opinion on a diff from a different vendor",
      "harness": "grok",
      "model": "grok-4.5",
      "effort": "high"
    }
  ],

  // Per-caller binding overrides.
  "callers": {
    "grok": {
      "agents": {
        // Cross-vendor review needs another vendor.
        "review": { "harness": "codex", "model": "gpt-5.6-sol", "effort": "high" }
      }
    }
  }
}
`

describe('setAgentField', () => {
  test('changes a model and preserves every comment / the callers section', () => {
    const next = setAgentField(FIXTURE, 0, 'model', 'gpt-5.5')

    // The edited value changed...
    expect(parseConfig(next).agents[0]?.model).toBe('gpt-5.5')

    // ...and everything outside the edited token survives byte-for-byte.
    expect(next).toContain('// Recursion guard.')
    expect(next).toContain('// The roster.')
    expect(next).toContain('// When to pick this agent.')
    expect(next).toContain('// Per-caller binding overrides.')
    expect(next).toContain('// Cross-vendor review needs another vendor.')
    expect(next).toContain('"review": { "harness": "codex", "model": "gpt-5.6-sol", "effort": "high" }')
    // Only the model literal differs from the original.
    expect(next.replace('"gpt-5.5"', '"gpt-5.6-sol"')).toBe(FIXTURE)
  })

  test('undefined value removes the effort field', () => {
    const next = setAgentField(FIXTURE, 0, 'effort', undefined)
    const parsed = parseConfig(next)
    expect(parsed.agents[0]?.effort).toBeUndefined()
    expect(parsed.agents[0]?.model).toBe('gpt-5.6-sol')
    // Comments untouched.
    expect(next).toContain('// When to pick this agent.')
  })
})

describe('appendAgent', () => {
  test('adds a valid agent; the config stays parseable and the roster grows', () => {
    const agent: AgentConfig = {
      name: 'explore',
      useWhen: 'broad codebase search',
      harness: 'grok',
      model: 'grok-composer-2.5-fast',
    }
    const next = appendAgent(FIXTURE, agent)
    const parsed = parseConfig(next)
    expect(parsed.agents).toHaveLength(3)
    expect(parsed.agents[2]).toEqual(agent)
    // Comments and callers section still present.
    expect(next).toContain('// Per-caller binding overrides.')
  })
})

describe('removeAgent', () => {
  test('removes exactly the targeted agent', () => {
    // Remove index 0 (implement); index 1 (review) remains.
    const next = removeAgent(FIXTURE, 0)
    const parsed = parseConfig(next)
    expect(parsed.agents).toHaveLength(1)
    expect(parsed.agents[0]?.name).toBe('review')
  })
})

describe('writeConfigText validation', () => {
  test('a mutation that makes the config invalid throws and leaves the file untouched', () => {
    const home = mkdtempSync(join(tmpdir(), 'dianjiang-edit-'))
    process.env.DIANJIANG_HOME = home
    try {
      writeFileSync(configPath(), FIXTURE)
      // grok's fast composer... no: set review (grok-4.5) effort to an invalid
      // value for grok. "ultra" is not a grok effort.
      const invalid = setAgentField(FIXTURE, 1, 'effort', 'ultra')
      expect(() => writeConfigText(invalid)).toThrow(/effort/)
      // File on disk is unchanged.
      expect(readFileSync(configPath(), 'utf8')).toBe(FIXTURE)
    } finally {
      rmSync(home, { recursive: true, force: true })
      delete process.env.DIANJIANG_HOME
    }
  })
})

describe('file wrappers round-trip', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dianjiang-edit-'))
    process.env.DIANJIANG_HOME = home
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.DIANJIANG_HOME
  })

  test('read -> mutate -> write -> read preserves comments and applies the edit', () => {
    writeFileSync(configPath(), FIXTURE)
    const text = readConfigText()
    expect(text).toBe(FIXTURE)

    const next = setAgentField(text, 1, 'model', 'grok-4-fast')
    writeConfigText(next)

    const roundTripped = readConfigText()
    expect(parseConfig(roundTripped).agents[1]?.model).toBe('grok-4-fast')
    expect(roundTripped).toContain('// Cross-vendor review needs another vendor.')
  })
})
