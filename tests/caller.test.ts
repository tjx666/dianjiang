import { describe, expect, test } from 'bun:test'
import { ancestorCommands, detectCallerFromChain, matchHarnessCommand } from '../src/core/caller.ts'

describe('matchHarnessCommand', () => {
  test('matches each harness by argv0 basename', () => {
    expect(matchHarnessCommand('claude --dangerously-skip-permissions')).toBe('claude')
    expect(matchHarnessCommand('grok -p Run this and paste raw output')).toBe('grok')
    expect(matchHarnessCommand('codex exec --json "task"')).toBe('codex')
  })

  test('matches codex platform binaries and package-path shims', () => {
    // pnpm installs run a platform executable whose basename is `codex-*`…
    expect(
      matchHarnessCommand(
        '/Users/x/Library/pnpm/store/v11/links/@openai/codex/0.145.0-darwin-arm64/da4acb/codex-aarch64-apple-darwin',
      ),
    ).toBe('codex')
    // …fronted by a node shim that only carries the package path in its args.
    expect(matchHarnessCommand('node /Users/x/pnpm/global/node_modules/@openai/codex/bin/codex.js')).toBe('codex')
  })

  test('never matches harness names appearing only in arguments', () => {
    // claude's shell wrapper sources a path under ~/.claude — not a harness.
    expect(matchHarnessCommand('/bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot.sh')).toBeUndefined()
    // a dianjiang dispatch line quotes vendors in its task text / flags.
    expect(
      matchHarnessCommand('bun /Users/x/.bun/bin/dianjiang run --harness codex -m gpt "fix the claude adapter"'),
    ).toBeUndefined()
    expect(matchHarnessCommand('/Applications/Visual Studio Code.app/Contents/MacOS/Code')).toBeUndefined()
    expect(matchHarnessCommand('')).toBeUndefined()
  })
})

describe('detectCallerFromChain', () => {
  test('plain claude session (live fixture)', () => {
    expect(
      detectCallerFromChain([
        '/bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot.sh',
        'claude --dangerously-skip-permissions',
        '/bin/zsh -il',
        '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
      ]),
    ).toBe('claude')
  })

  test('nested dispatch: nearest harness wins over the outer session (live fixture)', () => {
    // A codex delegate dispatched FROM a claude session: codex is nearer than
    // the outer claude, and the intermediate dianjiang lines must not match.
    expect(
      detectCallerFromChain([
        "/bin/zsh -c env | grep -iE 'claude|codex|grok'",
        '/Users/x/Library/pnpm/store/v11/links/@openai/codex/0.145.0-darwin-arm64/da4acb/codex-bin',
        'node /Users/x/Library/pnpm/bin/codex',
        '/Users/x/.bun/bin/bun /Users/x/code/dianjiang/src/cli/index.ts _exec 0258093d',
        'bun /Users/x/.bun/bin/dianjiang run --harness codex -m gpt-5.4-mini Run this',
        '/bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot.sh',
        'claude --dangerously-skip-permissions',
      ]),
    ).toBe('codex')
  })

  test('no harness ancestor → undefined', () => {
    expect(detectCallerFromChain(['/bin/zsh -il', 'login', '/sbin/launchd'])).toBeUndefined()
    expect(detectCallerFromChain([])).toBeUndefined()
  })
})

describe('ancestorCommands', () => {
  test('walks real ancestry without throwing and returns command lines', () => {
    const commands = ancestorCommands()
    expect(commands.length).toBeGreaterThan(0)
    for (const c of commands) expect(typeof c).toBe('string')
  })

  test('bounded by maxDepth', () => {
    expect(ancestorCommands(process.ppid, 1).length).toBeLessThanOrEqual(1)
  })

  test('unreadable pid → empty chain, no throw', () => {
    expect(ancestorCommands(999999999)).toEqual([])
  })
})
