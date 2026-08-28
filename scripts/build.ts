import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const sourceRoot = join(root, 'src')
const outdir = join(root, 'dist')

/**
 * npm installs the package under node_modules, where Node intentionally refuses
 * TypeScript type stripping. Publish JavaScript bundles while keeping declared
 * npm dependencies external so both Node and Bun resolve their native runtimes.
 */
await rm(outdir, { recursive: true, force: true })
const result = await Bun.build({
  entrypoints: [join(sourceRoot, 'cli/bin.ts'), join(sourceRoot, 'core/index.ts')],
  root: sourceRoot,
  outdir,
  target: 'node',
  format: 'esm',
  packages: 'external',
})

if (!result.success) {
  for (const message of result.logs) console.error(message)
  process.exit(1)
}

const declarations = Bun.spawnSync({
  cmd: ['bunx', '--bun', 'tsc', '--project', join(root, 'tsconfig.build.json')],
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
})
if (!declarations.success) process.exit(declarations.exitCode)

/**
 * Declaration emit preserves the source `.ts` specifiers. Rewrite only relative
 * declaration imports to `.js`, which TypeScript resolves to sibling `.d.ts`
 * files and which matches the published JavaScript module graph.
 */
const relativeTypeScriptSpecifier = /(['"])(\.\.?\/[^'"]+)\.ts\1/g
for await (const relativePath of new Bun.Glob('**/*.d.ts').scan({ cwd: outdir })) {
  const path = join(outdir, relativePath)
  const declaration = await readFile(path, 'utf8')
  await writeFile(path, declaration.replace(relativeTypeScriptSpecifier, '$1$2.js$1'))
}
