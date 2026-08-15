import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bin = fileURLToPath(new URL('../src/cli/bin.ts', import.meta.url))

function runNode(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync('node', [bin, ...args], { encoding: 'utf8', env })
}

test('node executes the published bin (`--help`)', () => {
  const proc = runNode(['--help'])
  expect(proc.status).toBe(0)
  expect(proc.stdout).toContain('dianjiang')
})

test('node can init config and print the skill doc', () => {
  const home = mkdtempSync(join(tmpdir(), 'dianjiang-node-'))
  try {
    const env = { ...process.env, DIANJIANG_HOME: home }
    const init = runNode(['config', 'init'], env)
    expect(init.status).toBe(0)
    const skill = runNode(['skill'], env)
    expect(skill.status).toBe(0)
    expect(skill.stdout).toContain('<agent name="review">')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
