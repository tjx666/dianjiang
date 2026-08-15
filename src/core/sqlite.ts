/**
 * SQLite handle that works under Bun (`bun:sqlite`) and Node (`node:sqlite`).
 * Neither module is importable on the other runtime, so both are loaded via
 * `createRequire` only on the matching side.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** Subset of bun:sqlite's statement API that the store actually uses. */
export interface SqliteStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

/** Subset of bun:sqlite's Database API that the store actually uses. */
export interface SqliteDatabase {
  exec(sql: string): void
  query(sql: string): SqliteStatement
  close(): void
}

/** Open (or create) a SQLite file. */
export function openDatabase(path: string): SqliteDatabase {
  if (typeof globalThis.Bun !== 'undefined') {
    const { Database } = require('bun:sqlite') as {
      Database: new (filename: string, options?: { create?: boolean }) => SqliteDatabase
    }
    return new Database(path, { create: true })
  }
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (filename: string) => {
      exec(sql: string): void
      prepare(sql: string): SqliteStatement
      close(): void
    }
  }
  const db = new DatabaseSync(path)
  return {
    exec: (sql) => db.exec(sql),
    query: (sql) => db.prepare(sql),
    close: () => db.close(),
  }
}
