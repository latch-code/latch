import type { ModelWire } from './harnesses.ts'

/** Only implemented, independently testable directions are advertised. Same-protocol forwarding takes precedence. */
export const TRANSLATED_PAIRS: ReadonlyArray<{ entry: ModelWire; upstream: ModelWire }> = [
  { entry: 'responses', upstream: 'chat-completions' },
]

export const GATEWAY_LOSSES = [
  'tool-grammar',
  'tool-image-location',
  'hosted-tools',
  'reasoning-state',
  'prompt-cache',
  'annotations',
  'logprobs',
  'audio',
  'unsupported-options',
] as const
export type GatewayLoss = (typeof GATEWAY_LOSSES)[number]
/**
 * How a harness reaches one model service. `own`: no service, the harness's own models. `direct`: the built-in harness
 * calls the service. `passthrough`: the harness speaks the service's protocol, and Latch forwards its requests on this
 * computer with the service's key. `translate`: an implemented experimental conversion. `incompatible`: no implemented
 * conversion. `unavailable`: Latch cannot route this harness to any service, or this is not a saved service.
 */
export type PairRoute =
  | { kind: 'own' }
  | { kind: 'direct' }
  | { kind: 'passthrough'; wire: ModelWire; experimental?: true }
  | { kind: 'translate'; wire: ModelWire; upstream: ModelWire; experimental: true; losses: readonly GatewayLoss[] }
  | { kind: 'incompatible'; from: ModelWire; speaks: ModelWire[] }
  | { kind: 'unavailable'; reason: 'not-forwarded' | 'not-a-service' }

export const GATEWAY_LOSS_NAMES: Readonly<Record<GatewayLoss, string>> = {
  'tool-grammar': '工具语法约束',
  'tool-image-location': '工具图片的原始消息位置',
  'hosted-tools': '服务端工具',
  'reasoning-state': '其他来源的思考状态',
  'prompt-cache': '提示缓存设置',
  annotations: '引用标注',
  logprobs: '概率详情',
  audio: '音频',
  'unsupported-options': '协议专用选项',
}

export function canTranslate(entry: ModelWire, upstream: ModelWire): boolean {
  return TRANSLATED_PAIRS.some(pair => pair.entry === entry && pair.upstream === upstream)
}

/** Potential losses, not a claim that a particular request contained all of them. */
export function lossesOf(entry: ModelWire, upstream: ModelWire): readonly GatewayLoss[] {
  return canTranslate(entry, upstream) ? GATEWAY_LOSSES : []
}
