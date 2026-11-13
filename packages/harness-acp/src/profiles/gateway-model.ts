import type { GatewayModelValues } from './types.ts'

/** OpenCode and pi keep the provider as the first path segment; the remaining model ID may itself contain slashes. */
export function prefixedModels(provider: string): GatewayModelValues {
  const prefix = `${provider}/`
  return {
    value: id => `${prefix}${id}`,
    id: value => (value.startsWith(prefix) && value.length > prefix.length ? value.slice(prefix.length) : undefined),
  }
}

/** dsh's ACP model value is a JSON pair, including the provider; a display label or another provider never matches. */
export function pairedModels(provider: string): GatewayModelValues {
  return {
    value: id => JSON.stringify([provider, id]),
    id: value => {
      try {
        const pair: unknown = JSON.parse(value)
        return Array.isArray(pair) && pair.length === 2 && pair[0] === provider && typeof pair[1] === 'string' && pair[1]
          ? pair[1]
          : undefined
      } catch {
        return undefined
      }
    },
  }
}
