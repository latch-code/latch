import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@latch/core/node-kit'
import { z } from 'zod'

export const DSH_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
export const DSH_CONSULTATION_METHOD = '_latch/text-only-consultation'
export const DSH_CONSULTATION_GUARD_VERSION = 1
export const DSH_CONSULTATION_MINIMUM = '0.2.2-rc.5'
export const DSH_MODE_METHOD = '_latch/permission'
const consultationProof = z.strictObject({
  sessionId: z.string().min(1).max(256),
  version: z.literal(DSH_CONSULTATION_GUARD_VERSION),
  executionId: z.string().regex(/^[a-f0-9]{64}$/u),
})
export function guardedDshSession(params: unknown, expectedExecution?: string): string | undefined {
  const proof = consultationProof.safeParse(params).data
  return proof && proof.executionId === expectedExecution ? proof.sessionId : undefined
}

const report = z.object({ sessionId: z.string().min(1).max(256), mode: z.enum([...DSH_MODES, 'unknown']) })

/** A report from the official permission service, bound to the ACP session and the process that sent it. */
export function readDshMode(method: string, params: unknown): { sessionId: string; mode: string } | undefined {
  if (method !== DSH_MODE_METHOD) return undefined
  return report.safeParse(params).data
}

// The public Cordis plugin seam and permissionPresets service are shipped with dsh 0.2.2-rc.1. A resume preserves its
// recorded knobs: changing DSH_PERMISSION_MODE alone cannot change an existing session. The service owns the change
// and its durable events; this plugin never opens dsh's session files. A check omits `mode` and only reads.
const SOURCE = `export const name = 'latch-permission'
export const inject = ['permissionPresets']
export function apply(ctx, config = {}) {
  const sessions = new Map()
  const modes = ${JSON.stringify(DSH_MODES)}
  const report = session => {
    const current = ctx.permissionPresets.current(session)
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: ${JSON.stringify(DSH_MODE_METHOD)}, params: {
      sessionId: session.header.id, mode: modes.includes(current) ? current : 'unknown',
    } }) + '\\n')
  }
  ctx.on('agent/created', ({ agent }) => {
    const session = agent.session
    if (config.mode !== undefined) ctx.permissionPresets.set(session, config.mode)
    sessions.set(session.header.id, session)
    report(session)
  })
  const queued = new Set()
  ctx.on('session/event', (session, event) => {
    const id = session.header.id
    if (!sessions.has(id) || !['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type) || queued.has(id)) return
    queued.add(id)
    queueMicrotask(() => {
      queued.delete(id)
      if (sessions.has(id)) report(session)
    })
  })
  ctx.on('agent/disposed', ({ agent }) => sessions.delete(agent.session.header.id))
}
`

// The official ToolRuntime checks inherited guards after pre-execute policy and approval, before dispatch.
// The guard belongs to this process's root, so tools of children and dynamically registered MCP tools are covered.
const CONSULTATION_SOURCE = `export const name = 'latch-text-only-consultation'
export const inject = ['tools', 'systemPrompt']
export function apply(ctx, config) {
  ctx.systemPrompt.section({
    name: 'latch:peer-consultation',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
    interpolate: false,
    text: 'Another personal Agent is asking you a question in your current chat. Reply directly in text using your existing instructions, notes, and chat history. You have no tools for this turn. If the answer is missing, say so. Do not output tool calls, command examples, or tool-call markup in place of an answer.',
  })
  const reason = 'This consultation accepts a text reply only.'
  ctx.tools.guard(() => reason)
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: [] })
    if (ctx.tools.schemas(agent).length || ctx.tools.checkGuards({ agent })?.reason !== reason) return
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: ${JSON.stringify(DSH_CONSULTATION_METHOD)},
      params: { sessionId: agent.session.header.id, version: ${DSH_CONSULTATION_GUARD_VERSION}, executionId: config.executionId } }) + '\\n')
  })
}
`

/** Replaced atomically before each spawn; only this process's private patch imports the trusted plugin. */
export async function prepareDshMode(
  directory: string,
  mode?: string,
  consultationExecution?: string,
): Promise<{ args: string[]; env: Record<string, string> }> {
  if (mode !== undefined && !(DSH_MODES as readonly string[]).includes(mode)) throw new Error('Unknown DeepSeek Harness permission mode')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const plugin = join(directory, 'latch-permission.mjs')
  const patch = join(directory, 'latch-permission.patch.json')
  await writeFileAtomic(plugin, SOURCE)
  const insert: Array<{ id: string; name: string; config: Record<string, string> }> = [
    { id: 'latch-permission', name: plugin, config: mode ? { mode } : {} },
  ]
  if (consultationExecution) {
    const guard = join(directory, 'latch-text-only-consultation.mjs')
    await writeFileAtomic(guard, CONSULTATION_SOURCE)
    insert.push({ id: 'latch-text-only-consultation', name: guard, config: { executionId: consultationExecution } })
  }
  await writeFileAtomic(patch, JSON.stringify([{ insert }]))
  return { args: ['--patch', patch], env: mode ? { DSH_PERMISSION_MODE: mode } : {} }
}
