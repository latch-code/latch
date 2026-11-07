// The Gemini generateContent protocol: address, headers, request body, stream decoding and the model listing. Pure:
// requests go out through the caller's fetch, so the built-in plugin and the Host's service checks share one copy.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ModelDelta, ModelMessage, ToolCall } from '@latch/sdk'
import {
  MAX_TOOL_ARGUMENT_CHARS,
  MAX_TOOL_CALLS,
  ProviderError,
  errorMessage,
  invalidListing,
  parseBaseURL,
  sseData,
  type ModelPage,
  type ModelWire,
  type WireRequest,
} from './http.ts'

const MAX_LIST_PAGES = 10
const MAX_SIGNATURE_CHARS = 1024 * 1024
/**
 * Google's documented value for a call the model did not make with this history, such as one made by another service.
 * Gemini 3 refuses a model turn whose first call has no signature.
 */
const SKIP_SIGNATURE = 'skip_thought_signature_validator'

/** Accepts `https://generativelanguage.googleapis.com` and a base that already names its version. */
export function geminiEndpoint(baseURL: string, path: string): URL {
  const url = parseBaseURL(baseURL)
  const prefix = url.pathname.replace(/\/+$/u, '')
  url.pathname = `${/\/v1(?:beta|alpha)?$/u.test(prefix) ? prefix : `${prefix}/v1beta`}${path}`
  return url
}

export function geminiHeaders(apiKey: string): Record<string, string> {
  // In the header, never the URL's `key=`: a URL ends up in logs.
  return apiKey ? { 'x-goog-api-key': apiKey } : {}
}

function streamURL(baseURL: string, model: string): string {
  const url = geminiEndpoint(baseURL, `/models/${encodeURIComponent(model.replace(/^models\//u, ''))}:streamGenerateContent`)
  url.searchParams.set('alt', 'sse')
  return url.toString()
}

type Part = Record<string, unknown>
interface Content {
  role: 'user' | 'model'
  parts: Part[]
}

/**
 * generateContent history: system text is `systemInstruction`, tool results are user parts named after their call, and
 * the first call of each model turn carries its signature, or the skip value when this service and model did not make it.
 */
function contentsOnWire(messages: ModelMessage[], signer: string): { systemInstruction?: { parts: Part[] }; contents: Content[] } {
  const system: string[] = []
  const contents: Content[] = []
  const names = new Map<string, string>()
  const append = (role: Content['role'], parts: Part[]) => {
    if (!parts.length) return
    const last = contents.at(-1)
    if (last?.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }
  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content.trim()) system.push(message.content)
    } else if (message.role === 'user') {
      append('user', [
        ...(message.content.trim() ? [{ text: message.content }] : []),
        ...(message.attachments ?? []).map(part =>
          part.type === 'text'
            ? { text: `[附件：${part.name}]\n${part.text}` }
            : { inlineData: { mimeType: part.mimeType, data: part.data } },
        ),
      ])
    } else if (message.role === 'assistant') {
      append('model', [
        ...(message.content.trim() ? [{ text: message.content }] : []),
        ...(message.toolCalls ?? []).map((call, index) => {
          names.set(call.id, call.name)
          const own = call.signature?.by === signer ? call.signature.value : undefined
          const signature = own ?? (index === 0 ? SKIP_SIGNATURE : undefined)
          return {
            functionCall: { id: call.id, name: call.name, args: call.arguments },
            ...(signature ? { thoughtSignature: signature } : {}),
          }
        }),
      ])
    } else {
      const name = message.toolCallId ? names.get(message.toolCallId) : undefined
      if (!message.toolCallId || !name) throw new ProviderError('工具结果找不到对应的工具调用。', 'invalid-history')
      append('user', [
        {
          functionResponse: {
            id: message.toolCallId,
            name,
            response: message.isError ? { error: message.content } : { output: message.content },
          },
        },
      ])
    }
  }
  return { ...(system.length ? { systemInstruction: { parts: [{ text: system.join('\n\n') }] } } : {}), contents }
}

function encodeGeminiRequest({ messages, tools, effort, signer }: WireRequest): Record<string, unknown> {
  return {
    ...contentsOnWire(messages, signer),
    ...(tools.length
      ? {
          tools: [
            {
              functionDeclarations: tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: tool.parameters,
              })),
            },
          ],
        }
      : {}),
    // Levels are declared in lower case like every protocol's; the API's enum is upper case.
    ...(effort ? { generationConfig: { thinkingConfig: { thinkingLevel: effort.toUpperCase(), includeThoughts: true } } } : {}),
  }
}

const count = z.number().int().nonnegative().optional()
const usageSchema = z.object({
  promptTokenCount: count,
  cachedContentTokenCount: count,
  candidatesTokenCount: count,
  thoughtsTokenCount: count,
})
const partSchema = z.object({
  text: z.string().optional(),
  thought: z.boolean().optional(),
  thoughtSignature: z.string().optional(),
  functionCall: z.object({ id: z.string().optional(), name: z.string(), args: z.record(z.string(), z.unknown()).optional() }).optional(),
})
const chunkSchema = z.object({
  candidates: z
    .array(
      z.object({
        index: z.number().int().nonnegative().optional(),
        content: z.object({ parts: z.array(partSchema).optional() }).optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: usageSchema.optional(),
  error: z.unknown().optional(),
})

const REFUSALS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'])

/** A stop reason other than `STOP` fails the turn; the service's words are redacted like any other text it sends. */
function terminal(reason: string, safeError: (text: string) => string): 'stop' {
  if (reason === 'STOP') return 'stop'
  const shown = safeError(reason).slice(0, 64)
  if (reason === 'MAX_TOKENS') throw new ProviderError('模型输出达到长度上限，回复未完成。', 'model-incomplete')
  if (REFUSALS.has(reason)) throw new ProviderError(`模型拒绝了请求：${shown}。`, 'model-refusal')
  if (reason === 'MALFORMED_FUNCTION_CALL') throw new ProviderError('模型返回了格式错误的工具调用。', 'invalid-tool-call')
  throw new ProviderError(`模型未正常完成：${shown}。`, 'model-incomplete')
}

/** Decodes a generateContent SSE stream with the same strictness as the other decoders. */
async function* decodeGeminiStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  safeError: (text: string) => string,
  signer: string,
): AsyncIterable<ModelDelta> {
  const calls: ToolCall[] = []
  let usage: z.infer<typeof usageSchema> | undefined
  let finished = false
  for await (const payload of sseData(body, signal)) {
    signal.throwIfAborted()
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      throw new ProviderError('模型服务返回无效的 SSE JSON。', 'invalid-json')
    }
    const checked = chunkSchema.safeParse(parsed)
    if (!checked.success) throw new ProviderError('模型服务的流事件字段无效。', 'invalid-chunk')
    const chunk = checked.data
    if (chunk.error != null) throw new ProviderError(safeError(errorMessage(chunk.error)), 'upstream-error')
    const blocked = chunk.promptFeedback?.blockReason
    if (blocked) throw new ProviderError(`模型服务拦截了这次输入：${safeError(blocked).slice(0, 64)}。`, 'model-refusal')
    if (chunk.usageMetadata) usage = chunk.usageMetadata
    const candidates = chunk.candidates ?? []
    if (candidates.length > 1 || candidates.some(candidate => (candidate.index ?? 0) !== 0))
      throw new ProviderError('模型服务返回了未请求的多个候选。', 'invalid-choice')
    const candidate = candidates[0]
    for (const part of candidate?.content?.parts ?? []) {
      if (finished && (part.text || part.functionCall)) throw new ProviderError('模型在结束后继续发送内容。', 'invalid-chunk')
      if (part.functionCall) {
        const { id, name, args = {} } = part.functionCall
        const signature = part.thoughtSignature
        if (name.length > 256 || (id?.length ?? 0) > 512 || (signature?.length ?? 0) > MAX_SIGNATURE_CHARS)
          throw new ProviderError('工具调用超出大小限制。', 'stream-limit')
        if (JSON.stringify(args).length > MAX_TOOL_ARGUMENT_CHARS) throw new ProviderError('工具调用超出大小限制。', 'stream-limit')
        // The Developer API may leave the ID out; the result is matched by the ID this call is sent back with.
        calls.push({
          id: id || `call_${randomUUID()}`,
          name,
          arguments: args,
          ...(signature ? { signature: { by: signer, value: signature } } : {}),
        })
        if (calls.length > MAX_TOOL_CALLS) throw new ProviderError('模型一次请求了过多工具。', 'stream-limit')
      } else if (part.text) yield { type: part.thought ? 'reasoning' : 'text', text: part.text }
    }
    if (candidate?.finishReason) {
      terminal(candidate.finishReason, safeError)
      finished = true
    }
  }
  signal.throwIfAborted()
  if (!finished) throw new ProviderError('模型流未给出结束状态，不能确认调用完成。', 'stream-incomplete')
  const ids = new Set<string>()
  for (const call of calls) {
    if (!call.name || ids.has(call.id)) throw new ProviderError('工具调用缺少唯一 ID 或名称。', 'invalid-tool-call')
    ids.add(call.id)
  }
  if (usage) {
    const thoughts = usage.thoughtsTokenCount
    yield {
      type: 'usage',
      inputTokens: usage.promptTokenCount ?? 0,
      // Thoughts are output too; the service counts them apart from the candidates.
      outputTokens: (usage.candidatesTokenCount ?? 0) + (thoughts ?? 0),
      ...(usage.cachedContentTokenCount != null ? { cacheReadTokens: usage.cachedContentTokenCount } : {}),
      ...(thoughts != null ? { reasoningTokens: thoughts } : {}),
    }
  }
  for (const call of calls) yield { type: 'tool-call', call }
  yield { type: 'finish', reason: calls.length ? 'tool-calls' : 'stop' }
}

const listingSchema = z.object({
  models: z.array(z.object({ name: z.string(), supportedGenerationMethods: z.array(z.string()).optional() })).optional(),
  nextPageToken: z.string().optional(),
})

/** Every page of `/models`, up to ten, keeping the models that generate content. */
async function listGeminiModels(baseURL: string, apiKey: string, page: ModelPage): Promise<Array<{ id: string }>> {
  const endpoint = geminiEndpoint(baseURL, '/models')
  endpoint.searchParams.set('pageSize', '1000')
  const models: Array<{ id: string }> = []
  for (let index = 0; index < MAX_LIST_PAGES; index++) {
    const result = listingSchema.safeParse(await page(endpoint.toString(), geminiHeaders(apiKey)))
    if (!result.success) throw invalidListing()
    for (const model of result.data.models ?? [])
      if (!model.supportedGenerationMethods || model.supportedGenerationMethods.includes('generateContent'))
        models.push({ id: model.name.replace(/^models\//u, '') })
    if (!result.data.nextPageToken) break
    endpoint.searchParams.set('pageToken', result.data.nextPageToken)
  }
  return models
}

export const geminiWire: ModelWire = {
  request: (baseURL, apiKey, request) => ({
    url: streamURL(baseURL, request.model),
    headers: geminiHeaders(apiKey),
    body: encodeGeminiRequest(request),
  }),
  decode: decodeGeminiStream,
  listModels: listGeminiModels,
}
