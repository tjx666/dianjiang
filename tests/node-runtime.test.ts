import { beforeAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageJsonPath = join(root, 'package.json')
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
  bin: { dianjiang: string }
  exports: { '.': { types: string; default: string } }
  files: string[]
  scripts: { prepack?: string }
  types?: string
}
const bin = join(root, packageJson.bin.dianjiang)

beforeAll(() => {
  const build = spawnSync('bun', ['run', 'build'], { cwd: root, encoding: 'utf8' })
  expect(build.status, build.stderr).toBe(0)
})

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

test('published package runs under Node from inside node_modules', () => {
  expect(packageJson.bin.dianjiang).toBe('dist/cli/bin.js')
  expect(packageJson.exports['.']).toEqual({
    types: './dist/core/index.d.ts',
    default: './dist/core/index.js',
  })
  expect(packageJson.types).toBe('./dist/core/index.d.ts')
  expect(packageJson.files).toEqual(['dist'])
  expect(packageJson.scripts.prepack).toBe('bun run build')

  expect(readFileSync(bin, 'utf8')).toStartWith('#!/usr/bin/env node')

  const installRoot = mkdtempSync(join(root, 'node_modules', '.dianjiang-install-'))
  try {
    const packageRoot = join(installRoot, 'node_modules', 'dianjiang')
    mkdirSync(packageRoot, { recursive: true })
    cpSync(join(root, 'dist'), join(packageRoot, 'dist'), { recursive: true })
    copyFileSync(packageJsonPath, join(packageRoot, 'package.json'))

    const installedBin = join(packageRoot, packageJson.bin.dianjiang)
    const help = spawnSync('node', [installedBin, '--help'], { encoding: 'utf8' })
    expect(help.status, help.stderr).toBe(0)
    expect(help.stdout).toContain('dianjiang')

    const imported = spawnSync(
      'node',
      ['--input-type=module', '--eval', "await import('dianjiang')"],
      { cwd: installRoot, encoding: 'utf8' },
    )
    expect(imported.status, imported.stderr).toBe(0)
  } finally {
    rmSync(installRoot, { recursive: true, force: true })
  }
})
