import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  version: string
  bin: { dianjiang: string }
}
const temporaryRoot = mkdtempSync(join(tmpdir(), 'dianjiang-package-'))

function run(
  command: string,
  args: string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'> = {},
) {
  const shell = options.shell ?? (process.platform === 'win32' && command.endsWith('.cmd'))
  const result = spawnSync(command, args, { ...options, shell, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with ${result.status}:\n${result.stderr || result.stdout}`,
    )
  }
  return result
}

try {
  const packRoot = join(temporaryRoot, 'pack')
  const installRoot = join(temporaryRoot, 'install')
  const home = join(temporaryRoot, 'home')
  const work = join(temporaryRoot, 'work')
  const fakeBin = join(temporaryRoot, 'bin')
  mkdirSync(packRoot, { recursive: true })
  mkdirSync(work, { recursive: true })
  mkdirSync(fakeBin, { recursive: true })

  run('npm', ['pack', '--pack-destination', packRoot], { cwd: root })
  const tarball = join(packRoot, `${packageJson.name}-${packageJson.version}.tgz`)
  run('npm', ['install', '--prefix', installRoot, tarball, '--silent', '--no-package-lock'])

  const packageRoot = join(installRoot, 'node_modules', packageJson.name)
  const installedEntry = join(packageRoot, packageJson.bin.dianjiang)
  const shim = join(
    installRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'dianjiang.cmd' : 'dianjiang',
  )
  if (!readFileSync(installedEntry, 'utf8').startsWith('#!/usr/bin/env node')) {
    throw new Error('Published CLI entry lost its Node shebang')
  }

  run(shim, ['--help'])
  run('node', ['--input-type=module', '--eval', `await import('${packageJson.name}')`], {
    cwd: installRoot,
  })

  const fakeHarnessSource = "process.stdout.write(JSON.stringify({ result: 'PACKAGE_SMOKE_OK' }))\n"
  if (process.platform === 'win32') {
    writeFileSync(join(fakeBin, 'grok.js'), fakeHarnessSource)
    writeFileSync(join(fakeBin, 'grok.cmd'), '@node "%~dp0\\grok.js" %*\r\n')
  } else {
    const fakeHarness = join(fakeBin, 'grok')
    writeFileSync(fakeHarness, `#!/usr/bin/env node\n${fakeHarnessSource}`)
    chmodSync(fakeHarness, 0o755)
  }

  const env = {
    ...process.env,
    DIANJIANG_HOME: home,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
  }
  run(shim, ['config', 'init'], { env })
  const dispatched = run(
    shim,
    ['run', '--harness', 'grok', 'package smoke', '--cwd', work],
    { env },
  )
  const report = JSON.parse(dispatched.stdout) as { status?: string; result?: string }
  if (report.status !== 'completed' || report.result !== 'PACKAGE_SMOKE_OK') {
    throw new Error(`Installed worker dispatch failed: ${dispatched.stdout}`)
  }

  const bunDispatched = run(
    'bun',
    [installedEntry, 'run', '--harness', 'grok', 'package smoke with Bun', '--cwd', work],
    { env },
  )
  const bunReport = JSON.parse(bunDispatched.stdout) as { status?: string; result?: string }
  if (bunReport.status !== 'completed' || bunReport.result !== 'PACKAGE_SMOKE_OK') {
    throw new Error(`Installed Bun worker dispatch failed: ${bunDispatched.stdout}`)
  }

  run('bun', [installedEntry, 'stats'], { env })

  const consumer = join(installRoot, 'consumer.ts')
  writeFileSync(
    consumer,
    `import type { DianjiangConfig } from '${packageJson.name}'\nconst config: DianjiangConfig = { maxDepth: 1, agents: [] }\nvoid config\n`,
  )
  run(
    join(root, 'node_modules', '.bin', 'tsc'),
    [
      '--ignoreConfig',
      '--noEmit',
      '--module',
      'Preserve',
      '--moduleResolution',
      'bundler',
      '--target',
      'ESNext',
      consumer,
    ],
    { cwd: installRoot },
  )

  process.stdout.write(`Package smoke passed for ${packageJson.name}@${packageJson.version}\n`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
