import type { ModelCapabilities } from '@latch/protocol'
import type { HarnessPlugin, ModelDelta, ModelProvider } from '@latch/sdk'
import { chatEndpoint, chatHeaders, decodeChatStream, encodeChatRequest } from '../chat-wire.ts'
import { ProviderError, modelList, openEventStream, redactor, selectEffort, selectModel, type FetchLike } from '../http.ts'

export interface OpenAIConfig {
  /** Plugin and provider ID. Defaults to the legacy `openai-compatible`. */
  id?: string
  name?: string
  baseURL: string
  apiKey: string
  /** Default model ID. */
  model: string
  /** Models a request may choose. Empty or absent accepts any requested model. */
  models?: string[]
  modelCapabilities?: Record<string, ModelCapabilities>
  /** Every request goes through it. The Host passes its egress-checked fetch; defaults to `globalThis.fetch`. */
  fetch?: FetchLike
}

/** Chat Completions adapter. Protocol failures stay failures; there is no demo fallback. */
export function createOpenAIPlugin(config: OpenAIConfig): HarnessPlugin {
  const endpoint = chatEndpoint(config.baseURL, '/chat/completions')
  if (/[\r\n]/u.test(config.apiKey)) throw new Error('API Key 包含无效换行。')
  const models = modelList(config.model, config.models)
  const id = config.id ?? 'openai-compatible'
  const apiKey = config.apiKey
  const redacted = redactor(apiKey)
  const fetcher: FetchLike = config.fetch ?? ((input, init) => globalThis.fetch(input, init))

  const provider: ModelProvider = {
    id,
    name: config.name ?? 'OpenAI 兼容接口',
    model: config.model,
    ...(config.modelCapabilities ? { modelCapabilities: structuredClone(config.modelCapabilities) } : {}),
    ...(models ? { models } : {}),
    async *stream({ messages, tools, signal, model: requested, effort: requestedEffort }): AsyncIterable<ModelDelta> {
      signal.throwIfAborted()
      const safeError = messages.some(message => message.attachments?.length)
        ? (_text: string) => '模型服务无法处理本次附件请求。'
        : redacted
      const model = selectModel(requested, config.model, models)
      const effort = selectEffort(requestedEffort, model, config.modelCapabilities?.[model]?.thinking)
      if (
        messages.some(message => message.attachments?.some(part => part.type === 'image'))
        && config.modelCapabilities?.[model]?.vision !== true
      )
        throw new ProviderError('当前模型不能看图片。', 'model-vision-unsupported')
      const body = await openEventStream(
        fetcher,
        endpoint,
        {
          method: 'POST',
          signal,
          redirect: 'error',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...chatHeaders(apiKey) },
          body: JSON.stringify(encodeChatRequest({ model, messages, tools, ...(effort ? { effort } : {}) })),
        },
        safeError,
      )
      yield* decodeChatStream(body, signal, safeError)
    },
  }
  return {
    id,
    name: config.name ?? 'OpenAI 兼容模型',
    version: '1.1.0',
    description: '通过 Chat Completions 接口调用用户配置的模型；支持流式文字、推理内容与多轮 function tool calls。',
    activate(context) {
      context.registerProvider(provider)
    },
  }
}
