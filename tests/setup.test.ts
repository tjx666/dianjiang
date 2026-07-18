import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DianjiangConfig, HarnessName } from '../src/core/types.ts'
import {
  defaultTargets,
  filterTargets,
  injectBlock,
  removeBlock,
  renderRosterBlock,
  runSetup,
} from '../src/core/setup.ts'

const config: DianjiangConfig = {
  maxDepth: 2,
  agents: [
    { name: 'implement', useWhen: 'build a module', dontUseWhen: 'need live context', harness: 'codex' },
    { name: 'explore', useWhen: 'search fast', harness: 'grok' },
  ],
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dianjiang-setup-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('renderRosterBlock', () => {
  test('renders an <agent> element per agent with begin/end markers', () => {
    const block = renderRosterBlock(config)
    expect(block).toContain('<!-- dianjiang:begin -->')
    expect(block).toContain('<!-- dianjiang:end -->')
    expect(block).toContain(
      '<agent name="implement">\n  <use-when>build a module</use-when>\n  <dont-use-when>need live context</dont-use-when>\n</agent>',
    )
    // missing dontUseWhen: the element is omitted entirely
    expect(block).toContain('<agent name="explore">\n  <use-when>search fast</use-when>\n</agent>')
  })

  test('caller-less block documents no --caller flag', () => {
    expect(renderRosterBlock(config)).not.toContain('--caller')
  })

  test('stamps --caller into the blocking-run rule when a caller is given', () => {
    const block = renderRosterBlock(config, 'grok')
    expect(block).toContain('dianjiang run --caller grok <agent> "<task>"')
  })

  test('omits excluded agents for the excluding caller but keeps them for others', () => {
    const withExclude: DianjiangConfig = {
      ...config,
      callers: { grok: { exclude: ['explore'] } },
    }
    // grok excludes explore: its element is dropped, implement stays.
    const grokBlock = renderRosterBlock(withExclude, 'grok')
    expect(grokBlock).not.toContain('<agent name="explore">')
    expect(grokBlock).toContain('<agent name="implement">')
    // claude has no exclude: the full roster renders.
    const claudeBlock = renderRosterBlock(withExclude, 'claude')
    expect(claudeBlock).toContain('<agent name="explore">')
  })

  test("renders a caller's prepend at the top of the block, before the intro", () => {
    const withPrepend: DianjiangConfig = {
      ...config,
      callers: { claude: { prepend: 'Implementation stays native.' } },
    }
    const claudeBlock = renderRosterBlock(withPrepend, 'claude')
    // The prepend is wrapped in <caller-guidance> so it reads as caller
    // behavior, not a dianjiang usage rule.
    expect(claudeBlock).toContain('<caller-guidance>\nImplementation stays native.\n</caller-guidance>')
    const prependIdx = claudeBlock.indexOf('Implementation stays native.')
    const wrapperIdx = claudeBlock.indexOf('<dianjiang-roster>')
    const introIdx = claudeBlock.indexOf('dispatches self-contained tasks')
    expect(prependIdx).toBeGreaterThan(wrapperIdx)
    expect(prependIdx).toBeLessThan(introIdx)
    // No prepend → no empty wrapper element.
    expect(renderRosterBlock(withPrepend, 'codex')).not.toContain('<caller-guidance>')
    // Other callers (and the caller-less render) do NOT carry the prepend.
    expect(renderRosterBlock(withPrepend, 'codex')).not.toContain('Implementation stays native.')
    expect(renderRosterBlock(withPrepend)).not.toContain('Implementation stays native.')
  })

  test("renders a caller's append after the rules and before the end marker", () => {
    const withAppend: DianjiangConfig = {
      ...config,
      callers: { claude: { append: 'Use your built-in subagents for implementation.' } },
    }
    const claudeBlock = renderRosterBlock(withAppend, 'claude')
    // The append text lands inside the managed block, after the rules list.
    expect(claudeBlock).toContain('Use your built-in subagents for implementation.')
    const appendIdx = claudeBlock.indexOf('Use your built-in subagents for implementation.')
    const rulesEndIdx = claudeBlock.indexOf('</rules>')
    const endIdx = claudeBlock.indexOf('<!-- dianjiang:end -->')
    expect(rulesEndIdx).toBeLessThan(appendIdx)
    expect(appendIdx).toBeLessThan(endIdx)
    // Other callers (and the caller-less render) do NOT carry the append.
    expect(renderRosterBlock(withAppend, 'codex')).not.toContain('Use your built-in subagents for implementation.')
    expect(renderRosterBlock(withAppend, 'grok')).not.toContain('Use your built-in subagents for implementation.')
  })
})

describe('injectBlock', () => {
  test('appends to an existing file that has no markers', () => {
    const file = join(dir, 'CLAUDE.md')
    writeFileSync(file, '# My prefs\n\nExisting content.\n')
    const action = injectBlock(file, renderRosterBlock(config))
    const content = readFileSync(file, 'utf8')
    expect(action).toBe('updated')
    expect(content).toContain('Existing content.')
    expect(content).toContain('<dianjiang-roster>')
  })

  test('replaces an existing managed block in place', () => {
    const file = join(dir, 'CLAUDE.md')
    const first = renderRosterBlock(config)
    injectBlock(file, first) // creates the file
    const changed: DianjiangConfig = {
      maxDepth: 2,
      agents: [{ name: 'review', useWhen: 'second opinion', harness: 'grok' }],
    }
    injectBlock(file, renderRosterBlock(changed))
    const content = readFileSync(file, 'utf8')
    expect(content).toContain('<agent name="review">')
    expect(content).not.toContain('<agent name="implement">')
    // exactly one managed block remains
    expect(content.split('<!-- dianjiang:begin -->').length - 1).toBe(1)
  })

  test('is idempotent across repeated runs', () => {
    const file = join(dir, 'AGENTS.md')
    writeFileSync(file, 'preamble\n')
    const block = renderRosterBlock(config)
    injectBlock(file, block)
    const once = readFileSync(file, 'utf8')
    injectBlock(file, block)
    const twice = readFileSync(file, 'utf8')
    expect(twice).toBe(once)
  })
})

describe('runSetup', () => {
  test('writes all three target files', () => {
    const targets = {
      claude: join(dir, '.claude', 'CLAUDE.md'),
      codex: join(dir, '.codex', 'AGENTS.md'),
      grok: join(dir, '.grok', 'AGENTS.md'),
    }
    const results = runSetup(config, targets)
    expect(results.map((r) => r.action)).toEqual(['written', 'written', 'written'])
    for (const t of Object.values(targets)) {
      expect(readFileSync(t, 'utf8')).toContain('<dianjiang-roster>')
    }
  })

  test('stamps each target with its own caller', () => {
    const targets = {
      claude: join(dir, '.claude', 'CLAUDE.md'),
      codex: join(dir, '.codex', 'AGENTS.md'),
      grok: join(dir, '.grok', 'AGENTS.md'),
    }
    runSetup(config, targets)
    expect(readFileSync(targets.claude, 'utf8')).toContain('--caller claude')
    expect(readFileSync(targets.codex, 'utf8')).toContain('--caller codex')
    expect(readFileSync(targets.grok, 'utf8')).toContain('--caller grok')
  })
})

describe('removeBlock', () => {
  test('strips the block and its padding, leaving the remainder byte-identical', () => {
    const file = join(dir, 'CLAUDE.md')
    const original = '# My prefs\n\nExisting content.\n'
    writeFileSync(file, original)
    injectBlock(file, renderRosterBlock(config))
    // sanity: the block really was injected
    expect(readFileSync(file, 'utf8')).toContain('<dianjiang-roster>')

    const action = removeBlock(file)
    expect(action).toBe('removed')
    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  test('removes the whole file content when the block is all there was', () => {
    const file = join(dir, 'AGENTS.md')
    injectBlock(file, renderRosterBlock(config)) // creates a block-only file
    expect(removeBlock(file)).toBe('removed')
    expect(readFileSync(file, 'utf8')).toBe('')
  })

  test('missing file → skipped', () => {
    expect(removeBlock(join(dir, 'nope.md'))).toBe('skipped')
  })

  test('file without markers → skipped, byte-identical', () => {
    const file = join(dir, 'plain.md')
    const original = 'no markers here\n'
    writeFileSync(file, original)
    expect(removeBlock(file)).toBe('skipped')
    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  test('inject → remove → inject roundtrip is stable', () => {
    const file = join(dir, 'CLAUDE.md')
    writeFileSync(file, '# My prefs\n\nExisting content.\n')
    const block = renderRosterBlock(config)
    injectBlock(file, block)
    const afterFirstInject = readFileSync(file, 'utf8')
    removeBlock(file)
    injectBlock(file, block)
    expect(readFileSync(file, 'utf8')).toBe(afterFirstInject)
  })
})

describe('filterTargets', () => {
  test('narrows to the requested subset, preserving the caller key', () => {
    const all = defaultTargets('/home/tester')
    const subset = filterTargets(['claude', 'grok'], all)
    expect(Object.keys(subset).sort()).toEqual(['claude', 'grok'])
    expect(subset.claude).toBe(all.claude)
    expect(subset.grok).toBe(all.grok)
    expect(subset.codex).toBeUndefined()
  })

  test('throws on an unknown harness name', () => {
    expect(() => filterTargets(['gemini' as HarnessName], defaultTargets('/home/tester'))).toThrow(
      /Unknown harness "gemini"/,
    )
  })
})
