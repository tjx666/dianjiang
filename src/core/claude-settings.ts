/**
 * Privacy-safe snapshots of Claude Code's user settings.
 *
 * The settings file may contain credentials, hooks, or other private values,
 * so observability records only a content fingerprint plus the two routing
 * fields relevant to dianjiang's model/effort diagnosis. The file contents and
 * arbitrary key names never leave this module.
 */

import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ClaudeSettingsSnapshot {
  state: 'missing' | 'present' | 'unreadable'
  /** SHA-256 of the raw file bytes; present only when the file was readable. */
  fingerprint?: string
  sizeBytes?: number
  mtimeMs?: number
  /** Distinguishes in-place writes from atomic file replacement. */
  inode?: number
  /** Whether the readable file contained valid JSON. */
  jsonValid?: boolean
  /** Whitelisted routing fields only; all other settings stay private. */
  model?: string
  effortLevel?: string
  /** Stable filesystem error code only; never the error message or file contents. */
  errorCode?: string
}

export interface ClaudeSettingsChanges {
  /** Null means an unreadable snapshot made the comparison unknowable. */
  contentChanged: boolean | null
  /** Null means either snapshot did not have a known JSON routing state. */
  modelChanged: boolean | null
  /** Null means either snapshot did not have a known JSON routing state. */
  effortLevelChanged: boolean | null
}

/** Claude Code's user settings path, honoring its supported config-dir override. */
export function claudeUserSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configuredDir = env.CLAUDE_CONFIG_DIR?.trim()
  return join(configuredDir || join(homedir(), '.claude'), 'settings.json')
}

function filesystemErrorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    return err.code
  }
  return 'UNKNOWN'
}

/**
 * Capture a settings fingerprint and the non-sensitive routing fields.
 * Observation is best-effort and never throws, so it cannot break a dispatch.
 */
export function captureClaudeSettings(path = claudeUserSettingsPath()): ClaudeSettingsSnapshot {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const contents = readFileSync(fd)
    const stat = fstatSync(fd)
    const snapshot: ClaudeSettingsSnapshot = {
      state: 'present',
      fingerprint: createHash('sha256').update(contents).digest('hex'),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      inode: stat.ino,
      jsonValid: false,
    }

    try {
      const parsed = JSON.parse(contents.toString('utf8')) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const settings = parsed as Record<string, unknown>
        snapshot.jsonValid = true
        if (typeof settings['model'] === 'string') snapshot.model = settings['model']
        if (typeof settings['effortLevel'] === 'string') snapshot.effortLevel = settings['effortLevel']
      }
    } catch {
      // The fingerprint still detects a change; routing fields stay unknown.
    }
    return snapshot
  } catch (err) {
    const errorCode = filesystemErrorCode(err)
    return errorCode === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable', errorCode }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Snapshot cleanup is best-effort for the same reason as observation.
      }
    }
  }
}

function routingKnown(snapshot: ClaudeSettingsSnapshot): boolean {
  return snapshot.state === 'missing' || (snapshot.state === 'present' && snapshot.jsonValid === true)
}

/** Compare two snapshots without treating unreadable or invalid state as fact. */
export function compareClaudeSettings(
  before: ClaudeSettingsSnapshot,
  after: ClaudeSettingsSnapshot,
): ClaudeSettingsChanges {
  let contentChanged: boolean | null
  if (before.state === 'unreadable' || after.state === 'unreadable') {
    contentChanged = null
  } else if (before.state !== after.state) {
    contentChanged = true
  } else if (before.state === 'missing' && after.state === 'missing') {
    contentChanged = false
  } else {
    contentChanged = before.fingerprint !== after.fingerprint
  }

  const routingComparable = routingKnown(before) && routingKnown(after)
  return {
    contentChanged,
    modelChanged: routingComparable ? (before.model ?? null) !== (after.model ?? null) : null,
    effortLevelChanged: routingComparable
      ? (before.effortLevel ?? null) !== (after.effortLevel ?? null)
      : null,
  }
}
