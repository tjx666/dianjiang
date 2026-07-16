/**
 * Public library surface. The CLI (src/cli) is one frontend over this; a GUI
 * is another. Nothing in here prints or exits — callers own the presentation.
 */

export * from './types.ts'
export * from './paths.ts'
export * from './registry.ts'
export * from './store.ts'
export * from './runner.ts'
export * from './setup.ts'
export * from './adapters/index.ts'
