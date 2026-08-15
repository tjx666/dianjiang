#!/usr/bin/env node
/**
 * Published entry. TypeScript on purpose: Node ≥22.18 strips types natively,
 * and Bun runs `.ts` directly. npm shims invoke this with node; `bunx` with bun.
 */
await import('./index.ts')
