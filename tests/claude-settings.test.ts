import { expect, test } from 'bun:test'
import {
  compareClaudeSettings,
  type ClaudeSettingsSnapshot,
} from '../src/core/claude-settings.ts'

function present(overrides: Partial<ClaudeSettingsSnapshot> = {}): ClaudeSettingsSnapshot {
  return {
    state: 'present',
    fingerprint: 'same',
    jsonValid: true,
    model: 'fable',
    effortLevel: 'high',
    ...overrides,
  }
}

test('compareClaudeSettings reports an unchanged readable file without false positives', () => {
  expect(compareClaudeSettings(present({ inode: 1 }), present({ inode: 2, mtimeMs: 123 }))).toEqual({
    contentChanged: false,
    modelChanged: false,
    effortLevelChanged: false,
  })
})

test('compareClaudeSettings treats unreadable routing state as unknown', () => {
  expect(compareClaudeSettings(present(), { state: 'unreadable', errorCode: 'EACCES' })).toEqual({
    contentChanged: null,
    modelChanged: null,
    effortLevelChanged: null,
  })
})

test('compareClaudeSettings detects creation of a settings file', () => {
  expect(compareClaudeSettings({ state: 'missing' }, present())).toEqual({
    contentChanged: true,
    modelChanged: true,
    effortLevelChanged: true,
  })
})
