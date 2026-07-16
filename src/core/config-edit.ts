/**
 * Comment-preserving edits to config.jsonc. A GUI would drive exactly these
 * functions, so they live in core (nothing here prints or exits).
 *
 * The pure `text -> text` functions are deliberately un-validated: an
 * interactive binding edit sets harness/model/effort field-by-field, and an
 * intermediate state can be momentarily invalid (e.g. after switching harness
 * to grok but before clearing an unsupported effort). Validation is therefore a
 * single round-trip through {@link parseConfig} at write time — `writeConfigText`
 * refuses to persist anything the loader would later reject, leaving the file
 * untouched on failure.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { applyEdits, type FormattingOptions, modify, parse as parseJsonc } from 'jsonc-parser'
import type { AgentConfig } from './types.ts'
import { configPath } from './paths.ts'
import { parseConfig } from './registry.ts'

/** Match `config init`'s 2-space, spaces-not-tabs JSONC style. */
const FORMATTING: FormattingOptions = { tabSize: 2, insertSpaces: true }

/**
 * Set (or, when `value` is `undefined`, remove) one field of `agents[index]`,
 * preserving surrounding comments and formatting. Pure: text in, text out.
 */
export function setAgentField(
  text: string,
  agentIndex: number,
  field: keyof AgentConfig,
  value: string | undefined,
): string {
  const edits = modify(text, ['agents', agentIndex, field], value, { formattingOptions: FORMATTING })
  return applyEdits(text, edits)
}

/** Append a new agent object to the `agents` array. Pure: text in, text out. */
export function appendAgent(text: string, agent: AgentConfig): string {
  const current = parseJsonc(text) as { agents?: unknown[] } | undefined
  const index = Array.isArray(current?.agents) ? current.agents.length : 0
  const edits = modify(text, ['agents', index], agent, {
    formattingOptions: FORMATTING,
    isArrayInsertion: true,
  })
  return applyEdits(text, edits)
}

/** Remove `agents[index]` from the array. Pure: text in, text out. */
export function removeAgent(text: string, agentIndex: number): string {
  const edits = modify(text, ['agents', agentIndex], undefined, { formattingOptions: FORMATTING })
  return applyEdits(text, edits)
}

/** Read the raw config file text (comments and all). */
export function readConfigText(): string {
  return readFileSync(configPath(), 'utf8')
}

/**
 * Validate `text` by round-tripping it through {@link parseConfig}, then write
 * it to the config path. Throws the validation error and leaves the file
 * untouched if the text would not load — so a rejected edit never corrupts the
 * config.
 */
export function writeConfigText(text: string): void {
  parseConfig(text, configPath())
  writeFileSync(configPath(), text)
}
