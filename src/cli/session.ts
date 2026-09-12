import { defineCommand } from 'citty'
import { detectCaller, resolveCallerIdentity } from '../core/caller.ts'
import { loadConfig } from '../core/registry.ts'
import { getMessageReceipt, inspectSession, listSessions, sendSessionMessage, type MessageMode } from '../core/sessions/index.ts'
import { emitResult, requireHarness } from './output.ts'

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
      async run({ args }) { await emitResult(() => listSessions(requireHarness(args.harness), { endpoint: args.endpoint, limit: Number(args.limit) })) },
    }),
    status: defineCommand({
      meta: { name: 'status', description: 'Inspect native session state and available delivery modes.' },
      args: targetArgs,
      async run({ args }) { await emitResult(() => inspectSession({ harness: requireHarness(args.harness), sessionId: args.session, endpoint: args.endpoint, cwd: args.cwd })) },
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
      async run({ args }) { await emitResult(async () => {
        const sender = resolveCallerIdentity(args['from-harness'] ? requireHarness(args['from-harness'], 'from-harness') : undefined, detectCaller())
        if (!sender) throw new Error('Cannot identify sender harness. Pass --from-harness and --from-session.')
        const receipt = await sendSessionMessage({
          from: { harness: sender, sessionId: args['from-session'] },
          to: { harness: requireHarness(args.harness), sessionId: args.session, endpoint: args.endpoint, cwd: args.cwd },
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
      async run({ args }) { await emitResult(() => {
        const receipt = getMessageReceipt(args.id)
        if (!receipt) throw new Error(`Message ${args.id} not found.`)
        return receipt
      }) },
    }),
  },
})
