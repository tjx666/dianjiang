---
name: design
description: dianjiang's design source of truth — frozen terminology (agent/roster/harness/adapter), decided trade-offs, current roster, harness invocation matrix, and open questions. Read before making architecture, naming, or CLI-surface decisions.
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
| Permissions | All-YOLO, no sandbox/permission management (phase 1) |
| Architecture | Core as a library; CLI is a thin frontend (GUI-ready later) |
| Run storage | Structured local store (SQLite): run id → agent, harness, model, session id, duration, exit code, final message |
| Session strategy | dianjiang generates the UUID; injects via `--session-id` for claude/grok; parses `thread.started.thread_id` from `--json` for codex. External API exposes one unified run id. |
| Prompt injection | `setup` command writes a managed block (`<!-- dianjiang:begin/end -->`) into all three global instruction files |
| Recursion guard | `DIANJIANG_DEPTH` env var; refuse beyond depth limit. Injected prompt also states "when you are the delegate, do not re-delegate." |
| Attribution | Credit agent-mux in README |
| Config | Single `~/.dianjiang/config.jsonc` (JSONC over JSON5: VS Code-native tsconfig-style editing, parse with `jsonc-parser`). Agents inline; split into `agents/*.md` only if instructions grow long. Project-level override deferred to phase 2. |
| Background runs | Every run executes in a detached `_exec` worker; sync mode just waits for it ("job done is holy", credit agent-mux — the job survives caller timeout/death, and callers are AI agents whose shell tools cap at ~10 min). `--detach` returns immediately; block on `result --wait [--timeout <sec>]` (store-polling, since the worker isn't waitpid-able; bounded, so it never reintroduces the caller-shell-timeout problem that motivated `--detach` — never teach callers to sleep-and-poll), instant snapshot via `status`. Artifact path: full harness stdout/stderr tees to `logs/<runId>.log` progressively. Injected rules teach AI callers to ALWAYS dispatch detached: the earlier "detach if likely >5 min" branch was removed (2026-07) because LLM duration estimates are unreliable, so any rule keyed on them mis-routes; detach costs one extra command and covers every case. Sync run remains for human use. How each caller WAITS is a per-caller collection strategy rendered from setup.ts's `COLLECTION_STRATEGY` map — see "Injected roster template". |
| Execution contract freeze | Resolved agent `instructions` are stamped into the RunRecord at dispatch; the detached worker and every `resume` read the record, never the live config — a config edit or removal can no longer mutate an in-flight or resumable run's contract (2026-07) |
| Defaults upgrade | `config sync-defaults` — exact-match migration: a managed field upgrades only when its current value equals a known historical default (anything else is a user customization and is kept); removed defaults are dropped under the same rule; `--dry-run` previews. Never a blind overwrite; `config init --force` remains the nuke-and-regenerate escape hatch |
| CLI framework | citty (TS-first, lightweight); core stays dependency-light (`bun:sqlite` built-in) |
| Extension point | `adapter`, not `provider`. Ecosystem rule: "provider" = another chat/completions endpoint (AI SDK, LiteLLM, opencode); "adapter" = a full external runtime with its own event stream and session lifecycle (agent-mux "harness adapters", terminal-bench adapters, LobeHub agent adaptor). Custom harness support later = public `HarnessAdapter` interface. |
| Caller-relative bindings | `callers.<harness>.agents.<name>` sparse binding overrides; `setup` stamps `--caller <harness>` into each vendor's file (see "Caller-relative agents") |

## Command surface

```
dianjiang run <agent> "task" [--detach]  # agent-based dispatch (primary path)
dianjiang run --harness codex -m gpt-5.5 "task"  # raw escape hatch
dianjiang resume <run-id> "follow-up"
dianjiang status <run-id>                # instant snapshot of a run (never blocks)
dianjiang result <run-id> [--wait [--timeout <sec>]]  # fetch final JSON; --wait blocks until done
dianjiang setup                          # inject agent roster into global instruction files
dianjiang stats                          # per-agent usage aggregation
dianjiang config ...                     # agent CRUD + harnesses self-check (config harnesses --json)
```

## Agent registry

Agents are the product. Config fields per agent:

- `name` — verb/deliverable-style, not job titles (`review`,
  `rewrite-prompt`) — job titles force the AI to do a second inference hop
  ("which job owns this task?")
- `description` — split into `useWhen` / `dontUseWhen`, written for the
  delegating AI. This drives delegation accuracy more than the name does.
- `harness` / `model` / `effort` — the human's compiled scorecard decision
- `instructions` — optional agent system prompt, kept short. Cross-vendor
  baseline: prepend to user prompt; claude can use `--append-system-prompt`.

Keep the roster small (currently 5; hard cap ~8). Overlapping agents
reintroduce the scorecard's selection-paralysis problem in a new costume.

### Roster

Admission principle: a dianjiang agent earns its place by being
**cross-vendor** (a different vendor's perspective, or offloading onto a
different subscription's quota) or by exposing a **capability** unique to one
harness. Notably, `implement` is NOT an agent: every caller implements
natively with its own subagents — same-vendor dispatch through dianjiang adds
a process hop and a fresh context for nothing (same subscription, so no quota
offload either). The fable-session steer ("act as an orchestrator; delegate
execution to opus subagents, keep plan/verification") lives in
`callers.claude.prepend`, not in the roster.

Opinion/perspective agents are **rules over the caller**, compiled into base
bindings + sparse `callers` overrides/excludes:

- `review` / `second-opinion` — **always a different vendor than the caller**
  (avoid same-model blind spots); review runs xhigh, second-opinion runs the
  other vendor's flagship with effort graded per model — fable stays at high
  (expensive; high already delivers), gpt-5.6-sol goes to xhigh.

`review` deliberately ships **no `instructions`** (decided 2026-07-21 after
three dogfood rounds of injected review contracts, each corrected by the
human). The arc, kept so it is not re-attempted: Round 1 (~$18): a task
saying "focused review, only actionable findings" still expanded into the
delegate harness's native review culture, so a scope + output contract moved
into `instructions`. Round 2 (run 741f0350, $24): a "Deep review…" task ran
the target repo's `deep-review` skill; successive fixes — a blanket
prohibition on review skills, an artificial `review-mode: comprehensive`
marker, then telling the delegate to read project review skills first — were
each rejected: a repo's review skill speaks for the repo (a deep-review
request landing on it is expected, not a collision), and hunting `.claude/`/
`.agents/` layouts over-fits a generic dispatch tool to one repo. Round 3:
even the slimmed project-agnostic contract (focused-by-default, findings-only
output, snapshot, resume discipline) was judged redundant — every clause is
something the CALLER should author in the task for its specific situation,
and the roster rules already demand self-contained tasks with acceptance
criteria and expected output. The settled **division of authority**: the
CALLER owns the project's review standards (it reads the repo's review
guidance/skills and encodes what matters into the task — or runs the
project's review process itself and dispatches its subagent-shaped chunks
through dianjiang); the TASK is the delegate's entire briefing: scope,
process, output shape. dianjiang adds no review-specific words of its own.
`instructions` stays a supported per-agent field (search-twitter and
rewrite-prompt ship one-liners; users may add their own), and whatever it
resolves to is frozen into the RunRecord at dispatch, so a config edit
mid-run or before a resume cannot change a run's execution contract. If
delegates ignore task-stated scope again, fix it caller-side (task-writing
guidance), not by re-growing delegate injection. Still no CLI mode flag —
the agent/task boundary is where such routing belongs. First such caller-side
fix (2026-07-22): `review`'s `useWhen` tells the caller to explicitly state
the review depth in the task — a deep comprehensive review (slow on large
diffs) or a quick single-pass scan — after depth-unstated dispatches on large
repos defaulted into slow full reviews. This lives in the roster description
(caller guidance), not in `instructions` (delegate injection), so the
no-instructions decision stands.

Removed: `explore` (was fixed cheap+fast grok) — every caller harness ships a
built-in explore/search subagent, so cross-vendor dispatch added only a
process hop; a 2026-07 A/B against claude's built-in Explore showed parity on
accuracy with worse citations (no line numbers) and narration noise. Quota
offload alone didn't justify a roster slot (admission principle).

Cost/strength rationale:

- **fable is reserved for low-frequency, judgment-heavy roles** — second
  brain (`second-opinion`) and visual taste (`design-frontend`). It is too
  expensive for `review`, which is high-frequency; review gets the neighbor
  vendor's cheaper flagship (gpt-5.6-sol or opus 4.8) at xhigh instead.
- Per-caller character: claude and codex implement with their own flagship;
  grok is fast and has native X search but weak reasoning, so it borrows
  fable to plan/consult and codex gpt-5.6-sol to review.
- opus 4.6 has the best prose style (文风) → `rewrite-prompt`.

| Agent | Base binding | claude caller | codex caller | grok caller |
|---|---|---|---|---|
| `review` | codex / gpt-5.6-sol / xhigh | (base) | claude / opus / xhigh | (base) |
| `second-opinion` | claude / fable / high | codex / gpt-5.6-sol / xhigh | (base) | (base) |

Base = the compiled view for the most common callers. Values recalibrate by
feel — that is exactly what config-time compilation is for.

### Capability agents

Capability agents expose something only one harness can do; they need no
`callers` binding overrides — they're picked for what they can do, not whose
opinion they carry (self-vendor dispatch is fine; the one exception is
`design-frontend`, excluded for the claude caller — it IS claude/fable, so
that caller's own subagents cover it). All verified live:

| Agent | Harness / model / effort | Capability |
|---|---|---|
| `search-twitter` | grok / grok-4.5 / high | grok's native live X/Twitter search tools (verified headless: returns real tweet URLs) |
| `design-frontend` | claude / fable / high | strongest visual/UX taste for front-end work |
| `rewrite-prompt` | claude / claude-opus-4-6[1m] / — | 1M-context ingestion before rewriting prompts/instructions |

Blocked: `generate-image` via codex `gpt-image-2` — codex rejects image models
under ChatGPT-subscription auth (HTTP 400). Needs API-key auth on codex, or a
different image-capable harness; parked.

Locally verified model/effort space:

- claude: aliases `fable` / `opus` / `sonnet` (haiku unconfirmed on this
  machine); effort `low | medium | high | xhigh | max`
- codex: `gpt-5.6-sol/-terra/-luna`, `gpt-5.5`, `gpt-5.4(-mini)`,
  `gpt-5.3-codex-spark`; effort superset `low…ultra`, but `max`/`ultra` only on
  the 5.6 series and `ultra` only on sol/terra (adapters must validate per model)
- grok: `grok-4.5` (effort `low | medium | high`), `grok-composer-2.5-fast`
  (no effort flag)

## Injected roster template

`setup` renders the managed block from config into all three global
instruction files. Each target is rendered with its own caller stamped into
the documented commands (`dianjiang run --caller codex <agent> "<task>"` in
`~/.codex/AGENTS.md`, etc.) so per-caller binding overrides resolve without
env sniffing.

The block body is **XML**, not a markdown heading + table: a column-padded
table is unreadable as raw text (these files are edited in plain editors, not
previewed); an injected heading interferes with the host file's own outline (a
wrapper element removes the problem entirely); and XML sectioning is what LLM
prompting guides recommend anyway. The HTML-comment begin/end markers are the
inject/remove contract, independent of the body format.

**Single source of truth is `renderRosterBlock()` in `src/core/setup.ts`** —
this document deliberately carries no verbatim template copy (it drifted from
the code twice); the full per-caller renders are pinned by snapshot tests in
`tests/setup.test.ts`. Structure, in order:

1. `<caller-guidance>` — the caller's `prepend`, when set (wrapped so
   caller-behavior guidance is not read as a dianjiang usage rule).
2. Intro — presets are fixed, model notes in `<use-when>` only calibrate
   dispatch-worthiness, dianjiang agents are separate from built-in subagents.
3. One `<agent>` element per non-excluded agent: `<use-when>` +
   `<dont-use-when>` (element omitted when unset), caller-relative
   description overrides applied via `resolveAgent`.
4. `<rules>` — always-dispatch-detached; ONE collect rule that embeds the
   caller-specific collection strategy from the hardcoded
   `COLLECTION_STRATEGY` map (claude: background shell + push notification;
   codex: immediate `spawn_agent` waiter, foreground only as capability
   fallback; grok: background task + push notification; caller-less renders a
   neutral bounded-foreground line). Wait behavior is harness-intrinsic
   capability knowledge, so it lives in code, not config — and each caller
   gets exactly one authoritative strategy (restructured 2026-07 after the
   generic "block on result --wait" rule + codex-append-exception layout made
   codex block 300s in the foreground before spawning its waiter). Then:
   `.status` discipline, self-contained tasks, resume, preset overrides only
   relay the human's explicit in-request choice, `DIANJIANG_DEPTH` guard.
5. The caller's `append`, when set (user extension point; no built-in default
   uses it anymore).

## `run` JSON output

stdout carries exactly one JSON object; harness process logs go to stderr.

```jsonc
{
  "runId": "d7f3…",          // dianjiang's unified id (= pre-injected session uuid for claude/grok)
  "agent": "review",
  "harness": "codex",
  "model": "gpt-5.6-sol",
  "effort": "xhigh",
  "status": "completed",      // completed | failed | detached | running (status/result on an unfinished run)
  "exitCode": 0,
  "durationMs": 183000,
  "result": "…final assistant message…",
  "harnessSessionId": "…",    // codex thread_id; equals runId for claude/grok
  "cwd": "/path/to/project",
  "startedAt": "…",
  "finishedAt": "…"
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
      "useWhen": "you want an independent cross-vendor code review of a diff",
      "dontUseWhen": "a quick lint/style pass your own subagents already cover",
      "harness": "codex",
      "model": "gpt-5.6-sol",
      "effort": "xhigh",
      "instructions": "…optional, keep short…"
    }
  ],
  "callers": {
    "claude": {
      "agents": { "second-opinion": { "harness": "codex", "model": "gpt-5.6-sol", "effort": "xhigh" } },
      "exclude": ["design-frontend"],
      "prepend": "…caller-behavior guidance rendered at the top of claude's block…"
    }
  }
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

- `callers.<h>.agents.<name>` sparsely overrides that agent's binding for that
  caller. The `{harness, model?, effort?}` trio replaces the whole binding
  (harness required — no field merging, so a cross-vendor override can never
  inherit another vendor's model name). `useWhen`/`dontUseWhen` may optionally
  be overridden per caller for caller-relative descriptions (model-strength
  notes only make sense relative to the caller's own model), each falling back
  to the base agent when omitted; `name`/`instructions` stay single-source.
- Caller identification: no env sniffing (no stable cross-vendor contract;
  breaks on vendor upgrades). `setup` already writes one file per vendor, so
  it stamps `--caller <harness>` into each file's documented run command; the
  AI relays it verbatim. Agent dispatch without `--caller` is a hard ERROR
  (changed 2026-07 from graceful degradation): dianjiang is AI-caller-only —
  there is no human dispatch path to protect — and a dropped flag silently
  produced a same-vendor `review`, defeating the agent's purpose. Dogfood
  evidence: codex omitted the stamped flag on its first real dispatch. Raw
  `--harness` runs still take no `--caller` (they bypass the registry).
- Deliberately named `callers`, not `callerOverrides`: per-caller settings
  beyond bindings are anticipated — inject path (`target`), extra template
  rules, per-caller `maxDepth`/`disabled`. Containers named "override" always
  grow non-override siblings.
- `callers.<h>.exclude: string[]` hides an agent from that caller entirely —
  omitted from its injected roster and from `config agents --caller <h>`,
  rejected at dispatch with a clear error. A name in both `exclude` and that
  caller's `agents` overrides is a validation error. User: claude excludes
  `design-frontend` (it IS claude/fable — the claude caller gains nothing
  over its own subagents).
- `callers.<h>.prepend: string` — free-form markdown rendered at the TOP of
  that caller's block (right after the wrapper tag, before the intro), wrapped
  in `<caller-guidance>` so it reads as caller behavior, not a dianjiang rule.
  For scoping rules the caller should read before pattern-matching the roster;
  block-start position also gets higher LLM attention. User: claude's
  fable steer — a **role statement**, not just a model binding: when the
  session model is fable, act as an orchestrator (keep planning,
  decomposition, tricky debugging, and verification; delegate execution to
  opus subagents), mirroring ai-rules' "Model Delegation" section. The
  model qualifier matters because the steer exists to offload the expensive
  fable, not to escalate an opus/sonnet session's subagents. The steer also
  states a delegation granularity threshold (delegate coherent, independently
  verifiable chunks; keep small in-context edits) so the orchestrator doesn't
  re-litigate "is this too small to delegate" every session. Don't open with
  prohibitions against non-options (e.g. "do not route implementation through
  dianjiang" — the roster has no implement agent; prohibiting a non-option is
  noise that implies the option exists).
- `callers.<h>.append: string` — same, but rendered after the rules. Today a
  pure user extension point: the codex waiter-subagent guidance that shipped
  here first moved into setup.ts's structural `COLLECTION_STRATEGY` (2026-07)
  after dogfood showed the free-text append losing to the generic wait rule —
  the caller followed the earlier, more prominent "block on result --wait"
  bullet, sat 300s in the foreground, and only then remembered the waiter.
  Operative wait rules must be structural and singular, not appended prose.
- Not persisted: RunRecord stores the resolved harness/model/effort, not the
  caller; `resume` inherits the resolved binding from the original run.

Rejected:

- Full per-caller rosters (`rosters: {claude: [...], codex: [...], ...}`) —
  duplicates useWhen prose ×3, breaks single-source.
- Relative semantics in config (`harness: "not-caller"` + fallback chains) —
  moves runtime decisions back into the machine; violates human-compiles.
- Env sniffing (`CLAUDECODE=1` and friends) — undocumented vendor behavior.

## Ops & UX

- **setup selection**: `setup` scans installed harnesses (`harnessVersions()`)
  and interactively multi-selects targets (@clack/prompts) when stdin is a
  TTY; non-TTY or explicit flags (`--all`, `--harness a,b`) keep the
  machine-readable one-JSON contract. Default selection = installed only.
- **setup --remove**: strips the managed block from selected targets;
  files without a block report `skipped`.
- **Interactive agent editor**: `config agents --edit` — pick an agent, edit
  harness/model/effort via validated select prompts, add/delete agents; prose
  fields (useWhen/dontUseWhen/instructions) open `$EDITOR`. Writes back with
  jsonc-parser's `modify`/`applyEdits` so JSONC comments survive. Scope:
  bindings + add/delete; `callers` stays file-edited.
- **Operational log**: JSONL at `~/.dianjiang/dianjiang.log` — dispatch /
  spawn / exit / reconcile / error events, runId-correlated, append-only.
  Distinct from per-run harness stream logs (`logs/<runId>.log`).
- **Usage stats**: adapters extract what each harness reports — tokens
  (input/output/cache), turns, and cost. Harness-reported values only, no
  built-in price tables — claude reports `total_cost_usd`; codex/grok report
  tokens but no cost, so cost stays null there (subscription pricing makes
  estimates fictional anyway). Stored on the run row (lazy ALTER TABLE
  migration); `dianjiang stats` aggregates per agent (runs, success, duration,
  tokens, turns, cost).

## Model/effort discovery

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
3. **Third-party registries** (models.dev — opencode's registry; LiteLLM's
   model-prices JSON) — reserved as *enrichment* for the deferred
   progressive-disclosure `config models` (objective fields: context window,
   list price; human adds subjective scores). If adopted: explicit `--refresh`
   fetch, cached locally with a fetch date, never a runtime network dependency.
4. **Scraping official docs HTML** — rejected: no contract, most fragile, and
   answers the same question as layer 3 less reliably.

Surface: `config harnesses` reports `efforts` + `models` (with
`source: live | curated` and `verifiedAt`) per harness — no separate command.
Watch item: codex clearly has an internal model-metadata table ("Model
metadata for `x` not found" on bogus models); if a future codex exposes it,
layer 2 retires for codex.

## Harness capability matrix (verified locally)

| | claude 2.1.211 | codex 0.144.4 | grok 0.2.101 |
|---|---|---|---|
| One-shot | `claude -p "..."` | `codex exec "..."` | `grok -p "..."` |
| Model / effort | `--model` + `--effort` | `-m` + `-c model_reasoning_effort=...` | `-m` + `--reasoning-effort` |
| Session id | `--session-id <uuid>` (pre-inject) | parse `thread.started.thread_id` from `--json` | `--session-id <uuid>` (pre-inject) |
| Resume | `claude -p --resume <id>` | `codex exec resume <id>` | `grok -p --resume <id>` |
| YOLO | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--always-approve` |
| Final message | `--output-format json`, `.result` | `-o <file>` (easiest) or scan JSONL | `--output-format json` |
| Global instructions | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | `~/.grok/AGENTS.md` |
| Agent-side background shell | `run_in_background` + completion notification (push) | `exec_command` returns a session id; poll/continue via `write_stdin` (pull, no push wake). Push exists one layer up: `spawn_agent` completion notifies the parent (waiter pattern, see `callers.codex.append`) | `run_terminal_command` `background: true` → task_id + completion notification (push) |

Notes:
- Grok's claude-compat is OFF in local config — it will not read `~/.claude/*`;
  `setup` must write all three files.
- Codex renamed `session.created`/`session_id` → `thread.started`/`thread_id`
  across versions. Adapters must version-sniff. Vendor CLIs break things often —
  this is the moat **only if** we detect breakage first: per-adapter smoke tests
  + a daily CI cron against latest CLI versions.

## Prior art

Crowded space; two camps, each missing half of this idea:

- **In-Claude plugins/MCP**: openai/codex-plugin-cc (28.8k★), claude-octopus
  (3.8k★, has Grok), claude-delegator, cc-suite — delegate from inside a Claude
  session, not a neutral top-level CLI.
- **Standalone router CLIs**: awslabs/cli-agent-orchestrator (894★), climux,
  AIMUX, nexus-agents — score/route but target claude/codex/gemini/opencode,
  no Grok Build CLI.
- **Concept namesake**: LobeHub "Heterogeneous Agents"
  ([RFC-153](https://github.com/lobehub/lobehub/discussions/13927)) —
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

- Progressive-disclosure model metrics (deferred): keep the default
  agent-driven, but a `config models` subcommand could list
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
- Config schema validation: zod vs hand-rolled checks (minor).
- Project-level config override — deferred to phase 2.
- Run-level git snapshot (evaluated 2026-07 after a 26-min review raced a
  changing worktree): recording HEAD + staged/unstaged diff hashes at dispatch
  and re-checking at completion would let dianjiang flag review-target drift
  mechanically in the RunReport. Deferred for now: the CLI could only report
  drift, not prevent it; non-git cwds and non-code agents (search-twitter)
  don't want the git calls; and the delegate already has a shell — so the
  review `instructions` make the delegate self-report the reviewed SHA and any
  mid-review drift. Promote to a RunRecord field if self-report proves
  unreliable in dogfood.
- Run lifecycle commands, proposed from codex dogfood feedback, awaiting the
  human's go-ahead: `dianjiang logs <runId>` (snapshot of the existing
  `logs/<runId>.log` stream; `--follow` human-only — codex never detaches from
  streaming commands, openai/codex#5948) and `dianjiang cancel <runId>` (kill
  the worker's process group via the stored pid).
