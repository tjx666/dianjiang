#!/usr/bin/env node
/**
 * Source entry for the published CLI. `prepack` bundles it to JavaScript because
 * Node deliberately refuses to strip TypeScript from packages in node_modules.
 */
await import('./index.ts')
