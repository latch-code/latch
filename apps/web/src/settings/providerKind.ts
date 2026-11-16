import { isProviderKind, type ProviderKind, type ProviderSettings } from '@latch/protocol'

export const providerKindLabels: Record<ProviderKind, string> = {
  'openai-compatible': 'Chat Completions',
  'openai-responses': 'Responses',
  anthropic: 'Anthropic Messages',
}

export type SupportedProvider = ProviderSettings & { kind: ProviderKind }

export const isSupported = (provider: ProviderSettings): provider is SupportedProvider => isProviderKind(provider.kind)
