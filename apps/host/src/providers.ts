import { PROVIDER_PRESETS, type ProviderKind, type ProviderSettings, type ProviderSummary } from '@latch/protocol'
import type { HarnessPlugin, ModelProvider } from '@latch/sdk'
import { createAnthropicPlugin } from './plugins/providers/anthropic/index.ts'
import { anthropicWire } from './plugins/providers/anthropic-wire.ts'
import { chatWire } from './plugins/providers/chat-wire.ts'
import { createGeminiPlugin } from './plugins/providers/gemini/index.ts'
import { geminiWire } from './plugins/providers/gemini-wire.ts'
import { ProviderError, readErrorBody, redactor, send, type FetchLike, type ModelPage, type ModelWire } from './plugins/providers/http.ts'
import { createOpenAIPlugin } from './plugins/providers/openai-compatible/index.ts'
import { createResponsesPlugin } from './plugins/providers/openai-responses/index.ts'
import { responsesWire } from './plugins/providers/responses-wire.ts'
import { addressOf, keyPathOf, originOf, type ProviderRecord } from './config.ts'

export { originOf }

const factories: Record<ProviderKind, typeof createOpenAIPlugin> = {
  'openai-compatible': createOpenAIPlugin,
  'openai-responses': createResponsesPlugin,
  anthropic: createAnthropicPlugin,
  gemini: createGeminiPlugin,
}
const wires: Record<ProviderKind, ModelWire> = {
  'openai-compatible': chatWire,
  'openai-responses': responsesWire,
  anthropic: anthropicWire,
  gemini: geminiWire,
}

/**
 * The HTTPS origins of the built-in presets that need a key (OpenAI, Anthropic, DeepSeek, …). Saving a key for one of
 * these needs no local confirmation: the destination is a known service, not one the page chose.
 */
export const PRESET_KEY_ORIGINS: ReadonlySet<string> = new Set(
  PROVIDER_PRESETS.filter(preset => preset.requiresKey && preset.baseURL.startsWith('https://')).map(preset => originOf(preset.baseURL)),
)

export function isPresetKeyOrigin(origin: string): boolean {
  return PRESET_KEY_ORIGINS.has(origin)
}

/** A configured service at an address not confirmed on the Host computer: nothing is sent, the key least of all. */
export class OriginUnconfirmed extends ProviderError {
  constructor() {
    super(
      '这个模型服务的地址还没有确认，Latch 不会向它发送请求。请在运行 Latch 的电脑上，打开 设置 › 模型服务 确认这个地址。',
      'origin-unconfirmed',
    )
  }
}

/**
 * On the first start after confirmed addresses were introduced: the addresses (origin and path) the owner had already
 * confirmed. These are the addresses of saved keys (each was confirmed when it was saved) and services whose address
 * is already on the outbound allow list (allowed with a confirmation, or by editing policy.json while the Host was
 * stopped). Preset origins need no entry.
 */
export function addressesConfirmedBefore(records: readonly ProviderRecord[], egressAllow: readonly string[]): string[] {
  const addresses = new Set<string>()
  for (const record of records) {
    let origin: string
    try {
      origin = originOf(record.baseURL)
    } catch {
      continue
    }
    if (isPresetKeyOrigin(origin)) continue
    if (usableKey(record) || egressAllow.includes(origin.replace(/^https?:\/\//u, ''))) addresses.add(addressOf(record.baseURL))
  }
  return [...addresses]
}

/** Whether a key bound to `record`'s origin and path may go to `baseURL`: the same origin and the same path. */
export function keyBoundTo(record: Pick<ProviderRecord, 'keyOrigin' | 'keyPath'>, baseURL: string): boolean {
  if (!record.keyOrigin || record.keyPath === undefined) return false
  try {
    return originOf(baseURL) === record.keyOrigin && keyPathOf(baseURL) === record.keyPath
  } catch {
    return false
  }
}

/**
 * Whether `url` lies under `baseURL`: the same origin, and the base's path itself or a path below it. The connectors
 * build every request of a service this way, so a request anywhere else did not come from them.
 */
export function underBase(url: string, baseURL: string): boolean {
  try {
    if (originOf(url) !== originOf(baseURL)) return false
    const base = keyPathOf(baseURL)
    const path = new URL(url).pathname
    return base === '' || path === base || path.startsWith(`${base}/`)
  } catch {
    return false
  }
}

/** The stored key, only while the base URL still has the origin and path it was saved for; otherwise ''. */
export function usableKey(record: ProviderRecord): string {
  return record.apiKey && keyBoundTo(record, record.baseURL) ? record.apiKey : ''
}

/** One plugin per configured provider; the plugin ID equals the provider ID. Requests go through `deps.fetch`. */
export function providerPlugin(
  record: ProviderRecord,
  deps: { fetch: FetchLike; acquire?: (signal: AbortSignal, bytes: number) => Promise<() => void> },
): HarnessPlugin {
  return factories[record.kind]({
    id: record.id,
    name: record.name,
    baseURL: record.baseURL,
    apiKey: usableKey(record),
    model: record.defaultModel,
    models: record.models,
    ...(record.modelCapabilities ? { modelCapabilities: structuredClone(record.modelCapabilities) } : {}),
    fetch: deps.fetch,
    ...(deps.acquire ? { acquire: deps.acquire } : {}),
  })
}

/**
 * Owner-facing view of a stored provider. The key itself never leaves the Host; a key bound to another origin or path
 * counts as absent.
 */
export function providerSettings(record: ProviderRecord): ProviderSettings {
  const usable = Boolean(usableKey(record))
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    ...(record.presetId ? { presetId: record.presetId } : {}),
    baseURL: record.baseURL,
    hasKey: usable,
    ...(usable ? { keyOrigin: record.keyOrigin, keyPath: record.keyPath } : {}),
    enabled: record.enabled,
    models: [...record.models],
    ...(record.modelCapabilities ? { modelCapabilities: structuredClone(record.modelCapabilities) } : {}),
    defaultModel: record.defaultModel,
  }
}

/** Mirrors the runtime's model check: `models` when declared, else only the default. */
export function summarizeProvider(provider: ModelProvider, kind: ProviderSummary['kind']): ProviderSummary {
  return {
    id: provider.id,
    name: provider.name,
    kind,
    models: [...(provider.models ?? [provider.model])],
    defaultModel: provider.model,
    ...(provider.modelCapabilities ? { modelCapabilities: structuredClone(provider.modelCapabilities) } : {}),
  }
}

const LIST_TIMEOUT_MS = 10_000
const MAX_LIST_BYTES = 8 * 1024 * 1024
const MAX_LISTED_MODELS = 5000
export interface ModelListInput {
  kind: ProviderKind
  baseURL: string
  apiKey: string
}

function failureHint(status: number): string {
  if (status === 401 || status === 403) return 'API Key 无效或无权访问'
  if (status === 404) return '服务地址不正确或不提供模型列表'
  if (status === 429) return '请求过于频繁或额度不足'
  return '模型服务返回错误'
}

async function readLimited(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (!response.body || declared > MAX_LIST_BYTES) {
    await response.body?.cancel()
    throw new ProviderError(
      response.body ? '模型列表响应过大。' : '模型服务没有返回响应体。',
      response.body ? 'response-too-large' : 'empty-response',
    )
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      length += next.value.length
      if (length > MAX_LIST_BYTES) throw new ProviderError('模型列表响应过大。', 'response-too-large')
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => {
      /* The body may already have ended. */
    })
    reader.releaseLock()
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new ProviderError('模型列表不是有效的 UTF-8 文本。', 'invalid-response')
  }
}

async function fetchPage(
  fetcher: FetchLike,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  redacted: (text: string) => string,
) {
  const response = await send(fetcher, url, {
    method: 'GET',
    signal,
    redirect: 'error',
    headers: { accept: 'application/json', ...headers },
  })
  if (!response.ok) {
    throw new ProviderError(
      `${failureHint(response.status)}（HTTP ${response.status}）：${redacted(await readErrorBody(response))}`,
      'http-error',
      response.status,
    )
  }
  const text = await readLimited(response, signal)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ProviderError('模型列表不是有效的 JSON。', 'invalid-response')
  }
}

function networkFailure(error: unknown, redacted: (text: string) => string): ProviderError {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined
  const detail = cause
    ? 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : cause.message
    : error instanceof Error
      ? error.message
      : String(error)
  if (/redirect/iu.test(detail)) return new ProviderError('模型服务返回了重定向，请填写最终的 API 地址。', 'redirect')
  const failure = new ProviderError(`无法连接模型服务：${redacted(detail)}`, 'network-error')
  // The system's code alone (ECONNREFUSED, ENOTFOUND, …), so a page can say what happened in its own words.
  const networkCode =
    cause && 'code' in cause && typeof cause.code === 'string' && /^E[A-Z_]{2,30}$/u.test(cause.code) ? cause.code : undefined
  return networkCode ? Object.assign(failure, { networkCode }) : failure
}

/**
 * Lists remote model IDs with the given key; it spends no tokens. Requests go through `options.fetch`
 * (the Host's egress policy) and never follow redirects, so the key is only sent to the configured
 * origin. Errors are ProviderErrors with the key redacted; a denied address is `egress-denied` with `target`.
 */
export async function listProviderModels(
  input: ModelListInput,
  signal: AbortSignal,
  options: { fetch: FetchLike; timeoutMs?: number },
): Promise<string[]> {
  signal.throwIfAborted()
  if (/[\r\n]/u.test(input.apiKey)) throw new ProviderError('API Key 包含无效换行。', 'invalid-key')
  const timeout = AbortSignal.timeout(options.timeoutMs ?? LIST_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, timeout])
  const redacted = redactor(input.apiKey)
  const models = new Set<string>()
  const page: ModelPage = (url, headers) => fetchPage(options.fetch, url, headers, combined, redacted)
  try {
    for (const { id } of await wires[input.kind].listModels(input.baseURL, input.apiKey, page)) {
      const model = id.trim()
      // Store limits; unusable IDs are skipped rather than failing the whole list.
      if (model && model.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(model)) models.add(model)
      if (models.size > MAX_LISTED_MODELS) throw new ProviderError('模型列表条目过多。', 'response-too-large')
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (timeout.aborted) throw new ProviderError('获取模型列表超时，请检查服务地址与网络。', 'timeout')
    if (error instanceof ProviderError) throw error
    throw networkFailure(error, redacted)
  }
  return [...models].sort()
}

/** Free connection check: a successful model listing proves the address and key. */
export async function checkProvider(
  input: ModelListInput,
  signal: AbortSignal,
  options: { fetch: FetchLike; timeoutMs?: number },
): Promise<{ ok: true; models: string[]; latencyMs: number }> {
  const started = performance.now()
  const models = await listProviderModels(input, signal, options)
  return { ok: true, models, latencyMs: Math.round(performance.now() - started) }
}
