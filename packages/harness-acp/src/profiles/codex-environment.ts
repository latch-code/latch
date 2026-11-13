import { z } from 'zod'

const patterns = z.array(z.string().max(1024)).max(1024).nullish()
const policy = z.object({
  filters: z.record(z.string().max(1024), z.enum(['include', 'exclude'])).nullish(),
  exclude: patterns,
  include_only: patterns,
})
const reading = z.object({ config: z.object({ shell_environment_policy: policy }) })

/**
 * Preserve Codex's effective command filters, adding only the gateway token's exclusion. Changing between its
 * legacy arrays and keyed filters discards the other representation, so the override keeps the one it reported.
 * Never project `set` or other config values into a thread request.
 */
export function codexGatewayEnvironment(value: unknown): Record<string, unknown> | undefined {
  const parsed = reading.safeParse(value)
  if (!parsed.success) return undefined
  const current = parsed.data.config.shell_environment_policy
  if (current.filters != null) {
    if (current.exclude != null || current.include_only != null) return undefined
    const entries = Object.entries(current.filters)
    if (entries.length > 1024) return undefined
    const names = new Set<string>()
    for (const [name] of entries) {
      const folded = name.toLowerCase()
      if (names.has(folded)) return undefined
      names.add(folded)
    }
    return { filters: { ...Object.fromEntries(entries.filter(([name]) => name.toLowerCase() !== 'lmg_token')), LMG_TOKEN: 'exclude' } }
  }
  return {
    exclude: [...(current.exclude ?? []), 'LMG_TOKEN'],
    ...(current.include_only != null ? { include_only: current.include_only } : {}),
  }
}
