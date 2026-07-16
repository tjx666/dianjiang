import { describe, expect, test } from 'bun:test'
import type { DianjiangConfig } from '../src/core/types.ts'
import { defaultConfigJsonc, findAgent, parseConfig, validateConfig } from '../src/core/registry.ts'

describe('defaultConfigJsonc', () => {
  test('parses and validates via parseConfig (roster v1)', () => {
    const config = parseConfig(defaultConfigJsonc(), 'default')
    expect(config.maxDepth).toBe(2)
    expect(config.agents.map((a) => a.name)).toEqual(['implement', 'review', 'second-opinion', 'explore'])
    // explore uses grok-composer-2.5-fast and must carry no effort.
    const explore = config.agents.find((a) => a.name === 'explore')
    expect(explore?.effort).toBeUndefined()
  })
})

describe('validateConfig', () => {
  function base(): DianjiangConfig {
    return { maxDepth: 2, agents: [{ name: 'a', useWhen: 'x', harness: 'codex', effort: 'high' }] }
  }

  test('accepts a minimal valid config', () => {
    expect(() => validateConfig(base())).not.toThrow()
  })

  test('rejects empty agents', () => {
    expect(() => validateConfig({ maxDepth: 2, agents: [] })).toThrow(/non-empty array/)
  })

  test('rejects unknown harness', () => {
    const cfg = { maxDepth: 2, agents: [{ name: 'a', useWhen: 'x', harness: 'gemini' }] } as unknown as DianjiangConfig
    expect(() => validateConfig(cfg)).toThrow(/unknown harness/)
  })

  test('rejects duplicate agent names', () => {
    const cfg: DianjiangConfig = {
      maxDepth: 2,
      agents: [
        { name: 'dup', useWhen: 'x', harness: 'codex' },
        { name: 'dup', useWhen: 'y', harness: 'grok' },
      ],
    }
    expect(() => validateConfig(cfg)).toThrow(/duplicate agent name/)
  })

  test('rejects invalid effort for the harness', () => {
    const cfg: DianjiangConfig = { maxDepth: 2, agents: [{ name: 'a', useWhen: 'x', harness: 'grok', effort: 'ultra' }] }
    expect(() => validateConfig(cfg)).toThrow(/invalid effort/)
  })

  test('rejects effort on grok-composer-2.5-fast', () => {
    const cfg: DianjiangConfig = {
      maxDepth: 2,
      agents: [{ name: 'a', useWhen: 'x', harness: 'grok', model: 'grok-composer-2.5-fast', effort: 'high' }],
    }
    expect(() => validateConfig(cfg)).toThrow(/does not support effort/)
  })
})

describe('findAgent', () => {
  const config: DianjiangConfig = {
    maxDepth: 2,
    agents: [{ name: 'implement', useWhen: 'x', harness: 'codex' }],
  }

  test('finds an existing agent', () => {
    expect(findAgent(config, 'implement').harness).toBe('codex')
  })

  test('lists available names on a miss', () => {
    expect(() => findAgent(config, 'nope')).toThrow(/Available agents: implement/)
  })
})
