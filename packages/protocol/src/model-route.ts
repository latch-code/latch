import type { HarnessCapabilities, ModelWire } from './harnesses.ts'
import type { ProviderKind, ProviderSummary } from './settings.ts'
import { canTranslate, lossesOf, type PairRoute } from './gateway-translations.ts'
export type { PairRoute } from './gateway-translations.ts'

/** The protocol each kind of model service speaks. */
export const PROVIDER_WIRES: Readonly<Record<ProviderKind, ModelWire>> = {
  'openai-compatible': 'chat-completions',
  'openai-responses': 'responses',
  anthropic: 'anthropic-messages',
}

/** The protocol names a developer knows them by. */
export const WIRE_NAMES: Readonly<Record<ModelWire, string>> = {
  'chat-completions': 'Chat Completions',
  responses: 'Responses',
  'anthropic-messages': 'Anthropic Messages',
}

/** A model ID as agents that narrow their list to a service's compare them: lower case, without a vendor prefix or a date suffix. */
export const modelIdKey = (id: string): string =>
  id
    .toLowerCase()
    .replace(/^.*\//u, '')
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/u, '')

/**
 * A session's model choice that moves it to another route, as the value of its model option: a model of a service
 * (`~service`, NUL, service ID, NUL, model) or one of the harness's own models while the session is on a service
 * (`~own`, NUL, the harness's own value, empty for its default). No agent's own value has a NUL in it, so neither is ever one of them.
 */
export type ModelChoice = { kind: 'service'; providerId: string; model: string } | { kind: 'own'; value: string }

const SERVICE_CHOICE = '~service\u0000'
const OWN_CHOICE = '~own\u0000'

export const serviceChoice = (model: { providerId: string; model: string }): string =>
  `${SERVICE_CHOICE}${model.providerId}\u0000${model.model}`
export const ownChoice = (value: string): string => `${OWN_CHOICE}${value}`

export function parseModelChoice(value: string): ModelChoice | undefined {
  if (value.startsWith(SERVICE_CHOICE)) {
    const parts = value.slice(SERVICE_CHOICE.length).split('\u0000')
    const [providerId = '', model = ''] = parts
    return parts.length === 2 && providerId && model ? { kind: 'service', providerId, model } : undefined
  }
  if (value.startsWith(OWN_CHOICE)) {
    // Empty: the harness's own default model.
    const own = value.slice(OWN_CHOICE.length)
    return own.includes('\u0000') ? undefined : { kind: 'own', value: own }
  }
  return undefined
}

/**
 * Whether a session runs on `choice` now: on that service's model (`route` as its summary shows it), or on the harness's
 * own login with that model selected.
 */
export function onModelChoice(
  choice: ModelChoice,
  route: { providerId: string; model: string } | undefined,
  currentValue: string | undefined,
): boolean {
  return choice.kind === 'service'
    ? route?.providerId === choice.providerId && route.model === choice.model
    : route === undefined && (choice.value === '' || currentValue === choice.value)
}

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
