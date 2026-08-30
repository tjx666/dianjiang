import { describe, expect, test } from 'bun:test'
import type { DianjiangConfig, HarnessName } from '../src/core/types.ts'
import { defaultConfigJsonc, parseConfig } from '../src/core/registry.ts'
import { renderSkillDoc } from '../src/core/skill.ts'

const config: DianjiangConfig = {
  maxDepth: 2,
  agents: [
    { name: 'implement', useWhen: 'build a module', dontUseWhen: 'need live context', harness: 'codex' },
    { name: 'explore', useWhen: 'search fast', harness: 'grok' },
  ],
}

describe('renderSkillDoc', () => {
  test('renders an <agent> element per agent', () => {
    const doc = renderSkillDoc(config)
    expect(doc).toContain(
      '<agent name="implement">\n  <use-when>build a module</use-when>\n  <dont-use-when>need live context</dont-use-when>\n</agent>',
    )
    // missing dontUseWhen: the element is omitted entirely
    expect(doc).toContain('<agent name="explore">\n  <use-when>search fast</use-when>\n</agent>')
  })

  test('caller-less doc documents no --caller flag', () => {
    expect(renderSkillDoc(config)).not.toContain('--caller')
  })

  test('stamps --caller into the dispatch rule when a caller is given', () => {
    const doc = renderSkillDoc(config, 'grok')
    expect(doc).toContain('dianjiang run --caller grok <agent> "<task>"')
  })

  test('omits excluded agents for the excluding caller but keeps them for others', () => {
    const withExclude: DianjiangConfig = {
      ...config,
      callers: { grok: { exclude: ['explore'] } },
    }
    // grok excludes explore: its element is dropped, implement stays.
    const grokDoc = renderSkillDoc(withExclude, 'grok')
    expect(grokDoc).not.toContain('<agent name="explore">')
    expect(grokDoc).toContain('<agent name="implement">')
    // claude has no exclude: the full roster renders.
    const claudeDoc = renderSkillDoc(withExclude, 'claude')
    expect(claudeDoc).toContain('<agent name="explore">')
  })

  test("renders a caller's prepend at the top of the doc, before the intro", () => {
    const withPrepend: DianjiangConfig = {
      ...config,
      callers: { claude: { prepend: 'Implementation stays native.' } },
    }
    const claudeDoc = renderSkillDoc(withPrepend, 'claude')
    // The prepend is wrapped in <caller-guidance> so it reads as caller
    // behavior, not a dianjiang usage rule.
    expect(claudeDoc).toContain('<caller-guidance>\nImplementation stays native.\n</caller-guidance>')
    const prependIdx = claudeDoc.indexOf('Implementation stays native.')
    const introIdx = claudeDoc.indexOf('dispatches self-contained tasks')
    expect(prependIdx).toBeGreaterThanOrEqual(0)
    expect(prependIdx).toBeLessThan(introIdx)
    // No prepend → no empty wrapper element.
    expect(renderSkillDoc(withPrepend, 'codex')).not.toContain('<caller-guidance>')
    // Other callers (and the caller-less render) do NOT carry the prepend.
    expect(renderSkillDoc(withPrepend, 'codex')).not.toContain('Implementation stays native.')
    expect(renderSkillDoc(withPrepend)).not.toContain('Implementation stays native.')
  })

  test("renders a caller's append after the rules", () => {
    const withAppend: DianjiangConfig = {
      ...config,
      callers: { claude: { append: 'Use your built-in subagents for implementation.' } },
    }
    const claudeDoc = renderSkillDoc(withAppend, 'claude')
    const appendIdx = claudeDoc.indexOf('Use your built-in subagents for implementation.')
    const rulesEndIdx = claudeDoc.indexOf('</rules>')
    expect(appendIdx).toBeGreaterThan(rulesEndIdx)
    // Other callers (and the caller-less render) do NOT carry the append.
    expect(renderSkillDoc(withAppend, 'codex')).not.toContain('Use your built-in subagents for implementation.')
    expect(renderSkillDoc(withAppend, 'grok')).not.toContain('Use your built-in subagents for implementation.')
  })

  test("renders a caller's useWhen override in the <agent> element, base for others", () => {
    const withDescOverride: DianjiangConfig = {
      ...config,
      callers: {
        claude: { agents: { explore: { harness: 'grok', useWhen: 'caller-relative search note' } } },
      },
    }
    // claude sees the caller-relative description in explore's element.
    const claudeDoc = renderSkillDoc(withDescOverride, 'claude')
    expect(claudeDoc).toContain('<agent name="explore">\n  <use-when>caller-relative search note</use-when>\n</agent>')
    expect(claudeDoc).not.toContain('<use-when>search fast</use-when>')
    // Another caller (and the caller-less render) show the base description.
    const codexDoc = renderSkillDoc(withDescOverride, 'codex')
    expect(codexDoc).toContain('<agent name="explore">\n  <use-when>search fast</use-when>\n</agent>')
    expect(renderSkillDoc(withDescOverride)).toContain('<use-when>search fast</use-when>')
  })

  test('override rule allows relay only and drops the old "Relay only" phrasing', () => {
    const doc = renderSkillDoc(config, 'claude')
    expect(doc).toContain('Never override on your own judgment')
    expect(doc).not.toContain('Relay only')
  })

  test('carries the operational notes formerly in the static skill file', () => {
    const doc = renderSkillDoc(config, 'claude')
    expect(doc).toContain('YOLO mode')
    expect(doc).toContain('exactly one JSON value on stdout')
    expect(doc).toContain('DIANJIANG_DEPTH')
  })

  test('documents shell-safe transport for long or quote-containing tasks', () => {
    for (const caller of [undefined, 'claude', 'codex', 'grok'] as const) {
      const doc = renderSkillDoc(config, caller)
      expect(doc).toContain('placeholders, not shell-quoting recipes')
      expect(doc).toContain("task=$(cat <<'DIANJIANG_TASK'")
      expect(doc).toContain('"$task"')
      expect(doc).toContain('never hand-escape it inside shell quotes')
    }
  })

  test("the default roster's claude render keeps review's focused use-when", () => {
    const doc = renderSkillDoc(parseConfig(defaultConfigJsonc()), 'claude')
    // review is not excluded for the claude caller, so its base use-when renders.
    expect(doc).toContain('<agent name="review">')
    expect(doc).toContain('independent cross-vendor code review')
  })
})

describe('renderSkillDoc default-config snapshots', () => {
  const defaultConfig = parseConfig(defaultConfigJsonc())

  // Full-text snapshots pin the entire rendered doc for every caller shape,
  // not substrings — so any wording drift (intro, rules, per-caller
  // collection strategy) surfaces as a snapshot diff.
  test('caller-less render', () => {
    expect(renderSkillDoc(defaultConfig)).toMatchSnapshot()
  })

  test('claude render', () => {
    expect(renderSkillDoc(defaultConfig, 'claude')).toMatchSnapshot()
  })

  test('codex render', () => {
    expect(renderSkillDoc(defaultConfig, 'codex')).toMatchSnapshot()
  })

  test('grok render', () => {
    expect(renderSkillDoc(defaultConfig, 'grok')).toMatchSnapshot()
  })
})

describe('renderSkillDoc collection-strategy conflict freedom', () => {
  // These encode the 2026-07 bug fix: exactly ONE authoritative wait strategy
  // per caller, with no leftover generic/contradictory phrasing.
  const defaultConfig = parseConfig(defaultConfigJsonc())
  const callers: (HarnessName | undefined)[] = [undefined, 'claude', 'codex', 'grok']

  for (const caller of callers) {
    test(`${caller ?? 'caller-less'} render has a single authoritative wait rule`, () => {
      const doc = renderSkillDoc(defaultConfig, caller)
      // exactly one collection rule, no leftover generic phrasing
      expect(doc.split('Collect every run with').length - 1).toBe(1)
      expect(doc).not.toContain('then block')
      expect(doc).not.toMatch(/[Ii]f you have nothing else/)
    })
  }

  test('codex render routes the wait through a waiter subagent', () => {
    const doc = renderSkillDoc(defaultConfig, 'codex')
    expect(doc).toContain('spawn_agent')
    expect(doc).toMatch(/Do not wait in the\s+foreground first/)
    expect(doc).not.toContain('run_in_background')
  })

  // Regression (2026-07): an agent generalized the waiter's internal 300s
  // re-run loop into root-agent `wait_agent` polling every 30s, spamming
  // "Waiting for agents" UI noise. The codex strategy must pin loop ownership
  // to the waiter and explicitly forbid repeated short main-agent waits.
  test('codex render pins the re-run loop to the waiter, not the root agent', () => {
    const doc = renderSkillDoc(defaultConfig, 'codex')
    expect(doc).toContain('belongs INSIDE a waiter subagent')
    expect(doc).toContain('never in your own turn')
    // waiter contract: terminal-only stop, verbatim JSON, silent progress
    expect(doc).toContain('Stop only on a terminal status')
    expect(doc).toContain('emit no progress narration')
    // one waiter per runId, shareable across already-known runIds
    expect(doc).toContain('One waiter per runId')
  })

  test('codex render forbids repeated short main-agent waits', () => {
    const doc = renderSkillDoc(defaultConfig, 'codex')
    expect(doc).toMatch(/NEVER poll the waiter\s+with repeated `wait_agent` calls/)
    expect(doc).toContain('`dianjiang result <runId> --wait --timeout 300`')
    expect(doc).toContain('`wait_agent({ timeout_ms: 3600000 })`')
    expect(doc).toMatch(/maximum\s+supported one-hour timeout/)
    expect(doc).toContain('NEVER shorten the timeout to poll')
    expect(doc).toMatch(/print no unchanged-status updates\s+between waits/)
    expect(doc).not.toContain('ONE long')
  })

  test('claude render waits in a background shell', () => {
    const doc = renderSkillDoc(defaultConfig, 'claude')
    expect(doc).toContain('run_in_background')
    expect(doc).not.toContain('spawn_agent')
  })

  test('grok render waits as a background task', () => {
    const doc = renderSkillDoc(defaultConfig, 'grok')
    expect(doc).toContain('background: true')
    expect(doc).not.toContain('spawn_agent')
    expect(doc).not.toContain('run_in_background')
  })

  test('caller-less render names no caller-specific wait mechanism', () => {
    const doc = renderSkillDoc(defaultConfig)
    expect(doc).not.toContain('spawn_agent')
    expect(doc).not.toContain('run_in_background')
  })

  test('every render teaches callers to act on exhausted harness quota', () => {
    for (const caller of [undefined, 'claude', 'codex', 'grok'] as const) {
      const doc = renderSkillDoc(defaultConfig, caller)
      expect(doc).toContain('`code: "quota_exhausted"`')
      expect(doc).toContain('recommend another')
      expect(doc).toContain('never treat `.result` as the task\'s answer')
    }
  })
})
