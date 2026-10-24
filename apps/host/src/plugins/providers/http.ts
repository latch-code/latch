// HTTP plumbing shared by the built-in model protocols (openai-compatible/, anthropic/) and the Host's model
// service checks. Not a plugin: plugin directories may import this file, never each other.
import { z } from 'zod'

/**
 * The Host's outbound `fetch`. Declared here rather than imported, because plugins never import
 * the Host; it is structurally identical to the Host egress module's type.
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly target?: string,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

function egressCode(value: unknown): value is { code: 'egress-denied'; target?: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value && value.code === 'egress-denied'
}

/**
 * The egress denial carried by a failed request: thrown directly (redirect, protocol) or as the
 * cause of the `fetch failed` TypeError raised from the connector. Undefined for any other failure.
 */
export function egressDenial(error: unknown): ProviderError | undefined {
  const denied = egressCode(error) ? error : error instanceof Error && egressCode(error.cause) ? error.cause : undefined
  if (!denied) return undefined
  const target = typeof denied.target === 'string' ? denied.target.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 300) : ''
  return new ProviderError(`Host 出站策略拒绝访问 ${target || '该地址'}（本机、私网或元数据地址）。`, 'egress-denied', undefined, target)
}

/** Sends one request; an egress denial becomes a ProviderError, every other failure is rethrown unchanged. */
export async function send(fetcher: FetchLike, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(url, init)
  } catch (error) {
    throw egressDenial(error) ?? error
  }
}

const MAX_EVENT_CHARS = 1024 * 1024
export const MAX_TOOL_ARGUMENT_CHARS = 1024 * 1024
export const MAX_TOOL_CALLS = 128

/** Validates a user-supplied API base URL. Credentials belong in the API key, never in the URL. */
export function parseBaseURL(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ProviderError('模型地址不是有效的 URL。', 'invalid-url')
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ProviderError('模型地址必须是无内嵌凭据、查询参数或片段的 HTTP(S) API base URL。', 'invalid-url')
  }
  return url
}

const MAX_ERROR_CHARS = 512

/**
 * Redacts the key, then clips to 512 characters. Upstreams may echo the key JSON-escaped or URL-encoded, so those
 * forms are redacted too; a clipped tail that is still the start of the key is dropped as well.
 */
export function redactor(apiKey: string): (text: string) => string {
  if (!apiKey) return text => text.slice(0, MAX_ERROR_CHARS)
  const json = JSON.stringify(apiKey).slice(1, -1)
  const forms = [...new Set([apiKey, json, json.replace(/\//gu, '\\/'), encodeURIComponent(apiKey)])].sort((a, b) => b.length - a.length)
  return text => {
    let output = text
    for (const form of forms) output = output.split(form).join('[redacted]')
    output = output.slice(0, MAX_ERROR_CHARS)
    for (const form of forms) {
      for (let length = Math.min(form.length - 1, output.length); length >= 4; length--) {
        if (output.endsWith(form.slice(0, length))) return `${output.slice(0, -length)}[redacted]`
      }
    }
    return output
  }
}

/** Checks the static model configuration shared by provider adapters. */
export function modelList(model: string, models: readonly string[] | undefined): string[] | undefined {
  if (!model.trim()) throw new Error('必须指定模型 ID。')
  if (!models?.length) return undefined
  if (!models.includes(model)) throw new Error('默认模型必须在模型列表中。')
  return [...new Set(models)]
}

/** A requested model is used as-is or refused; it is never silently replaced by the default. */
export function selectModel(requested: string | undefined, model: string, models: readonly string[] | undefined): string {
  if (requested === undefined) return model
  if (!requested.trim() || requested.length > 200 || (models?.length && !models.includes(requested))) {
    throw new ProviderError(`模型 ${requested.slice(0, 200)} 未在此服务中启用。`, 'model-unavailable')
  }
  return requested
}

/** SSE `data` payloads. Framing is independent of UTF-8, TCP chunks and CRLF boundaries. */
export async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let data: string[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      while (true) {
        const boundary = buffer.search(/[\r\n]/u)
        if (boundary < 0 || (!done && boundary === buffer.length - 1 && buffer[boundary] === '\r')) break
        const line = buffer.slice(0, boundary)
        const length = buffer[boundary] === '\r' && buffer[boundary + 1] === '\n' ? 2 : 1
        buffer = buffer.slice(boundary + length)
        size += line.length
        if (size > MAX_EVENT_CHARS) throw new ProviderError('模型流事件过大。', 'stream-limit')
        if (line === '') {
          if (data.length) yield data.join('\n')
          data = []
          size = 0
        } else if (line === 'data' || line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /u, ''))
        }
      }
      if (buffer.length + size > MAX_EVENT_CHARS) throw new ProviderError('模型流事件过大。', 'stream-limit')
      if (done) {
        if (buffer.trim() !== '' || data.length) throw new ProviderError('模型流在事件结束前断开。', 'stream-incomplete')
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {
      /* An aborted fetch may already have closed the reader. */
    })
    reader.releaseLock()
  }
}

/** An error response's text, at most 4 KiB. Callers pass it through `redactor`, which also clips it. */
export async function readErrorBody(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (length < 4096) {
      const next = await reader.read()
      if (next.done) break
      const part = next.value.subarray(0, 4096 - length)
      chunks.push(part)
      length += part.length
    }
  } finally {
    await reader.cancel().catch(() => {
      /* The error response may already have ended. */
    })
    reader.releaseLock()
  }
  // Not clipped here: `redactor` must see the whole key before it clips, or a key cut at the boundary survives.
  return new TextDecoder().decode(Buffer.concat(chunks))
}

export function errorMessage(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string') return value.message
  return typeof value === 'string' ? value : '供应商返回错误。'
}

/** Parses streamed tool arguments; models must send a JSON object. */
export function toolArguments(name: string, text: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ProviderError(`工具 ${name} 的参数不是有效 JSON。`, 'invalid-tool-json')
  }
  const record = z.record(z.string(), z.unknown()).safeParse(value)
  if (!record.success) throw new ProviderError(`工具 ${name} 的参数必须是对象。`, 'invalid-tool-json')
  return record.data
}
