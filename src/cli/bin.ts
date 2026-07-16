#!/usr/bin/env bun
/**
 * Bin entry: a runtime guard that fails with a helpful message when executed
 * by Node (e.g. Windows npm shims force node; `npx` too) instead of Bun. It
 * must not statically import the CLI — the real entry pulls in `bun:sqlite`,
 * which would crash Node during module resolution before this guard could run.
 */
if (typeof globalThis.Bun === 'undefined') {
  console.error('dianjiang requires the Bun runtime (https://bun.sh): install Bun, then run `bun install -g dianjiang`.')
  process.exit(1)
}
await import('./index.ts')
