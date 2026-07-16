import { describe, expect, test } from 'bun:test'
import type { DianjiangConfig } from '../src/core/types.ts'
import { defaultConfigJsonc, findAgent, parseConfig, resolveAgent, validateConfig } from '../src/core/registry.ts'

describe('defaultConfigJsonc', () => {
  test('parses and validates via parseConfig (roster v1 + capability agents)', () => {
    const config = parseConfig(defaultConfigJsonc(), 'default')
    expect(config.maxDepth).toBe(2)
    expect(config.agents.map((a) => a.name)).toEqual([
      'implement',
      'review',
      'second-opinion',
      'explore',
      'search-twitter',
      'design-frontend',
      'rewrite-prompt',
    ])
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

  test('rejects an effort a known model does not support (gpt-5.4-mini + ultra)', () => {
    const cfg: DianjiangConfig = {
      maxDepth: 2,
      agents: [{ name: 'a', useWhen: 'x', harness: 'codex', model: 'gpt-5.4-mini', effort: 'ultra' }],
    }
    // Model-aware: ultra is a valid codex effort but not for gpt-5.4-mini.
    expect(() => validateConfig(cfg)).toThrow(/invalid effort "ultra" for model "gpt-5.4-mini"/)
  })

  test('accepts an unknown model with a harness-valid effort (permissive pass-through)', () => {
    const cfg: DianjiangConfig = {
      maxDepth: 2,
      agents: [{ name: 'a', useWhen: 'x', harness: 'codex', model: 'gpt-6.0-future', effort: 'xhigh' }],
    }
    expect(() => validateConfig(cfg)).not.toThrow()
  })

  test('rejects any effort on the no-effort grok-composer model', () => {
    // The curated knownModels entry (efforts: []) subsumes the old special case.
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

describe('validateConfig (callers)', () => {
  function withCallers(callers: unknown): DianjiangConfig {
    return {
      maxDepth: 2,
      agents: [{ name: 'review', useWhen: 'x', harness: 'grok', model: 'grok-4.5', effort: 'high' }],
      callers: callers as DianjiangConfig['callers'],
    }
  }

  test('accepts a valid caller override', () => {
    const cfg = withCallers({ grok: { agents: { review: { harness: 'codex', model: 'gpt-5.6-sol', effort: 'high' } } } })
    expect(() => validateConfig(cfg)).not.toThrow()
  })

  test('rejects an unknown caller key', () => {
    const cfg = withCallers({ gemini: { agents: {} } })
    expect(() => validateConfig(cfg)).toThrow(/callers\.gemini/)
  })

  test('rejects an override of an unknown agent name', () => {
    const cfg = withCallers({ grok: { agents: { nope: { harness: 'codex' } } } })
    expect(() => validateConfig(cfg)).toThrow(/callers\.grok\.agents\.nope/)
  })

  test('rejects an invalid effort in an override', () => {
    const cfg = withCallers({ grok: { agents: { review: { harness: 'grok', effort: 'ultra' } } } })
    expect(() => validateConfig(cfg)).toThrow(/callers\.grok\.agents\.review/)
  })
})

describe('resolveAgent', () => {
  const config: DianjiangConfig = {
    maxDepth: 2,
    agents: [{ name: 'review', useWhen: 'x', harness: 'grok', model: 'grok-4.5', effort: 'high' }],
    callers: {
      grok: { agents: { review: { harness: 'codex', model: 'gpt-5.6-sol', effort: 'high' } } },
      // Override without a model: resolved model must be undefined, NOT the base's.
      codex: { agents: { review: { harness: 'claude' } } },
    },
  }

  test('returns the base binding when no caller is given', () => {
    const a = resolveAgent(config, 'review')
    expect(a.harness).toBe('grok')
    expect(a.model).toBe('grok-4.5')
  })

  test('returns the base binding when the caller has no matching override', () => {
    const a = resolveAgent(config, 'review', 'claude')
    expect(a.harness).toBe('grok')
    expect(a.model).toBe('grok-4.5')
  })

  test('replaces the whole binding for a matching caller override', () => {
    const a = resolveAgent(config, 'review', 'grok')
    expect(a.harness).toBe('codex')
    expect(a.model).toBe('gpt-5.6-sol')
    expect(a.effort).toBe('high')
    // Semantics stay single-source from the base agent.
    expect(a.useWhen).toBe('x')
  })

  test('override without a model resolves to harness default, not the base model', () => {
    const a = resolveAgent(config, 'review', 'codex')
    expect(a.harness).toBe('claude')
    expect(a.model).toBeUndefined()
    expect(a.effort).toBeUndefined()
  })
})
