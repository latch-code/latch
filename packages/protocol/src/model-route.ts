import type { HarnessCapabilities, ModelWire } from './harnesses.ts'
import type { ProviderKind, ProviderSummary } from './settings.ts'
import { canTranslate, lossesOf, type PairRoute } from './gateway-translations.ts'
export type { PairRoute } from './gateway-translations.ts'

/** The protocol each kind of model service speaks. */
export const PROVIDER_WIRES: Readonly<Record<ProviderKind, ModelWire>> = {
  'openai-compatible': 'chat-completions',
  'openai-responses': 'responses',
  anthropic: 'anthropic-messages',
  gemini: 'gemini',
}

/** The protocol names a developer knows them by. */
export const WIRE_NAMES: Readonly<Record<ModelWire, string>> = {
  'chat-completions': 'Chat Completions',
  responses: 'Responses',
  'anthropic-messages': 'Anthropic Messages',
  gemini: 'Gemini',
}

/** A model ID as agents that narrow their list to a service's compare them: lower case, without a vendor prefix or a date suffix. */
export const modelIdKey = (id: string): string =>
  id
    .toLowerCase()
    .replace(/^.*\//u, '')
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/u, '')

/** Whether `kind` is a model service a person saved, as opposed to the demo model or a plugin's provider. */
const isServiceKind = (kind: ProviderSummary['kind']): kind is ProviderKind => Object.hasOwn(PROVIDER_WIRES, kind)

/**
 * The route between a harness and a model service, or the harness's own models without one. Clients list a pair by it;
 * the Host computes it again from its own records before a session starts, and refuses anything but `direct` or
 * `passthrough` or an implemented `translate`.
 */
export function pairRoute(capabilities: Pick<HarnessCapabilities, 'models'>, provider?: Pick<ProviderSummary, 'kind'>): PairRoute {
  const { models } = capabilities
  if (!provider) return models.owner === 'latch' ? { kind: 'unavailable', reason: 'not-a-service' } : { kind: 'own' }
  if (models.owner === 'latch') return { kind: 'direct' }
  if (!isServiceKind(provider.kind)) return { kind: 'unavailable', reason: 'not-a-service' }
  const wire = PROVIDER_WIRES[provider.kind]
  if (models.wires.includes(wire)) return { kind: 'passthrough', wire, ...(models.experimental ? { experimental: true as const } : {}) }
  const entry = models.wires.find(candidate => canTranslate(candidate, wire))
  if (entry) return { kind: 'translate', wire: entry, upstream: wire, experimental: true, losses: lossesOf(entry, wire) }
  if (models.wires.length) return { kind: 'incompatible', from: wire, speaks: [...models.wires] }
  return { kind: 'unavailable', reason: 'not-forwarded' }
}
