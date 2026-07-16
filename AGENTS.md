# dianjiang — agent instructions

Cross-vendor coding-agent dispatch CLI (bun + TypeScript). It dispatches a
self-contained task to Claude Code / Codex / Grok behind a named **agent**
preset. See README.md for the user-facing story.

## Commands

```sh
bun install
bun run check      # tsc --noEmit
bun test           # unit tests (no live AI calls)
bun run smoke      # harness --version self-check
bun run src/cli/index.ts <command>   # run the CLI without linking
```

## Architecture

- `src/core/` — the library. Nothing here prints or exits; `src/core/index.ts`
  is the public surface (a future GUI is a second frontend over it).
  - `types.ts` — the contract (AgentConfig, DispatchSpec, HarnessAdapter, RunRecord…)
  - `adapters/` — one module per harness CLI (claude / codex / grok)
  - `runner.ts` — dispatch; every run (sync included) executes in a detached
    `_exec` worker so a dying caller never kills the job
  - `store.ts` — bun:sqlite run store; `registry.ts` — JSONC config;
    `setup.ts` — roster injection into vendor global instruction files
- `src/cli/` — citty frontend; every machine-readable command prints exactly
  one JSON value on stdout. Exit codes: 0 ok, 1 error, 2 recursion guard.

## Rules

- Read `.agents/skills/design/SKILL.md` before architecture, naming, or
  CLI-surface changes — terminology (agent/roster/harness/adapter) is frozen
  and trade-offs are recorded there.
- Verify changes end-to-end with `.agents/skills/verify/SKILL.md`. Hard
  isolation rules: always set `DIANJIANG_HOME=<tempdir>`; only run `setup`
  under a fake `HOME`; live AI calls must use the cheapest paths listed there.
- Adapter quirks are documented in-code (grok's `-p` takes the prompt as its
  value; codex parses sessionId from JSONL events). Don't "unify" them.
- Comments in English, JSDoc preferred over line comments.
