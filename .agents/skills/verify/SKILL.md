---
name: verify
description: Verify dianjiang CLI changes end-to-end by driving the real command surface against an isolated DIANJIANG_HOME, including minimal-cost live harness calls.
---

# Verifying dianjiang

dianjiang is a CLI that dispatches real (paid) AI coding-agent CLIs. Verification
must (a) isolate all state and (b) keep live AI calls minimal-cost.

## Handle

Run the CLI directly during source development:

```bash
bun run src/cli/index.ts <command>
```

Before publishing, run `bun run build`; npm's `prepack` lifecycle builds the
same JavaScript and declaration artifacts under `dist/`. Always run
`bun run test:package`, which packs and installs the tarball in a fresh temporary
npm project, then exercises the npm bin shim, a detached worker, both SQLite
runtimes, and the public library export. Source-only checks miss packaging
failures because Node refuses to execute TypeScript inside `node_modules`.

## Isolation — ALWAYS

- `DIANJIANG_HOME=$(mktemp -d)/home` on every command — never touch `~/.dianjiang`.

## Cost rules for live calls

Prompt is always a single sentence like `"Reply with exactly: OK"`. Cheapest
paths per harness:

- grok: `run --harness grok -m grok-4.6 --effort low "..."` (composer-fast was
  delisted 2026-07-28; check `grok models` if this fails)
- claude: `run --harness claude --model sonnet --effort low "..."`
- codex: `run --harness codex --model gpt-5.4-mini "..."`

## Standard flow (copy-paste base)

```bash
T=$(mktemp -d) && mkdir -p $T/home $T/work
DJ="bun run src/cli/index.ts"
DIANJIANG_HOME=$T/home $DJ config init
DIANJIANG_HOME=$T/home $DJ config harnesses          # 3x installed:true expected
DIANJIANG_HOME=$T/home $DJ run --harness grok -m grok-4.6 --effort low "Reply with exactly: OK" --cwd $T/work
DIANJIANG_HOME=$T/home $DJ resume <runId> "What word did I ask for? Just that word."
DIANJIANG_HOME=$T/home $DJ run --harness grok -m grok-4.6 --effort low "Reply with exactly: D-OK" --cwd $T/work --detach
DIANJIANG_HOME=$T/home $DJ status <runId>            # poll until != running
DIANJIANG_HOME=$T/home $DJ result <runId>
DIANJIANG_DEPTH=2 DIANJIANG_HOME=$T/home $DJ run --harness grok -m grok-4.6 --effort low "hi"   # expect exit 2
DIANJIANG_HOME=$T/home $DJ skill --caller codex      # plain-text doc; codex waiter strategy + stamped --caller codex
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

## Session reading (`dianjiang session`)

No live AI calls: these commands only read local harness stores. Two isolation
rules, because `DIANJIANG_HOME` does not cover them:

- Point the harness homes at fixtures — `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
  `GROK_HOME` — when a check would otherwise write anywhere near a real store.
  Readers never write, and codex's thread history is opened read-only, but a
  test that seeds fixtures must not seed them into `~/.codex`.
- Reading the REAL stores is fine and is the point of dogfooding: `session find
  "<branch>" --all`, then `read`, `search`, `read --around <entry-id>`. Check
  the response's `page.truncated` and `warnings` — a scan that stopped early or
  a session with abandoned branches must say so.

Worth probing: a session id that exists in no store (JSON error, exit 1);
`read --run <runId>` for a run whose harness session was never recorded (must
fail, not read a random session); a transcript whose last line is half-written
(must warn, not throw).

## Gotchas learned live

- grok's `-p` is `--single <PROMPT>`: the prompt is the flag's VALUE. claude's
  `-p` is a boolean with a positional prompt. Don't "fix" one to match the other.
- codex `harnessSessionId` ≠ runId (parsed from `thread.started` events);
  claude/grok equal runId (pre-injected `--session-id`).
- Every run (sync included) has a worker log at `$DIANJIANG_HOME/logs/<runId>.log`
  containing the full harness stdout/stderr stream — the run's artifact path.
  The parsed result lives in sqlite, not the log.
