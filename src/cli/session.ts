import { defineCommand } from 'citty'
import { detectCaller, resolveCallerIdentity } from '../core/caller.ts'
import { loadConfig } from '../core/registry.ts'
import { HARNESS_NAMES, type HarnessName } from '../core/types.ts'
import { getMessageReceipt, normalizeSessionTarget, sendSessionMessage, sessionAdapters, type MessageMode } from '../core/sessions/index.ts'

function harness(value: string | undefined): HarnessName {
  if (!value || !HARNESS_NAMES.includes(value as HarnessName)) throw new Error('Specify --harness claude, codex, or grok.')
  return value as HarnessName
}

async function output(action: () => Promise<unknown> | unknown): Promise<void> {
  try { process.stdout.write(`${JSON.stringify(await action(), null, 2)}\n`) }
  catch (error) { process.stdout.write(`${JSON.stringify({ status: 'rejected', error: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = 1 }
}

const targetArgs = {
  harness: { type: 'string' as const, required: true as const, description: 'Native harness: claude, codex, or grok' },
  session: { type: 'string' as const, required: true as const, description: 'Native session UUID' },
  endpoint: { type: 'string' as const, description: 'Local native socket path (not a URL)' },
  cwd: { type: 'string' as const, description: 'Original session working directory' },
}

export const sessionCommand = defineCommand({
  meta: { name: 'session', description: 'Discover native sessions and deliver attributed messages.' },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List native sessions; discovery is scoped to the selected backend.' },
      args: { harness: targetArgs.harness, endpoint: targetArgs.endpoint, limit: { type: 'string', default: '20' } },
      async run({ args }) { await output(async () => {
        const limit = Number(args.limit)
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be between 1 and 100.')
        if (args.endpoint && (!args.endpoint.startsWith('/') || args.endpoint.split('/').includes('..'))) throw new Error('--endpoint must be an absolute local socket path.')
        return sessionAdapters[harness(args.harness)]!.list({ endpoint: args.endpoint, limit })
      }) },
    }),
    status: defineCommand({
      meta: { name: 'status', description: 'Inspect native session state and available delivery modes.' },
      args: targetArgs,
      async run({ args }) { await output(() => sessionAdapters[harness(args.harness)]!.inspect(normalizeSessionTarget({ harness: harness(args.harness), sessionId: args.session, endpoint: args.endpoint, cwd: args.cwd }))) },
    }),
    send: defineCommand({
      meta: { name: 'send', description: 'Send a message with explicit sender identity; returns a delivery receipt, not a reply.' },
      args: {
        ...targetArgs,
        message: { type: 'positional', required: true, description: 'Message text' },
        'from-harness': { type: 'string', description: 'Sender harness; defaults to the nearest harness process' },
        'from-session': { type: 'string', required: true, description: 'Sender native session UUID; never inferred from inherited environment markers' },
        'message-id': { type: 'string', description: 'Stable UUID for retries; reusing an ID never sends twice' },
        mode: { type: 'string', default: 'queue', description: 'queue or steer; never silently interrupts tools' },
        wake: { type: 'boolean', default: false, description: 'Permit a detached native resume when the target is observed stopped' },
        model: { type: 'string', description: 'Model for a stopped-session wake only' },
        effort: { type: 'string', description: 'Effort for a stopped-session wake only' },
      },
      async run({ args }) { await output(async () => {
        const sender = resolveCallerIdentity(args['from-harness'] ? harness(args['from-harness']) : undefined, detectCaller())
        if (!sender) throw new Error('Cannot identify sender harness. Pass --from-harness and --from-session.')
        const receipt = await sendSessionMessage({
          from: { harness: sender, sessionId: args['from-session'] },
          to: { harness: harness(args.harness), sessionId: args.session, endpoint: args.endpoint, cwd: args.cwd },
          text: args.message, messageId: args['message-id'], mode: args.mode as MessageMode,
          wake: args.wake, model: args.model, effort: args.effort,
        }, loadConfig())
        if (['rejected', 'unknown'].includes(receipt.status)) process.exitCode = 1
        return receipt
      }) },
    }),
    receipt: defineCommand({
      meta: { name: 'receipt', description: 'Read a saved delivery receipt; reconciles interrupted senders.' },
      args: { id: { type: 'positional', required: true } },
      async run({ args }) { await output(() => {
        const receipt = getMessageReceipt(args.id)
        if (!receipt) throw new Error(`Message ${args.id} not found.`)
        return receipt
      }) },
    }),
  },
})
