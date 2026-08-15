# dianjiang (点将)

[![npm](https://img.shields.io/npm/v/dianjiang.svg)](https://www.npmjs.com/package/dianjiang)
[![license](https://img.shields.io/npm/l/dianjiang.svg)](LICENSE)

> Summon the right coding agent.

You already pay for Claude Code, Codex, and Grok. They still work like strangers.

`dianjiang` lets one of them dispatch a task to another — behind a **named agent**. The caller picks `review` or `search-twitter`. It never picks a model.

```
you ──► Claude
           │  dianjiang run review "…"
           ▼
         Codex
```

## Install

Needs [Bun](https://bun.sh) ≥ 1.2 and the CLIs you want to dispatch: [`claude`](https://docs.anthropic.com/en/docs/claude-code), [`codex`](https://github.com/openai/codex), [`grok`](https://github.com/xai-org/grok-build).

```sh
npm install -g dianjiang
dianjiang config init
```

Drop this skill on every harness (`~/.agents/skills/dianjiang/SKILL.md`):

```markdown
---
name: dianjiang
description: Dispatch a self-contained task to Claude Code / Codex / Grok behind a named agent. Use on 点将, "delegate this to codex", or when a cross-vendor opinion is wanted.
---

Run `dianjiang skill` and follow the doc it prints.
```

Then, in any of the three:

> 点将，让 review 看一下这个 diff。

Roster, rules, and how to collect a run live in `dianjiang skill` — not here.

Inspired by [agent-mux](https://github.com/buildoak/agent-mux). MIT.
