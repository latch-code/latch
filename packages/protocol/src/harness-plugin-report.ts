import type { HarnessPluginReport } from './extensions.ts'
import { looksSecret } from './secrets.ts'

export const MAX_HARNESS_PLUGINS = 200

export function isHarnessPluginName(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length <= 200
    && value.trim() === value
    && /^[\p{L}\p{N}\p{M} ._+-]+$/u.test(value)
    && /[\p{L}\p{N}]/u.test(value)
    && !looksSecret(value)
  )
}

export function readHarnessPluginReport(value: unknown): HarnessPluginReport | undefined {
  if (!value || typeof value !== 'object' || !('names' in value)) return undefined
  const { names } = value
  if (!Array.isArray(names) || names.length > MAX_HARNESS_PLUGINS || ('truncated' in value && value.truncated !== true)) return undefined
  const labels = new Set<string>()
  for (const name of names) {
    if (!isHarnessPluginName(name) || labels.has(name)) return undefined
    labels.add(name)
  }
  return { names: [...labels], ...('truncated' in value ? { truncated: true } : {}) }
}
