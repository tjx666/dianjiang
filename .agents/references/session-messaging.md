# External-session messaging

Decision and verification record, 2026-09-11. User-facing commands are rendered
by `dianjiang skill`; this document records architecture and evidence.

## Contract

- Address the native `(harness, sessionId)` independently of dianjiang runs.
  An endpoint identifies the native backend; a session UUID is not a socket.
- Keep `SessionAdapter` separate from the dispatch `HarnessAdapter`. Discovery,
  observation, and live delivery differ from starting a detached worker.
  The core accepts an injected adapter registry and does not print or exit.
- Carry sender harness, native session UUID, message UUID, target, and timestamp
  in every message. Attribution does not confer user approval. The CLI checks
  harness ancestry, but an explicit sender UUID is attribution, not authentication.
- Persist receipts in SQLite. Claim message identity and a per-target unique
  lock in one transaction. Identical retries return the existing receipt;
  changed content under the same ID is rejected. Never blindly retry an
  ambiguous write, including on Codex: its native deduplication scope across
  process restarts is not established by the live tests.
- Release abandoned locks on process death or a changed process start time.
  Do not use a wall-clock lease that could let a paused sender write after its
  replacement. If process identity cannot be queried, retain a live lock.
- `accepted` means native admission, `written` only means socket write, and
  `resumed` means a detached worker was started. None proves model consumption.
  `unknown` is a retained ambiguity, not a successful delivery or an offline state.
- Wake is explicit, requires an observed stopped target and its working directory,
  and stores the external resume UUID in the run. Reserve the message UUID as the
  run UUID before dispatch so an interrupted caller can find the worker. Reject
  run-ID conflicts and overlapping dianjiang wakes. No fresh-session fallback.
- No terminal keystroke injection, new broker, inbox polling daemon, or automatic
  reply loop. Messages are one-way; the recipient may send a new attributed message.

## Native capability matrix

Verified installations: Claude Code 2.1.267, Codex CLI 0.154.0,
Grok 1.0.25 (`f7e67d6988e2`), macOS. Other versions and Windows are not live-tested.

| Harness | Discovery/state | Live transport | Admission boundary |
| --- | --- | --- | --- |
| Claude | `claude agents --json`; process live, busy/idle indistinguishable | Native peer inbox Unix socket, between tool calls | Complete write only; inbound policy can hold/refuse |
| Codex | Existing app-server `thread/list`, `thread/read` | WebSocket over Unix; `thread/queue/add` or `turn/steer` with expected turn ID | Correlated RPC result and native message ID |
| Grok | Existing leader `_x.ai/sessions/list` with nested result envelope | ACP stdio proxy to that leader; `session/load`, `session/prompt` | Matching queue entry/running prompt; steer additionally requests versioned queue interjection |

Codex uses its existing control socket, not a new app-server or a raw JSONL
connection. Bun's `ws` shim ignores a custom Unix connection factory; explicitly
load the installed `ws` implementation, with packaged Node and Bun smoke coverage.
Grok checks leader reachability before invoking its auto-start-capable proxy.
A leader disappearance between probe and proxy startup remains a native CLI race;
an empty/new leader cannot pass the resident-target check or receive the message.

Claude endpoint overrides are checked against the target PID's open Unix sockets
and current-user ownership. Frames also carry `session_id`, which native Claude
validates. Do not forge `from_mode` to evade `crossSessionInbound` policy. Windows
named-pipe authentication is deliberately unsupported rather than reading tokens.

Grok queue promotion is best-effort. Keep the helper alive for the matching
`_x.ai/session/interjection` event; without it, report only confirmed queue
admission. A turn-boundary race can cause next-turn processing. The live test
confirmed reception while a task was underway, but did not establish a guaranteed
same-turn delivery for every timing. Do not claim that stronger guarantee.

## Scope of stopped and unknown

Claude can establish stopped from absent native process registration plus local
history in the original cwd. Codex `notLoaded` and Grok nonresident are scoped to
the selected native backend. They cannot prove the absence of a different private
backend loading the same history. Callers must select the owning backend and stop
other owners before waking. An unreachable backend is `unknown`; this implementation
does not silently resume it. Standalone older CLIs without a shared native endpoint
cannot receive live messages through these adapters. Listing is also native-scoped,
not a global inventory of every historical conversation.

## Prior art and sources

- [Claude cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging):
  peer socket, discovery, and inbound policy. Native binary help confirmed the
  user frame and optional session target; controlled live delivery verified it.
- [Codex app-server](https://developers.openai.com/codex/app-server/) and
  [0.154.0 transport](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server-transport/src/transport/unix_socket.rs):
  native ownership and WebSocket framing. Generated installed experimental schema
  plus the upstream TUI queue implementation established exact request fields.
- [Grok headless scripting](https://docs.x.ai/build/cli/headless-scripting): ACP entry.
  Installed binary's embedded protocol docs and live probes established wire names,
  double-wrapped roster, and notification IDs. The
  [open-grok implementation mirror](https://github.com/mweinbach/open-grok)
  supplied additional hypotheses about queue promotion and driver transfer; it is
  secondary evidence, not an official guarantee about the installed binary.
- [OpenCode server](https://opencode.ai/docs/server/): borrow a separate native
  server/transport boundary. Starting another server does not attach to a TUI's
  existing session owner.
- [maxto/agent-mux](https://github.com/maxto/agent-mux): stable reply addresses and
  file handoffs are useful; tmux typing and cooperative pull are a different
  transport with different delivery guarantees.
- [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail): borrow
  explicit identities, durable records, and coordination. A mailbox needs a
  cooperating receiver and does not itself inject into arbitrary live CLIs.
- [OpenCode Multiplexer](https://github.com/joeyism/opencode-multiplexer): discovered
  external processes and managed sendable sessions are distinct capabilities.
- [buildoak/agent-mux](https://github.com/buildoak/agent-mux): retain dianjiang's
  existing detached resume model rather than inventing a second worker lifecycle.

## Claude battle and verification

Two design rounds and an implementation review with Claude Sonnet challenged
the transport and receipt boundaries. Adopted: separate session adapters,
transactional claims, conservative ambiguity, external resume persistence,
PID-incarnation checks, endpoint ownership, and run-ID conflict rejection.
Rejected: treating connection refusal as proof of stopped; treating all RPC errors
as pre-write rejection; assuming the old run-based resume addresses arbitrary
native sessions; automatic Codex retries without verifying deduplication lifetime.

Live probes used an isolated `DIANJIANG_HOME`, temporary work directory, and only
new controlled native sessions. Claude and Codex each answered FIRST then SECOND
in the original UUID; Grok answered SECOND in its original UUID. Codex accepted
steering during a tool and answered STEERED. Grok accepted a message during a task
and emitted STEERED, with only queue admission confirmed. The real CLI woke a
stopped external Claude conversation and returned AWAKENED in the same UUID.
Stopped Codex/Grok wake uses the existing native resume adapters; that combination
was not separately live-tested. Unit fixtures cover detached external resume,
identity preservation, concurrency, dead/reused PIDs, ambiguity, and native framing.
Package smoke exercises Unix WebSocket delivery from the installed npm artifact
under both Node and Bun.
