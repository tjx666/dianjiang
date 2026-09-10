import { execFile } from 'node:child_process'
import { SessionError } from './types.ts'

/** Read-only native discovery commands are bounded and never go through a shell. */
export function nativeOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new SessionError(`${command} discovery failed (${error.code ?? 'timeout'}).`))
      else resolve(stdout)
    })
  })
}
