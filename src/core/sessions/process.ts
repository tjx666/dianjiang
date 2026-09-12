import { execFile } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { SessionError } from './types.ts'

/**
 * Connect a local native socket with a bounded wait. Rejections here are always
 * pre-write, so they stay `rejected`; the caller owns the socket once it resolves.
 */
export function connectSocket(path: string, messages: { timedOut: string; unreachable?: string }, timeoutMs = 5000): Promise<Socket> {
  const socket = createConnection(path)
  return new Promise<Socket>((resolve, reject) => {
    const onError = (error: Error) => { clearTimeout(timer); reject(new SessionError(messages.unreachable ?? error.message)) }
    const timer = setTimeout(() => { socket.off('error', onError); socket.destroy(); reject(new SessionError(messages.timedOut)) }, timeoutMs)
    socket.once('error', onError)
    socket.once('connect', () => { clearTimeout(timer); socket.off('error', onError); resolve(socket) })
  })
}

/** Read-only native discovery commands are bounded and never go through a shell. */
export function nativeOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new SessionError(`${command} discovery failed (${error.code ?? 'timeout'}).`))
      else resolve(stdout)
    })
  })
}
