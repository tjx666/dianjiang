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
| Caller-relative bindings | `callers.<harness>.agents.<name>` sparse binding overrides; `setup` stamps `--caller <harness>` into each vendor's file (see "Caller-relative agents") |

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

Recalibrated 2026-07-17 (靖哥). The core bindings are not absolute values —
each is a **rule over the caller**, compiled into base + sparse `callers`
overrides/excludes:

- `implement` — **removed** (2026-07-17). Every caller implements natively
  with its own subagents; same-vendor dispatch through dianjiang adds a
  process hop and a fresh context for nothing (same subscription, so no quota
  offload either). It was also the only agent violating the admission
  principle above (neither cross-vendor perspective nor unique capability).
  The steer lives in `callers.claude.append` instead: "use your built-in
  subagents (model: opus)".
- `review` / `second-opinion` — **always a different vendor than the caller**
  (avoid same-model blind spots); review runs xhigh, second-opinion runs the
  other vendor's flagship with effort graded per model — fable stays at high
  (expensive; high already delivers), gpt-5.6-sol goes to xhigh.
- `explore` — **fixed cheap+fast grok**, excluded when the caller IS grok
  (no point round-tripping to yourself).

Cost/strength rationale (靖哥, 2026-07-17):

- **fable is reserved for low-frequency, judgment-heavy roles** — second
  brain (`second-opinion`) and visual taste (`design-frontend`). It is too
  expensive for `review`, which is high-frequency; review gets the neighbor
  vendor's cheaper flagship (gpt-5.6-sol or opus 4.8) at xhigh instead.
- Per-caller character: claude and codex implement with their own flagship;
  grok is fast and has native X search but weak reasoning, so it borrows
  fable to plan/consult and codex gpt-5.6-sol to review, and never gets
  `implement`/`explore`.
- opus 4.6 has the best prose style (文风) → `rewrite-prompt`.

| Agent | Base binding | claude caller | codex caller | grok caller |
|---|---|---|---|---|
| `review` | codex / gpt-5.6-sol / xhigh | (base) | claude / opus / xhigh | (base) |
| `second-opinion` | claude / fable / high | codex / gpt-5.6-sol / xhigh | (base) | (base) |
| `explore` | grok / grok-4.5 / high | (base) | (base) | excluded |

Base = the compiled view for the most common callers (and callerless human
runs). Values recalibrate by feel — that is exactly what config-time
compilation is for. Earlier iterations (2026-07-16/17) had review on grok-4.5,
explore on grok-composer-2.5-fast (fast but padded answers with narration —
see Open questions), and an `implement` agent bound to the caller's own
flagship before it was removed outright.

### Capability agents (added 2026-07-16, 靖哥)

Beyond opinion/perspective agents, agents can expose a **capability** unique to
one harness. Added (roster now 6 of the ~8 cap after `implement` was removed;
all verified live):

| Agent | Harness / model / effort | Capability |
|---|---|---|
| `search-twitter` | grok / grok-4.5 / low | grok's native live X/Twitter search tools (verified headless: returns real tweet URLs) |
| `design-frontend` | claude / fable / high | strongest visual/UX taste for front-end work |
| `rewrite-prompt` | claude / claude-opus-4-6[1m] / — | 1M-context ingestion before rewriting prompts/instructions |

Capability agents need no `callers` overrides: they're picked for what they can
do, not whose opinion they carry (self-vendor dispatch is fine).

Blocked: `generate-image` via codex `gpt-image-2` — codex rejects image models
under ChatGPT-subscription auth (`The 'gpt-image-2' model is not supported when
using Codex with a ChatGPT account`, HTTP 400, verified 2026-07-16). Needs
API-key auth on codex, or a different image-capable harness; parked until 靖哥
decides.

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
instruction files. Each target is rendered with its own caller stamped into
the documented commands (`dianjiang run --caller codex <agent> "<task>"` in
`~/.codex/AGENTS.md`, etc.) so per-caller binding overrides resolve without
env sniffing; the base template below shows the caller-less form:

```markdown
<!-- dianjiang:begin -->
## Delegation roster (dianjiang)

`dianjiang` dispatches self-contained tasks to other coding-agent CLIs.
dianjiang agents are separate from your built-in subagents. Pick one by task
shape — never pick harnesses or models on your own judgment:

| Agent | Use when | Don't use when |
|---|---|---|
| review | …rendered from each agent's useWhen… | …dontUseWhen… |

Rules:
- `dianjiang run <agent> "<task>"` blocks until done and prints one JSON object; read `.result`.
- Write tasks self-contained: background, file paths, acceptance criteria, expected output.
- Follow up in the same session with `dianjiang resume <runId> "<message>"`.
- For tasks likely over ~5 minutes, add `--detach`, then poll `dianjiang status <runId>`
  and fetch `dianjiang result <runId>` when completed.
- If your command times out or is killed, the run keeps going in the background —
  recover it any time with `dianjiang result <runId>`.
- If the human explicitly names a vendor, harness, or model, relay their choice:
  `dianjiang run --harness <claude|codex|grok> [-m <model>] [--effort <level>] "<task>"`,
  or override an agent preset with `-m`/`--effort`. Relay only — the choice stays the human's.
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
      "name": "review",
      "useWhen": "you want a second opinion on a diff from a different vendor",
      "dontUseWhen": "a quick lint/style pass your own subagents already cover",
      "harness": "codex",
      "model": "gpt-5.6-sol",
      "effort": "xhigh",
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

## Caller-relative agents (`callers` namespace)

Some agents are defined *relative to* the caller, not absolutely: `review`'s
definition is literally "a different vendor than the implementer and caller",
and `second-opinion` from a codex/gpt-5.6-sol session back to gpt-5.6-sol is
self-consultation. The name and useWhen are stable semantics; only the binding
should vary per caller.

Decision (2026-07-16):

- Config gains a `callers.<harness>` namespace. `callers.<h>.agents.<name>`
  sparsely overrides that agent's binding for that caller. An override
  replaces the whole binding (`{harness, model?, effort?}`, harness required —
  no field merging, so a cross-vendor override can never inherit another
  vendor's model name). `name`/`useWhen`/`dontUseWhen`/`instructions` always
  come from the base agent: semantics stay single-source.
- Caller identification: no env sniffing (no stable cross-vendor contract;
  breaks on vendor upgrades). `setup` already writes one file per vendor, so
  it stamps `--caller <harness>` into each file's documented run command; the
  AI relays it verbatim. An omitted flag degrades gracefully to the base
  roster.
- Deliberately named `callers`, not `callerOverrides`: per-caller settings
  beyond bindings are anticipated — roster subsets (`exclude`), inject path
  (`target`), extra template rules, per-caller `maxDepth`/`disabled`.
  Containers named "override" always grow non-override siblings.
- `exclude` (added 2026-07-17, 靖哥): `callers.<h>.exclude: string[]` hides an
  agent from that caller entirely — omitted from its injected roster and from
  `config agents --caller <h>`, rejected at dispatch with a clear error. A name
  in both `exclude` and that caller's `agents` overrides is a validation error.
  First user: grok excludes `explore` (see Roster v1 rules).
- `append` (added 2026-07-17, 靖哥): `callers.<h>.append: string` — free-form
  markdown appended to that caller's injected roster block, after the rules
  list, inside the managed markers. For guidance about the caller's own
  behavior that is not a dianjiang agent. First user: claude's block defaults
  its built-in subagents to the opus model for execution work instead of
  delegating implementation through dianjiang (this replaced the removed
  `implement` agent).
- Not persisted: RunRecord stores the resolved harness/model/effort, not the
  caller; `resume` inherits the resolved binding from the original run.

Rejected:

- Full per-caller rosters (`rosters: {claude: [...], codex: [...], ...}`) —
  duplicates useWhen prose ×3, breaks single-source.
- Relative semantics in config (`harness: "not-caller"` + fallback chains) —
  moves runtime decisions back into the machine; violates human-compiles.
- Env sniffing (`CLAUDECODE=1` and friends) — undocumented vendor behavior.

## Ops & UX batch (decided 2026-07-16)

- **setup selection**: `setup` scans installed harnesses (`harnessVersions()`)
  and interactively multi-selects targets (@clack/prompts) when stdin is a
  TTY; non-TTY or explicit flags (`--all`, `--harness a,b`) keep the
  machine-readable one-JSON contract. Default selection = installed only
  (previously: always all three).
- **setup --remove**: strips the managed block from selected targets;
  files without a block report `skipped`.
- **Interactive agent editor**: `config agents --edit` — pick an agent, edit
  harness/model/effort via validated select prompts, add/delete agents; prose
  fields (useWhen/dontUseWhen/instructions) open `$EDITOR`. Writes back with
  jsonc-parser's `modify`/`applyEdits` so JSONC comments survive. Scope
  decided by 靖哥: bindings + add/delete; callers overrides stay file-edited.
- **Operational log**: JSONL at `~/.dianjiang/dianjiang.log` — dispatch /
  spawn / exit / reconcile / error events, runId-correlated, append-only v1.
  Distinct from per-run harness stream logs (`logs/<runId>.log`).
- **Usage stats**: adapters extract what each harness reports — tokens
  (input/output/cache), turns, and cost. Decision (靖哥): record
  harness-reported values only, no built-in price tables — claude reports
  `total_cost_usd`; codex/grok report tokens but no cost, so cost stays null
  there (subscription pricing makes estimates fictional anyway). Stored on
  the run row (lazy ALTER TABLE migration); `dianjiang stats` aggregates per
  agent (runs, success, duration, tokens, turns, cost).

## Model/effort discovery (decided 2026-07-16)

The question that matters for dispatch is "what strings does THIS harness CLI,
under THIS auth, accept" — and only the local CLI knows. Two dogfood-proven
counterexamples: `gpt-image-2` exists in every external registry yet codex
under ChatGPT-subscription auth 400s it; opus 4.6 exists but claude only
accepts the `claude-opus-4-6[1m]` spelling. Layered sources:

1. **Live CLI enumeration** where it exists — only grok today (`grok models`,
   works even unauthenticated). Adapters expose optional `listModels()`.
2. **Curated in-adapter snapshot** (`knownModels` + `modelsVerifiedAt`) for
   claude/codex, refreshed alongside smoke/dogfooding. Per-model effort sets
   live here (codex `ultra` only on 5.6-sol/terra; grok-composer none) and
   drive validation: known model → validate against its effort set; unknown
   model → permissive pass-through (new models ship weekly; never hard-reject).
   This subsumes the old GROK_NO_EFFORT_MODEL special case.
3. **Third-party registries** (models.dev — opencode's registry; LiteLLM's
   model-prices JSON) — reserved as *enrichment* for the deferred
   progressive-disclosure `config models` (objective fields: context window,
   list price; human adds subjective scores). If adopted: explicit `--refresh`
   fetch, cached locally with a fetch date, never a runtime network dependency.
4. **Scraping official docs HTML** — rejected: no contract, most fragile, and
   answers the same question as layer 3 less reliably.

Surface: `config harnesses` gains `efforts` + `models` (with
`source: live | curated` and `verifiedAt`) per harness — no new command.
Watch item: codex clearly has an internal model-metadata table ("Model
metadata for `x` not found" on bogus models); if a future codex exposes it,
layer 2 retires for codex.

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

- Progressive-disclosure model metrics (deferred by 靖哥, 2026-07-16): keep the
  default agent-driven, but a `config models` subcommand could list
  harnesses × models × human-set rankings plus a prose "how to apply", so the
  AI can choose informedly when no preset fits. This is a middle point the
  original "config-time aid vs runtime prompt" dichotomy missed; evidence the
  read-a-human-table variant works: theo's CLAUDE.md scorecard
  (x.com/theo/status/2072482460122964067, agent-PR discard rate 50%→0).
  Revisit once dogfooding shows how often raw mode is actually needed.
- grok-composer includes narration in `result` (e.g. "Reading runner.ts to
  find why…" before the answer). Fix candidates: instructions-level ("output
  only the answer") or adapter-level (take last message if the event stream
  distinguishes narration). Observed in first dogfood dispatch.
- Does `grok-composer-2.5-fast` actually hold up for `explore`? Needs real-use
  calibration; cut the agent if it underperforms.
- Config schema validation: zod vs hand-rolled checks (minor).
- Project-level config override — deferred to phase 2.
