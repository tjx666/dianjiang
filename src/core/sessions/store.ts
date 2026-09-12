import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { getStore } from '../store.ts'
import type { SqliteDatabase } from '../sqlite.ts'
import { SessionError, type MessageReceipt, type SessionMessage } from './types.ts'

/** Receipts share the run store's file and its cached handle; only the schema is ours. */
const prepared = new WeakSet<SqliteDatabase>()

function database(): SqliteDatabase {
  const db = getStore()
  if (prepared.has(db)) return db
  db.exec('PRAGMA busy_timeout=5000;')
  db.exec(`CREATE TABLE IF NOT EXISTS session_messages (
    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, target TEXT NOT NULL,
    owner_pid INTEGER NOT NULL, receipt TEXT NOT NULL, sending INTEGER NOT NULL, owner_started TEXT
  ); CREATE UNIQUE INDEX IF NOT EXISTS session_message_target_lock ON session_messages(target) WHERE sending=1;`)
  if (!(db.query('PRAGMA table_info(session_messages)').all() as { name: string }[]).some((column) => column.name === 'owner_started')) db.exec('ALTER TABLE session_messages ADD COLUMN owner_started TEXT')
  prepared.add(db)
  return db
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

function processStart(pid: number): string | undefined {
  try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } }).trim() || undefined } catch { return undefined }
}

/** Our own incarnation never changes; never pay for `ps` inside a write transaction. */
let ownStart: string | null | undefined
function ownProcessStart(): string | null {
  if (ownStart === undefined) ownStart = processStart(process.pid) ?? null
  return ownStart
}

function reconcile(db: SqliteDatabase): void {
  for (const row of db.query('SELECT id, owner_pid, owner_started, receipt FROM session_messages WHERE sending=1').all() as { id: string; owner_pid: number; owner_started: string | null; receipt: string }[]) {
    if (alive(row.owner_pid)) {
      const started = row.owner_started && processStart(row.owner_pid)
      // A time lease could expire while the original sender is paused and allow duplicate writes.
      // Compare process incarnations instead; unavailable identity evidence never releases a live lock.
      if (!started || started === row.owner_started) continue
    }
    const receipt: MessageReceipt = { ...JSON.parse(row.receipt), status: 'unknown', updatedAt: new Date().toISOString(), detail: 'Sender exited before recording an acknowledgement. This message will not be automatically retried.' }
    db.query('UPDATE session_messages SET receipt=?, sending=0 WHERE id=? AND sending=1').run(JSON.stringify(receipt), row.id)
  }
}

/** Atomically claim both the message ID and the target; collisions never cause a second send. */
export function claimMessage(message: SessionMessage, wakeOptions: { wake: boolean; model?: string; effort?: string }): { fresh: boolean; receipt: MessageReceipt } {
  const db = database()
  const fingerprint = createHash('sha256').update(JSON.stringify({ from: message.from, to: message.to, text: message.text, mode: message.mode, ...wakeOptions })).digest('hex')
  const started = ownProcessStart()
  try {
    db.exec('BEGIN IMMEDIATE')
    reconcile(db)
    const existing = db.query('SELECT fingerprint,receipt FROM session_messages WHERE id=?').get(message.id) as { fingerprint: string; receipt: string } | undefined
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new SessionError('Message ID already belongs to different content, sender, target, or options.')
      db.exec('COMMIT')
      return { fresh: false, receipt: JSON.parse(existing.receipt) }
    }
    const target = `${message.to.harness}:${message.to.sessionId}`
    if (db.query('SELECT id FROM session_messages WHERE target=? AND sending=1').get(target)) throw new SessionError('Another sender is delivering to this session. Retry later with the same message ID.')
    const receipt: MessageReceipt = { messageId: message.id, from: message.from, to: message.to, status: 'sending', createdAt: message.createdAt, updatedAt: message.createdAt }
    db.query('INSERT INTO session_messages (id,fingerprint,target,owner_pid,receipt,sending,owner_started) VALUES (?,?,?,?,?,1,?)').run(message.id, fingerprint, target, process.pid, JSON.stringify(receipt), started)
    db.exec('COMMIT')
    return { fresh: true, receipt }
  } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
}

export function finishMessage(receipt: MessageReceipt, sending = false): MessageReceipt {
  database().query('UPDATE session_messages SET receipt=?, sending=? WHERE id=?').run(JSON.stringify(receipt), sending ? 1 : 0, receipt.messageId)
  return receipt
}

export function getMessageReceipt(id: string): MessageReceipt | undefined {
  const db = database()
  reconcile(db)
  const row = db.query('SELECT receipt FROM session_messages WHERE id=?').get(id) as { receipt: string } | undefined
  return row ? JSON.parse(row.receipt) : undefined
}
