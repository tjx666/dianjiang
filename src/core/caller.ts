/**
 * Caller-harness detection from process ancestry.
 *
 * Used as a FALLBACK when `--caller` is omitted: walk up the process tree and
 * take the NEAREST ancestor that is a harness CLI. Nearest-wins makes nested
 * dispatch correct (a codex delegate spawned from a claude session sees codex
 * first; the outer claude sits further up the chain).
 *
 * Env-var sniffing was measured (2026-07 live probes) and rejected: harness
 * markers inherit through dispatch, so a codex delegate under claude carries
 * BOTH `CLAUDECODE=1` and `CODEX_THREAD_ID` (and `AI_AGENT` keeps the outer
 * claude value), leaving no static priority that is correct in both
 * directions. Process ancestry has no such ambiguity.
 */

import type { HarnessName } from './types.ts'

/**
 * Classify one `ps -o command=` line as a harness process, or undefined.
 *
 * Matching is anchored on argv[0]'s basename so harness names appearing in
 * ARGUMENTS never match — the ancestry of a nested dispatch contains dianjiang
 * command lines whose task text may mention any vendor (e.g.
 * `bun .../dianjiang run --harness codex -m ... "fix the claude adapter"`),
 * and claude's shell wrapper sources `~/.claude/shell-snapshots/...`.
 *
 * codex exception: under pnpm/npm the binary is a platform executable like
 * `.../@openai/codex/0.145.0-darwin-arm64/.../codex-aarch64-apple-darwin`
 * (basename `codex-*`), fronted by a node shim whose ARGS carry the package
 * path — so `@openai/codex` anywhere in the command also counts (verified via
 * a live probe of a codex delegate's ancestry).
 */
export function matchHarnessCommand(command: string): HarnessName | undefined {
  const argv0 = command.trim().split(/\s+/)[0] ?? ''
  const base = argv0.split('/').pop() ?? ''
  if (base === 'claude') return 'claude'
  if (base === 'grok') return 'grok'
  if (base === 'codex' || base.startsWith('codex-')) return 'codex'
  if (command.includes('@openai/codex')) return 'codex'
  return undefined
}

/** Nearest-wins over an ancestor command chain (ordered self → root). */
export function detectCallerFromChain(commands: string[]): HarnessName | undefined {
  for (const command of commands) {
    const match = matchHarnessCommand(command)
    if (match) return match
  }
  return undefined
}

/**
 * Collect ancestor command lines by walking ppid via `ps` (works on both
 * darwin and procps). Best-effort: stops at the root, an unreadable pid, or
 * `maxDepth` hops (a bounded walk can never hang the CLI on a weird tree).
 */
export function ancestorCommands(startPid = process.ppid, maxDepth = 20): string[] {
  const commands: string[] = []
  let pid = startPid
  for (let i = 0; i < maxDepth && pid > 1; i++) {
    let stdout: string
    try {
      const proc = Bun.spawnSync(['ps', '-o', 'ppid=,command=', '-p', String(pid)])
      if (proc.exitCode !== 0) break
      stdout = proc.stdout.toString()
    } catch {
      break
    }
    const match = /^\s*(\d+)\s+(.*)$/.exec(stdout.trimEnd())
    if (!match) break
    commands.push(match[2] ?? '')
    pid = Number(match[1])
  }
  return commands
}

/** Detect the caller harness from this process's ancestry, if any. */
export function detectCaller(): HarnessName | undefined {
  return detectCallerFromChain(ancestorCommands())
}
