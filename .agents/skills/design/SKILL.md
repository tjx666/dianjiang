---
name: design
description: dianjiang's design source of truth — frozen terminology (agent/roster/harness/adapter), decided trade-offs, roster v1, harness invocation matrix, and open questions. Read before making architecture, naming, or CLI-surface decisions.
---

# dianjiang (点将)

> 点将 — in classical Chinese military drama, the commander reviews the roster and
> names the general best suited for the mission. `dianjiang` lets an AI agent do
> exactly that: pick a named agent from a roster and dispatch the right CLI
> (Claude Code / Codex / Grok) behind it.

A unified CLI for waking up coding-agent CLIs. Cross-vendor "custom agents":
the caller (usually another AI) picks an **agent**, not a model.

## Positioning

- **A tool, not an orchestrator** (credit: [agent-mux](https://github.com/buildoak/agent-mux)
  for this framing). dianjiang dispatches one run and gets out of the way; loops,
  fan-out, and judgment stay in the calling agent.
- The core insight: asking an AI to pick model + effort per call via a scorecard
  is unreliable (LLMs are bad at runtime weight arithmetic). Instead, the human
  "compiles" model choices into **named agents** at config time; the AI only
  picks an agent by task shape — the thing LLMs are actually good at.
- Scorecard (cost / speed / intelligence / writing / frontend taste) survives as
  a **config-time decision aid** for the human, not a runtime prompt for the AI.

## Decided

| Decision | Choice |
|---|---|
| Language | TypeScript (bun runtime; `bun build --compile` for single binary later) |
| Phase 1 permissions | All-YOLO, no sandbox/permission management |
| Architecture | Core as a library; CLI is a thin frontend (GUI-ready later) |
| Run storage | Structured local store (SQLite): run id → agent, harness, model, session id, duration, exit code, final message |
| Session strategy | dianjiang generates the UUID; injects via `--session-id` for claude/grok; parses `thread.started.thread_id` from `--json` for codex. External API exposes one unified run id. |
| Prompt injection | `setup` command writes a managed block (`<!-- dianjiang:begin/end -->`) into all three global instruction files |
| Recursion guard | `DIANJIANG_DEPTH` env var; refuse beyond depth limit. Injected prompt also states "when you are the delegate, do not re-delegate." |
| Attribution | Credit agent-mux in README |
| Config | Single `~/.dianjiang/config.jsonc` (JSONC over JSON5: VS Code-native tsconfig-style editing, parse with `jsonc-parser`). Agents inline; split into `agents/*.md` only if instructions grow long. Project-level override deferred to phase 2. |
| Background runs | Every run executes in a detached `_exec` worker; sync mode just waits for it ("job done is holy", credit agent-mux — the job survives caller timeout/death, and callers are AI agents whose shell tools cap at ~10 min). `--detach` returns immediately; poll via `status`, fetch via `result`. Artifact path: full harness stdout/stderr tees to `logs/<runId>.log` progressively. |
| CLI framework | citty (TS-first, lightweight); core stays dependency-light (`bun:sqlite` built-in) |
| Extension point | `adapter`, not `provider`. Ecosystem rule: "provider" = another chat/completions endpoint (AI SDK, LiteLLM, opencode); "adapter" = a full external runtime with its own event stream and session lifecycle (agent-mux "harness adapters", terminal-bench adapters, LobeHub agent adaptor). Custom harness support later = public `HarnessAdapter` interface. |

## Command surface (phase 1)

```
dianjiang run <agent> "task" [--detach]  # agent-based dispatch (primary path)
dianjiang run --harness codex -m gpt-5.5 "task"  # raw escape hatch
dianjiang resume <run-id> "follow-up"
dianjiang status <run-id>                # poll a detached run
dianjiang result <run-id>                # fetch final JSON of a finished run
dianjiang setup                          # inject agent roster into global instruction files
dianjiang config ...                     # agent CRUD + harnesses self-check (config harnesses --json)
```

## Agent registry

Agents are the product. Config fields per agent:

- `name` — verb/deliverable-style, not job titles (`implement`, `review`,
  `fix-tests`, `write-docs`, `verify-ui`) — job titles force the AI to do a
  second inference hop ("which job owns this task?")
- `description` — split into `useWhen` / `dontUseWhen`, written for the
  delegating AI. This drives delegation accuracy more than the name does.
- `harness` / `model` / `effort` — the human's compiled scorecard decision
- `instructions` — optional agent system prompt, kept short. Cross-vendor
  baseline: prepend to user prompt; claude can use `--append-system-prompt`.

Keep the roster small (v1: 4 agents; hard cap ~8). Overlapping agents
reintroduce the scorecard's selection-paralysis problem in a new costume.

### Roster v1

Cut `fix-tests` / `write-docs` — highest overlap with the caller's own subagent
mechanisms (e.g. Claude Code custom agents already cover mechanical fix/doc
work). dianjiang agents earn their place by being **cross-vendor**: a different
vendor's perspective, or offloading onto a different subscription's quota.

| Agent | Harness / model / effort | Use when |
|---|---|---|
| `implement` | codex / gpt-5.6-sol / high | a well-scoped feature or module can be built independently of the caller's conversation context |
| `review` | grok / grok-4.5 / high | second opinion on a diff; vendor differs from both the implementer (codex) and the typical caller (claude) — avoids same-model blind spots |
| `second-opinion` | codex / gpt-5.6-sol / ultra | consult-only, no code changes: hard debugging hypotheses, architecture/design review; max firepower (`ultra` exists only on gpt-5.6-sol/terra) |
| `explore` | grok / grok-composer-2.5-fast / — (no effort support) | broad codebase search / research / summarization, cheap and fast |

Values are initial guesses to be recalibrated by feel — that is exactly what
config-time compilation is for. `explore` is the borderline one (overlaps with
callers' built-in search subagents); first to cut if it underperforms.

Locally verified model/effort space (2026-07-16):

- claude: aliases `fable` / `opus` / `sonnet` (haiku unconfirmed on this
  machine); effort `low | medium | high | xhigh | max`
- codex: `gpt-5.6-sol/-terra/-luna`, `gpt-5.5`, `gpt-5.4(-mini)`,
  `gpt-5.3-codex-spark`; effort superset `low…ultra`, but `max`/`ultra` only on
  the 5.6 series and `ultra` only on sol/terra (adapters must validate per model)
- grok: `grok-4.5` (effort `low | medium | high`), `grok-composer-2.5-fast`
  (no effort flag)

## Injected roster template

`setup` renders this managed block from config into all three global
instruction files:

```markdown
<!-- dianjiang:begin -->
# Delegation roster (dianjiang)

`dianjiang` dispatches self-contained tasks to other coding-agent CLIs.
dianjiang agents are separate from your built-in subagents. Pick one by task
shape — never pick harnesses or models yourself:

| Agent | Use when | Don't use when |
|---|---|---|
| implement | …rendered from each agent's useWhen… | …dontUseWhen… |

Rules:
- `dianjiang run <agent> "<task>"` blocks until done and prints one JSON object; read `.result`.
- Write tasks self-contained: background, file paths, acceptance criteria, expected output.
- Follow up in the same session with `dianjiang resume <runId> "<message>"`.
- For tasks likely over ~5 minutes, add `--detach`, then poll `dianjiang status <runId>`
  and fetch `dianjiang result <runId>` when completed.
- If your command times out or is killed, the run keeps going in the background —
  recover it any time with `dianjiang result <runId>`.
- If `DIANJIANG_DEPTH` is set in your environment, you ARE a delegate — never call dianjiang.
<!-- dianjiang:end -->
```

## `run` JSON output

stdout carries exactly one JSON object; harness process logs go to stderr.

```jsonc
{
  "runId": "d7f3…",          // dianjiang's unified id (= pre-injected session uuid for claude/grok)
  "agent": "implement",
  "harness": "codex",
  "model": "gpt-5.6-sol",
  "effort": "high",
  "status": "completed",      // completed | failed | detached
  "exitCode": 0,
  "durationMs": 183000,
  "result": "…final assistant message…",
  "harnessSessionId": "…",    // codex thread_id; equals runId for claude/grok
  "cwd": "/path/to/project",
  "startedAt": "2026-07-16T10:00:00Z",
  "finishedAt": "2026-07-16T10:03:03Z"
}
```

- Failure: same schema, `status: "failed"`, `result` carries the tail of stderr.
- `--detach`: returns immediately with `status: "detached"`, `result: null`;
  `dianjiang result <runId>` serves the full object once finished.
- `resume` reuses the same schema.

## Config

Single `~/.dianjiang/config.jsonc`; runs metadata in `~/.dianjiang/runs.sqlite`.

```jsonc
{
  "maxDepth": 2,
  "agents": [
    {
      "name": "implement",
      "useWhen": "a well-scoped feature or module can be built independently",
      "dontUseWhen": "the task needs the caller's conversation context",
      "harness": "codex",
      "model": "gpt-5.6-sol",
      "effort": "high",
      "instructions": "…optional, keep short…"
    }
  ]
}
```

- JSONC over JSON5: VS Code edits it natively (tsconfig-style comments +
  trailing commas, zero setup); JSON5's extras (unquoted keys, line
  continuations) buy little here. Parse with `jsonc-parser`.
- Agents stay inline while instructions are short; if they grow long, split
  into `~/.dianjiang/agents/*.md` (frontmatter + markdown body) behind the same
  registry API.

## Harness capability matrix (verified locally, 2026-07-16)

| | claude 2.1.211 | codex 0.144.4 | grok 0.2.101 |
|---|---|---|---|
| One-shot | `claude -p "..."` | `codex exec "..."` | `grok -p "..."` |
| Model / effort | `--model` + `--effort` | `-m` + `-c model_reasoning_effort=...` | `-m` + `--reasoning-effort` |
| Session id | `--session-id <uuid>` (pre-inject) | parse `thread.started.thread_id` from `--json` | `--session-id <uuid>` (pre-inject) |
| Resume | `claude -p --resume <id>` | `codex exec resume <id>` | `grok -p --resume <id>` |
| YOLO | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--always-approve` |
| Final message | `--output-format json`, `.result` | `-o <file>` (easiest) or scan JSONL | `--output-format json` |
| Global instructions | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | `~/.grok/AGENTS.md` |

Notes:
- Grok's claude-compat is OFF in local config — it will not read `~/.claude/*`;
  `setup` must write all three files.
- Codex renamed `session.created`/`session_id` → `thread.started`/`thread_id`
  across versions. Adapters must version-sniff. Vendor CLIs break things often —
  this is the moat **only if** we detect breakage first: per-adapter smoke tests
  + a daily CI cron against latest CLI versions.

## Prior art (researched 2026-07-16)

Crowded space; two camps, each missing half of this idea:

- **In-Claude plugins/MCP**: openai/codex-plugin-cc (28.8k★), claude-octopus
  (3.8k★, has Grok), claude-delegator, cc-suite — delegate from inside a Claude
  session, not a neutral top-level CLI.
- **Standalone router CLIs**: awslabs/cli-agent-orchestrator (894★), climux,
  AIMUX, nexus-agents — score/route but target claude/codex/gemini/opencode,
  no Grok Build CLI.
- **Concept namesake**: LobeHub "Heterogeneous Agents"
  ([RFC-153](https://github.com/lobehub/lobehub/discussions/13927), 2026-05) —
  external CLI harnesses (Claude Code / Codex) as first-class agents behind one
  shared interface, one adapter per harness. Same concept, GUI-embedded; their
  terminology stack (agent / harness / adapter) matches ours exactly. dianjiang
  is the neutral-CLI + injected-roster take on the same idea.
- **Protocol watch**: ACP (Agent Client Protocol) is becoming the standard for
  this layer (opencode, AgentMux, LobeHub roadmaps). If claude/codex/grok ship
  ACP support, a single ACP adapter could replace per-CLI version-sniffing.
- **Closest match**: [buildoak/agent-mux](https://github.com/buildoak/agent-mux)
  (35★, Go) — neutral CLI, grok as first-class adapter, resumable sessions with
  predeclared UUIDs, `config engines --json` self-check, markdown worker
  profiles (their half-step toward named agents). Steal the design, not the code.
- **Unoccupied**: agent registry + setup-injected roster across all three
  vendors' global instruction files.

## Open questions

- Does `grok-composer-2.5-fast` actually hold up for `explore`? Needs real-use
  calibration; cut the agent if it underperforms.
- Config schema validation: zod vs hand-rolled checks (minor).
- Project-level config override — deferred to phase 2.
