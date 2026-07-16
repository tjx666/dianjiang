#!/usr/bin/env bun
/**
 * Per-adapter smoke test. Vendor CLIs break things often; this is the moat only
 * if we detect breakage first.
 *
 *   bun run scripts/smoke.ts          # zero-cost: just `--version` each harness
 *   bun run scripts/smoke.ts --live   # additionally send one tiny real prompt
 *
 * Without --live it NEVER makes an AI call.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harnessVersions } from '../src/core/adapters/index.ts'
import { dispatch } from '../src/core/runner.ts'
import type { DianjiangConfig, HarnessName } from '../src/core/types.ts'

/** Minimal one-shot per harness through the full adapter + runner path. */
async function liveCheck(): Promise<void> {
  // Isolate live runs in a throwaway home so we don't pollute the real store.
  process.env.DIANJIANG_HOME = mkdtempSync(join(tmpdir(), 'dianjiang-smoke-'))
  const config: DianjiangConfig = { maxDepth: 2, agents: [{ name: 'noop', useWhen: 'smoke', harness: 'claude' }] }

  const cases: { harness: HarnessName; model: string; effort?: string }[] = [
    { harness: 'claude', model: 'sonnet', effort: 'low' },
    { harness: 'codex', model: 'gpt-5.4-mini' },
    { harness: 'grok', model: 'grok-composer-2.5-fast' },
  ]

  for (const c of cases) {
    process.stderr.write(`\n[live] ${c.harness} (${c.model})...\n`)
    try {
      const report = await dispatch(
        {
          harness: c.harness,
          model: c.model,
          effort: c.effort,
          task: 'Reply with exactly: OK',
          cwd: process.cwd(),
          detach: false,
        },
        config,
      )
      process.stdout.write(`${JSON.stringify({ harness: c.harness, status: report.status, result: report.result }, null, 2)}\n`)
    } catch (err) {
      process.stderr.write(`[live] ${c.harness} failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
}

const live = process.argv.includes('--live')
process.stderr.write('Harness versions:\n')
process.stdout.write(`${JSON.stringify(harnessVersions(), null, 2)}\n`)
if (live) await liveCheck()
