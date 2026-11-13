import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@latch/core/node-kit'
import { z } from 'zod'

export const DSH_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
export const DSH_MODE_METHOD = '_latch/permission'
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

/** Replaced atomically before each spawn; only this process's private patch imports the trusted plugin. */
export async function prepareDshMode(directory: string, mode?: string): Promise<{ args: string[]; env: Record<string, string> }> {
  if (mode !== undefined && !(DSH_MODES as readonly string[]).includes(mode)) throw new Error('Unknown DeepSeek Harness permission mode')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const plugin = join(directory, 'latch-permission.mjs')
  const patch = join(directory, 'latch-permission.patch.json')
  await writeFileAtomic(plugin, SOURCE)
  await writeFileAtomic(patch, JSON.stringify([{ insert: [{ id: 'latch-permission', name: plugin, config: mode ? { mode } : {} }] }]))
  return { args: ['--patch', patch], env: mode ? { DSH_PERMISSION_MODE: mode } : {} }
}
