# dianjiang (点将)

> 点将 (diǎn jiàng) — in classical Chinese military drama, the commander reviews
> the roster and names the general best suited for the mission.

`dianjiang` is a neutral, top-level CLI that dispatches a self-contained task to
the right coding-agent CLI — Claude Code, Codex, or Grok — behind a **named
agent** you picked at config time. The caller (usually another AI) picks an
agent by task shape; it never juggles models or effort levels at runtime.

**A tool, not an orchestrator.** dianjiang dispatches one run and gets out of the
way; loops, fan-out, and judgment stay with the calling agent.

## Concepts

| Term | Meaning |
|---|---|
| **agent** | A named, human-compiled preset: harness + model + effort + optional instructions (e.g. `review`, `explore`). The product. |
| **roster** | The small set of agents in `config.jsonc` (v1: 4, hard cap ~8). |
| **harness** | An underlying coding-agent CLI: `claude`, `codex`, or `grok`. |
| **adapter** | The module that adapts one harness (its flags, event stream, session lifecycle) to dianjiang's contracts. |
| **run** | One dispatched execution, addressed by a unified `runId` and persisted in SQLite. |

An agent's binding can be overridden per caller via the `callers` namespace in
`config.jsonc` — e.g. `review` rebinds to a different vendor depending on which
harness is calling. `setup` stamps `--caller <harness>` into each vendor's file.

## Install

```sh
bun install
bun link          # exposes `dianjiang` on your PATH
```

State lives in `~/.dianjiang/` (`config.jsonc` + `runs.sqlite`); override the
directory with `DIANJIANG_HOME`.

## Usage

```sh
# One-time: write a starter roster, then inject it into the global
# instruction files of all three vendors (~/.claude, ~/.codex, ~/.grok).
dianjiang config init
dianjiang setup

# Dispatch by agent (primary path) — blocks, prints one JSON object; read .result
dianjiang run explore "Find every call site of parseConfig across src/"

# Resolve an agent's binding relative to the caller (see `callers` in config).
# From a codex session, `review` rebinds off codex to another vendor.
dianjiang run --caller codex review "Review the diff in src/parser.ts"

# Raw escape hatch — bypass the registry
dianjiang run --harness codex -m gpt-5.6-sol "Refactor the parser"

# Long task: return immediately, then poll / fetch
dianjiang run review "review a large multi-file diff" --detach
dianjiang status <runId>
dianjiang result <runId>

# Follow up in the same harness session
dianjiang resume <runId> "also handle the error case"

# Inspect
dianjiang config agents
dianjiang config harnesses      # self-check: installed CLIs, versions, efforts + accepted models
dianjiang stats                 # per-agent usage: runs, success, duration, tokens, cost
dianjiang stats --agent review   # restrict to one agent
```

### Stats

`dianjiang stats` aggregates the run store per agent (raw `--harness` dispatches
group per harness), printing one JSON array: runs, completed/failed counts,
durations, and summed tokens/turns/cost. dianjiang records **only what each
harness reports** — no price tables, no estimation. Tokens and turns come from
whatever the harness prints; cost is harness-reported only: claude reports
`total_cost_usd`, so `costUsd` is populated for claude-backed groups and stays
`null` for codex and grok (their subscription pricing makes any estimate
fictional). A `null` token/cost field means "no run in that group reported it",
never a synthesized zero.

Every machine-readable command prints exactly one JSON value on stdout; harness
logs and human chatter go to stderr. Exit codes: `0` ok, `1` error/failed run,
`2` recursion-depth limit reached.

### Job done is holy

Every run — sync or `--detach` — executes in a detached worker (credit
agent-mux for the principle), so a caller timing out or dying never kills the
job. Recover any run later with `dianjiang result <runId>`. The full harness
output streams progressively to `~/.dianjiang/logs/<runId>.log` — every
dispatch has an artifact path.

### Recursion guard

dianjiang sets `DIANJIANG_DEPTH` in the environment of every harness it spawns
and refuses to dispatch once it reaches `maxDepth`. If `DIANJIANG_DEPTH` is set
in your environment, you are already a delegate — don't re-delegate.

## Acknowledgements

- [buildoak/agent-mux](https://github.com/buildoak/agent-mux) — design
  inspiration: a neutral CLI with predeclared session UUIDs, a `config`
  harness/engine self-check, and the "a tool, not an orchestrator" framing.
- LobeHub "Heterogeneous Agents"
  ([RFC-153](https://github.com/lobehub/lobehub/discussions/13927)) — external
  CLI harnesses as first-class agents behind one shared interface; the
  agent / harness / adapter terminology stack.

## License

MIT
