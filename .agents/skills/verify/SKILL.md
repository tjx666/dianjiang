---
name: verify
description: Verify dianjiang CLI changes end-to-end by driving the real command surface against an isolated DIANJIANG_HOME, including minimal-cost live harness calls.
---

# Verifying dianjiang

dianjiang is a CLI that dispatches real (paid) AI coding-agent CLIs. Verification
must (a) isolate all state and (b) keep live AI calls minimal-cost.

## Handle

No build step. Run the CLI directly:

```bash
bun run src/cli/index.ts <command>
```

## Isolation — ALWAYS

- `DIANJIANG_HOME=$(mktemp -d)/home` on every command — never touch `~/.dianjiang`.
- `setup` writes to `$HOME/.claude/CLAUDE.md`, `$HOME/.codex/AGENTS.md`,
  `$HOME/.grok/AGENTS.md` — only ever run it with `HOME=<tempdir>`.

## Cost rules for live calls

Prompt is always a single sentence like `"Reply with exactly: OK"`. Cheapest
paths per harness:

- grok: `run --harness grok -m grok-composer-2.5-fast "..."` (no effort support)
- claude: `run --harness claude --model sonnet --effort low "..."`
- codex: `run --harness codex --model gpt-5.4-mini "..."`

## Standard flow (copy-paste base)

```bash
T=$(mktemp -d) && mkdir -p $T/home $T/work $T/fakehome
DJ="bun run src/cli/index.ts"
DIANJIANG_HOME=$T/home $DJ config init
DIANJIANG_HOME=$T/home $DJ config harnesses          # 3x installed:true expected
DIANJIANG_HOME=$T/home $DJ run --harness grok -m grok-composer-2.5-fast "Reply with exactly: OK" --cwd $T/work
DIANJIANG_HOME=$T/home $DJ resume <runId> "What word did I ask for? Just that word."
DIANJIANG_HOME=$T/home $DJ run --harness grok -m grok-composer-2.5-fast "Reply with exactly: D-OK" --cwd $T/work --detach
DIANJIANG_HOME=$T/home $DJ status <runId>            # poll until != running
DIANJIANG_HOME=$T/home $DJ result <runId>
DIANJIANG_DEPTH=2 DIANJIANG_HOME=$T/home $DJ run --harness grok -m grok-composer-2.5-fast "hi"   # expect exit 2
HOME=$T/fakehome DIANJIANG_HOME=$T/home $DJ setup    # run twice; diff = idempotent
```

## Worth probing

- Kill a worker (`pid` is in sqlite: `sqlite3 $T/home/runs.sqlite
  "select pid from runs where run_id='<id>'"`), then `status` — must reconcile
  to `failed`, not hang at `running`.
- **Kill the sync `dianjiang run` CLI process mid-run** — the job must survive
  (every run executes in a detached worker) and `result <runId>` must recover
  the completed outcome afterwards.
- `resume` of a failed/running run must fail fast (no silent fresh session).
- Unknown agent / bad `--harness` / missing runId → JSON error, exit 1.

## Gotchas learned live

- grok's `-p` is `--single <PROMPT>`: the prompt is the flag's VALUE. claude's
  `-p` is a boolean with a positional prompt. Don't "fix" one to match the other.
- codex `harnessSessionId` ≠ runId (parsed from `thread.started` events);
  claude/grok equal runId (pre-injected `--session-id`).
- Every run (sync included) has a worker log at `$DIANJIANG_HOME/logs/<runId>.log`
  containing the full harness stdout/stderr stream — the run's artifact path.
  The parsed result lives in sqlite, not the log.
