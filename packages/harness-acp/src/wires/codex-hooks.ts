/**
 * Codex's own hooks (`hooks/list`, 0.156 and 0.170): only when each runs, where it is configured and whether it is
 * managed, enabled and trusted are read. A hook's command, file and key are never read, kept or sent.
 */
import { z } from 'zod'

/** Hooks Latch lists at most. */
const MAX_HOOKS = 100
const word = z.string().regex(/^[A-Za-z]{1,64}$/u)
const hookList = z.object({ data: z.array(z.object({ hooks: z.array(z.unknown()).max(1000) })).max(16) })
const hookEntry = z.object({
  eventName: word,
  source: word,
  isManaged: z.boolean(),
  enabled: z.boolean(),
  trustStatus: word.optional().catch(undefined),
})

export interface CodexHooks {
  hooks: Array<{ event: string; source: string; managed: boolean; enabled: boolean; trust?: string }>
  truncated?: true
}

/** Codex's answer to `hooks/list`, or undefined when it is not one Latch reads. */
export function codexHooks(answer: unknown): CodexHooks | undefined {
  const read = hookList.safeParse(answer)
  if (!read.success) return undefined
  const hooks: CodexHooks['hooks'] = []
  let truncated = false
  for (const entry of read.data.data)
    for (const raw of entry.hooks) {
      const hook = hookEntry.safeParse(raw)
      if (!hook.success) {
        truncated = true
        continue
      }
      if (hooks.length >= MAX_HOOKS) {
        truncated = true
        break
      }
      hooks.push({
        event: hook.data.eventName,
        source: hook.data.source,
        managed: hook.data.isManaged,
        enabled: hook.data.enabled,
        ...(hook.data.trustStatus ? { trust: hook.data.trustStatus } : {}),
      })
    }
  return { hooks, ...(truncated ? { truncated: true as const } : {}) }
}

/** As the MCP report carries them (`ownMcpStatus`). */
export const hooksReport = (hooks: CodexHooks | undefined) =>
  hooks ? { hooks: hooks.hooks, ...(hooks.truncated ? { hooksTruncated: true as const } : {}) } : {}
