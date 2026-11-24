import { containsSecret } from '@latch/protocol'

export type PluginAddInput = { kind: 'npm'; name: string; version?: string } | { kind: 'external'; input: string }

export function pluginAddInput(value: string): PluginAddInput | undefined {
  const input = value.trim()
  if (!input || input.length > 4096 || containsSecret(input)) return undefined
  if (input.startsWith('/') || input.startsWith('~/')) return { kind: 'external', input }
  if (/^https:\/\/github\.com\/[a-z\d-]{1,39}\/[a-z\d_.-]{1,100}(?:\/tree\/[a-z\d_/.-]{1,180})?\/?$/iu.test(input))
    return { kind: 'external', input }
  const match = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([0-9][0-9a-z.+-]{0,63}))?$/iu.exec(input)
  const name = match?.[1]
  if (!name || name.length > 214 || name !== name.toLowerCase()) return undefined
  const version = match?.[2]
  return { kind: 'npm', name, ...(version ? { version } : {}) }
}
