import { z } from 'zod'
import type { HarnessPlugin, ModelProvider } from '../core/plugins.ts'
import { anthropicEndpoint, anthropicHeaders, createAnthropicPlugin } from '../plugins/anthropic.ts'
import { ProviderError, createOpenAIPlugin, openaiEndpoint, readErrorBody, redactor, send, type FetchLike } from '../plugins/openai.ts'
import type { ProviderKind, ProviderSettings, ProviderSummary } from '../shared/types.ts'
import { originOf, type ProviderRecord } from './config.ts'

export { originOf }

const factories: Record<ProviderKind, typeof createOpenAIPlugin> = {
  'openai-compatible': createOpenAIPlugin,
  anthropic: createAnthropicPlugin,
}

/** The stored key, only while the base URL still has the origin it was saved for; otherwise ''. */
export function usableKey(record: ProviderRecord): string {
  if (!record.apiKey || !record.keyOrigin) return ''
  try { return originOf(record.baseURL) === record.keyOrigin ? record.apiKey : '' } catch { return '' }
}

/** One plugin per configured provider; the plugin ID equals the provider ID. Requests go through `deps.fetch`. */
export function providerPlugin(record: ProviderRecord, deps: { fetch: FetchLike }): HarnessPlugin {
  return factories[record.kind]({
    id: record.id, name: record.name, baseURL: record.baseURL, apiKey: usableKey(record),
    model: record.defaultModel, models: record.models, fetch: deps.fetch,
  })
}

/** Owner-facing view of a stored provider. The key itself never leaves the Host; a key bound to another origin counts as absent. */
export function providerSettings(record: ProviderRecord): ProviderSettings {
  const usable = Boolean(usableKey(record))
  return {
    id: record.id, name: record.name, kind: record.kind, ...(record.presetId ? { presetId: record.presetId } : {}),
    baseURL: record.baseURL, hasKey: usable, ...(usable ? { keyOrigin: record.keyOrigin } : {}), enabled: record.enabled,
    models: [...record.models], defaultModel: record.defaultModel,
  }
}

/** Mirrors the runtime's model check: `models` when declared, else only the default. */
export function summarizeProvider(provider: ModelProvider, kind: ProviderSummary['kind']): ProviderSummary {
  return { id: provider.id, name: provider.name, kind, models: [...provider.models ?? [provider.model]], defaultModel: provider.model }
}

const LIST_TIMEOUT_MS = 10_000
const MAX_LIST_BYTES = 8 * 1024 * 1024
const MAX_LISTED_MODELS = 5000
const MAX_LIST_PAGES = 10
const listSchema = z.union([
  z.object({
    data: z.array(z.object({ id: z.string() })),
    has_more: z.boolean().optional(),
    last_id: z.string().nullable().optional(),
  }),
  z.array(z.object({ id: z.string() })).transform(data => ({ data, has_more: false, last_id: null })),
])

export interface ModelListInput { kind: ProviderKind; baseURL: string; apiKey: string }

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
    throw new ProviderError(response.body ? '模型列表响应过大。' : '模型服务没有返回响应体。', response.body ? 'response-too-large' : 'empty-response')
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
    await reader.cancel().catch(() => { /* The body may already have ended. */ })
    reader.releaseLock()
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) } catch {
    throw new ProviderError('模型列表不是有效的 UTF-8 文本。', 'invalid-response')
  }
}

async function fetchPage(fetcher: FetchLike, url: string, headers: Record<string, string>, signal: AbortSignal, redacted: (text: string) => string) {
  const response = await send(fetcher, url, { method: 'GET', signal, redirect: 'error', headers: { accept: 'application/json', ...headers } })
  if (!response.ok) {
    throw new ProviderError(`${failureHint(response.status)}（HTTP ${response.status}）：${redacted(await readErrorBody(response))}`, 'http-error', response.status)
  }
  let value: unknown
  try { value = JSON.parse(await readLimited(response, signal)) } catch (error) {
    if (error instanceof ProviderError) throw error
    throw new ProviderError('模型列表不是有效的 JSON。', 'invalid-response')
  }
  const page = listSchema.safeParse(value)
  if (!page.success) throw new ProviderError('模型列表格式无效。', 'invalid-response')
  return page.data
}

function networkFailure(error: unknown, redacted: (text: string) => string): ProviderError {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined
  const detail = cause ? ('code' in cause && typeof cause.code === 'string' ? cause.code : cause.message) : error instanceof Error ? error.message : String(error)
  if (/redirect/iu.test(detail)) return new ProviderError('模型服务返回了重定向，请填写最终的 API 地址。', 'redirect')
  return new ProviderError(`无法连接模型服务：${redacted(detail)}`, 'network-error')
}

/**
 * Lists remote model IDs with the given key; it spends no tokens. Requests go through `options.fetch`
 * (the Host's egress policy) and never follow redirects, so the key is only sent to the configured
 * origin. Errors are ProviderErrors with the key redacted; a denied address is `egress-denied` with `target`.
 */
export async function listProviderModels(input: ModelListInput, signal: AbortSignal, options: { fetch: FetchLike; timeoutMs?: number }): Promise<string[]> {
  signal.throwIfAborted()
  if (/[\r\n]/u.test(input.apiKey)) throw new ProviderError('API Key 包含无效换行。', 'invalid-key')
  const timeout = AbortSignal.timeout(options.timeoutMs ?? LIST_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, timeout])
  const redacted = redactor(input.apiKey)
  const models = new Set<string>()
  const collect = (data: Array<{ id: string }>) => {
    for (const { id } of data) {
      const model = id.trim()
      // Store limits; unusable IDs are skipped rather than failing the whole list.
      if (model && model.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(model)) models.add(model)
    }
    if (models.size > MAX_LISTED_MODELS) throw new ProviderError('模型列表条目过多。', 'response-too-large')
  }
  try {
    if (input.kind === 'openai-compatible') {
      const headers: Record<string, string> = input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}
      collect((await fetchPage(options.fetch, openaiEndpoint(input.baseURL, '/models'), headers, combined, redacted)).data)
    } else {
      const endpoint = new URL(anthropicEndpoint(input.baseURL, '/models'))
      endpoint.searchParams.set('limit', '1000')
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await fetchPage(options.fetch, endpoint.toString(), anthropicHeaders(input.apiKey), combined, redacted)
        collect(result.data)
        if (!result.has_more || !result.last_id) break
        endpoint.searchParams.set('after_id', result.last_id)
      }
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
export async function checkProvider(input: ModelListInput, signal: AbortSignal, options: { fetch: FetchLike; timeoutMs?: number }): Promise<{ ok: true; models: string[]; latencyMs: number }> {
  const started = performance.now()
  const models = await listProviderModels(input, signal, options)
  return { ok: true, models, latencyMs: Math.round(performance.now() - started) }
}
