import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyEdits, type FormattingOptions, modify } from 'jsonc-parser'
import { applySyncDefaults, planSyncDefaults, type SyncChange } from '../src/core/sync-defaults.ts'
import { defaultConfigJsonc, parseConfig } from '../src/core/registry.ts'
import { configPath } from '../src/core/paths.ts'
import type { AgentConfig } from '../src/core/types.ts'

const FORMATTING: FormattingOptions = { tabSize: 2, insertSpaces: true }

/**
 * Historical default values, embedded independently of {@link LEGACY_DEFAULTS}
 * so the tests are a second source of truth (a wrong value in the module can't
 * silently pass). These are the exact decoded strings that shipped historically.
 */
const V050_REVIEW_USEWHEN =
  'you want an independent cross-vendor code review of a diff; runs gpt-5.6-sol at xhigh — stronger reasoning than opus, slightly below fable'
const V050_CODEX_REVIEW_USEWHEN = 'you want an independent cross-vendor code review of a diff; runs claude opus at xhigh'
const V050_CODEX_APPEND =
  'Your shell sessions do NOT wake you when a background command finishes, and polling is easy to forget. To collect a dianjiang run without blocking, use your subagent notification channel: `spawn_agent` with `fork_turns: "none"` and the message "Run `dianjiang result <runId> --wait --timeout 300`. If it prints status \'running\', run it again. When the status is terminal, return the full JSON verbatim." — its completion notification wakes you with the result while you keep working. If you have nothing else to do, just run `dianjiang result <runId> --wait --timeout 300` in the foreground. Either way, never end your turn with a dispatched run uncollected.'

// Never-committed intermediate defaults (shipped via `config init --force`).
const INT_REVIEW_USEWHEN =
  "you want an independent cross-vendor code review of a diff; focused and findings-only by default — say 'deep review' in the task for a comprehensive audit; runs gpt-5.6-sol at xhigh — stronger reasoning than opus, slightly below fable"
const INT_REVIEW_INSTRUCTIONS =
  "Default to a FOCUSED review: cover exactly the risks, files, and acceptance criteria the task names. Verifying a specific falsifiable hypothesis in depth is fine; a fixed all-dimension fan-out is not. Run a comprehensive deep review only when the task explicitly asks for one. Output contract: actionable findings only, ordered by severity — each with file:line, impact, how to trigger it, and a suggested fix; if nothing qualifies, output 'clean' plus one line on what you checked. Do not restate background or emit process narration, statistics, workflow/skill feedback, or non-blocking nits unless the task asks for them. Record `git rev-parse HEAD` (and whether the tree is dirty) before reading code and name that state in your verdict; if the tree changes mid-review, report 'snapshot changed' and state which state each finding applies to — never claim you covered a moving target. When resumed to verify fixes, check only the named findings and the fix delta — report each as fixed or still open, plus any regression the fix itself introduced; do not re-run the full review."
const INT_CODEX_REVIEW_USEWHEN =
  "you want an independent cross-vendor code review of a diff; focused and findings-only by default — say 'deep review' in the task for a comprehensive audit; runs claude opus at xhigh"
const INT_CODEX_APPEND = V050_CODEX_APPEND.replace(
  'while you keep working. ',
  'while you keep working. One waiter can collect several runIds — list them all in its message rather than spawning one waiter per run. ',
)

interface Edit {
  path: (string | number)[]
  value: unknown
  insert?: boolean
}

/** Apply a series of jsonc edits to the current defaults to shape a fixture. */
function shape(edits: Edit[]): string {
  let text = defaultConfigJsonc()
  for (const e of edits) {
    text = applyEdits(text, modify(text, e.path, e.value, { formattingOptions: FORMATTING, isArrayInsertion: e.insert }))
  }
  return text
}

/** Index of an agent by name in the current defaults. */
function idx(name: string): number {
  return parseConfig(defaultConfigJsonc()).agents.findIndex((a) => a.name === name)
}

/** Set of `action path` strings for the non-`keep-custom` steps of a plan. */
function actions(plan: SyncChange[]): Set<string> {
  return new Set(plan.filter((c) => c.action !== 'keep-custom').map((c) => `${c.action} ${c.path}`))
}

/** Deep-parse two config texts and assert structural equality. */
function expectSameConfig(a: string, b: string): void {
  expect(parseConfig(a)).toEqual(parseConfig(b))
}

describe('planSyncDefaults / applySyncDefaults', () => {
  test('a v0.5.0-shaped config upgrades to the current defaults', () => {
    const rIdx = idx('review')
    const fixture = shape([
      { path: ['agents', rIdx, 'useWhen'], value: V050_REVIEW_USEWHEN },
      { path: ['agents', rIdx, 'instructions'], value: undefined },
      { path: ['callers', 'codex', 'agents', 'review', 'useWhen'], value: V050_CODEX_REVIEW_USEWHEN },
      { path: ['callers', 'codex', 'append'], value: V050_CODEX_APPEND },
    ])
    // Sanity: the fixture is itself a valid config.
    expect(() => parseConfig(fixture)).not.toThrow()

    const plan = planSyncDefaults(fixture)
    // Review's useWhen/instructions reverted to the v0.5.0 shape in 2026-07,
    // so the only drift left in this fixture is the legacy codex append.
    expect(actions(plan)).toEqual(new Set(['remove callers.codex.append']))
    // No customizations to keep — every managed field is a recognized default.
    expect(plan.filter((c) => c.action === 'keep-custom')).toHaveLength(0)

    const applied = applySyncDefaults(fixture, plan)
    expect(() => parseConfig(applied)).not.toThrow()
    // Reverting the four fields restores exactly the current defaults.
    expectSameConfig(applied, defaultConfigJsonc())
  })

  test('a config with never-committed intermediate values upgrades identically', () => {
    const rIdx = idx('review')
    const fixture = shape([
      { path: ['agents', rIdx, 'useWhen'], value: INT_REVIEW_USEWHEN },
      { path: ['agents', rIdx, 'instructions'], value: INT_REVIEW_INSTRUCTIONS },
      { path: ['callers', 'codex', 'agents', 'review', 'useWhen'], value: INT_CODEX_REVIEW_USEWHEN },
      { path: ['callers', 'codex', 'append'], value: INT_CODEX_APPEND },
    ])
    const plan = planSyncDefaults(fixture)
    expect(actions(plan)).toEqual(
      new Set([
        'set agents.review.useWhen',
        'remove agents.review.instructions',
        'set callers.codex.agents.review.useWhen',
        'remove callers.codex.append',
      ]),
    )
    expect(plan.filter((c) => c.action === 'keep-custom')).toHaveLength(0)

    const applied = applySyncDefaults(fixture, plan)
    expectSameConfig(applied, defaultConfigJsonc())
  })

  test('a customized field is kept + reported; a deleted managed agent is re-added', () => {
    const rIdx = idx('review')
    const CUSTOM = 'MY OWN REVIEW BLURB — do not touch this'
    // Custom useWhen on review, and delete rewrite-prompt (not referenced by any
    // caller, so the pre-sync config stays valid).
    const fixture = shape([
      { path: ['agents', rIdx, 'useWhen'], value: CUSTOM },
      { path: ['agents', idx('rewrite-prompt')], value: undefined },
    ])
    expect(() => parseConfig(fixture)).not.toThrow()
    expect(parseConfig(fixture).agents.some((a) => a.name === 'rewrite-prompt')).toBe(false)

    const plan = planSyncDefaults(fixture)
    // The arbitrary useWhen is not a known default → kept, reported only.
    const keep = plan.find((c) => c.path === 'agents.review.useWhen')
    expect(keep).toEqual({ path: 'agents.review.useWhen', action: 'keep-custom', from: CUSTOM })
    // The deleted managed agent is re-added.
    const add = plan.find((c) => c.path === 'agents.rewrite-prompt')
    expect(add?.action).toBe('add')

    const applied = applySyncDefaults(fixture, plan)
    const parsed = parseConfig(applied)
    // Customization survived untouched.
    expect(parsed.agents.find((a) => a.name === 'review')?.useWhen).toBe(CUSTOM)
    // rewrite-prompt is back, equal to the current default entry.
    const defaults = parseConfig(defaultConfigJsonc())
    expect(parsed.agents.find((a) => a.name === 'rewrite-prompt')).toEqual(
      defaults.agents.find((a) => a.name === 'rewrite-prompt'),
    )
  })

  test('a user-added agent not in the defaults is left untouched and unreported', () => {
    const custom: AgentConfig = { name: 'my-custom', useWhen: 'do a bespoke thing', harness: 'grok', model: 'grok-4.5' }
    const parsedDefaults = parseConfig(defaultConfigJsonc())
    const fixture = shape([{ path: ['agents', parsedDefaults.agents.length], value: custom, insert: true }])

    const plan = planSyncDefaults(fixture)
    // Nothing in the plan mentions the user's own agent.
    expect(plan.some((c) => c.path.startsWith('agents.my-custom'))).toBe(false)

    const applied = applySyncDefaults(fixture, plan)
    expect(parseConfig(applied).agents.find((a) => a.name === 'my-custom')).toEqual(custom)
  })

  test('JSONC comments survive an apply', () => {
    const rIdx = idx('review')
    const fixture = shape([{ path: ['agents', rIdx, 'useWhen'], value: V050_REVIEW_USEWHEN }])
    const applied = applySyncDefaults(fixture)
    // Comments from the default template are still present after editing.
    expect(applied).toContain('// The roster.')
    expect(applied).toContain('// Recursion guard:')
    expect(applied).toContain('// Per-caller adjustments.')
  })
})

describe('config sync-defaults CLI', () => {
  let home: string
  const CLI = join(import.meta.dir, '..', 'src', 'cli', 'index.ts')

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dianjiang-sync-'))
    process.env.DIANJIANG_HOME = home
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.DIANJIANG_HOME
  })

  function runCli(...cliArgs: string[]): { json: any; stdout: string } {
    const proc = Bun.spawnSync({
      cmd: ['bun', 'run', CLI, ...cliArgs],
      env: { ...process.env, DIANJIANG_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = proc.stdout.toString()
    return { json: JSON.parse(stdout), stdout }
  }

  test('--dry-run reports the plan without modifying the file', () => {
    const rIdx = idx('review')
    const fixture = shape([
      { path: ['agents', rIdx, 'useWhen'], value: V050_REVIEW_USEWHEN },
      { path: ['agents', rIdx, 'instructions'], value: undefined },
      { path: ['callers', 'codex', 'append'], value: V050_CODEX_APPEND },
    ])
    writeFileSync(configPath(), fixture)

    const { json } = runCli('config', 'sync-defaults', '--dry-run')
    expect(json.applied).toBe(false)
    expect(json.file).toBe(configPath())
    expect(json.changes.length).toBeGreaterThan(0)
    // File on disk is byte-for-byte unchanged.
    expect(readFileSync(configPath(), 'utf8')).toBe(fixture)
  })

  test('apply writes the upgraded, re-validated config', () => {
    const rIdx = idx('review')
    const fixture = shape([
      { path: ['agents', rIdx, 'useWhen'], value: V050_REVIEW_USEWHEN },
      { path: ['agents', rIdx, 'instructions'], value: undefined },
      { path: ['callers', 'codex', 'append'], value: V050_CODEX_APPEND },
    ])
    writeFileSync(configPath(), fixture)

    const { json } = runCli('config', 'sync-defaults')
    expect(json.applied).toBe(true)
    // The written file loads and matches the current defaults for review.
    const onDisk = readFileSync(configPath(), 'utf8')
    expect(() => parseConfig(onDisk)).not.toThrow()
    const review = parseConfig(onDisk).agents.find((a) => a.name === 'review')
    expect(review?.instructions).toBeUndefined()
    expect(review?.useWhen).toBe(V050_REVIEW_USEWHEN)

    // Running again is a no-op.
    const second = runCli('config', 'sync-defaults')
    expect(second.json.applied).toBe(false)
  })

  test('a missing config fails with exit 1', () => {
    // beforeEach makes the home dir but writes no config.jsonc.
    const proc = Bun.spawnSync({
      cmd: ['bun', 'run', CLI, 'config', 'sync-defaults'],
      env: { ...process.env, DIANJIANG_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const json = JSON.parse(proc.stdout.toString())
    expect(json.status).toBe('failed')
    expect(proc.exitCode).toBe(1)
  })
})
