import type { ModelCapabilities } from '@latch/protocol'
import type { HarnessPlugin, ModelDelta, ModelProvider } from '@latch/sdk'
import { anthropicEndpoint, anthropicHeaders, decodeAnthropicStream, encodeAnthropicRequest } from '../anthropic-wire.ts'
import { ProviderError, modelList, openEventStream, redactor, selectEffort, selectModel, type FetchLike } from '../http.ts'

export interface AnthropicConfig {
  id?: string
  name?: string
  baseURL: string
  apiKey: string
  model: string
  models?: string[]
  modelCapabilities?: Record<string, ModelCapabilities>
  /** Every request goes through it. The Host passes its egress-checked fetch; defaults to `globalThis.fetch`. */
  fetch?: FetchLike
}

/** Native Messages API adapter with the same strictness as the Chat Completions adapter. */
export function createAnthropicPlugin(config: AnthropicConfig): HarnessPlugin {
  const endpoint = anthropicEndpoint(config.baseURL, '/messages')
  if (/[\r\n]/u.test(config.apiKey)) throw new Error('API Key 包含无效换行。')
  const models = modelList(config.model, config.models)
  const id = config.id ?? 'anthropic'
  const apiKey = config.apiKey
  const redacted = redactor(apiKey)
  const fetcher: FetchLike = config.fetch ?? ((input, init) => globalThis.fetch(input, init))

  const provider: ModelProvider = {
    id,
    name: config.name ?? 'Anthropic',
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
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...anthropicHeaders(apiKey) },
          body: JSON.stringify(encodeAnthropicRequest({ model, messages, tools, ...(effort ? { effort } : {}) })),
        },
        safeError,
      )
      yield* decodeAnthropicStream(body, signal, safeError)
    },
  }
  return {
    id,
    name: config.name ?? 'Anthropic',
    version: '1.0.0',
    description: '通过 Anthropic Messages 接口流式调用模型；支持文字、推理内容与多轮工具调用。',
    activate(context) {
      context.registerProvider(provider)
    },
  }
}
