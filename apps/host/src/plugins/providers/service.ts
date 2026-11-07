// The built-in model service plugin, shared by every protocol: configuration checks, model and thinking selection,
// the request through the caller's fetch and the protocol's stream decoder.
import type { ModelCapabilities } from '@latch/protocol'
import type { HarnessPlugin, ModelDelta, ModelProvider } from '@latch/sdk'
import {
  ProviderError,
  modelList,
  openEventStream,
  parseBaseURL,
  redactor,
  selectEffort,
  selectModel,
  type FetchLike,
  type ModelWire,
} from './http.ts'

export interface ServiceConfig {
  /** Plugin and provider ID. */
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

/** What one protocol's plugin is called when the configuration does not say. */
export interface ServicePluginInfo {
  id: string
  providerName: string
  pluginName: string
  version: string
  description: string
}

/** A protocol adapter. Protocol failures stay failures; there is no demo fallback. */
export function createServicePlugin(config: ServiceConfig, wire: ModelWire, info: ServicePluginInfo): HarnessPlugin {
  parseBaseURL(config.baseURL)
  if (/[\r\n]/u.test(config.apiKey)) throw new Error('API Key 包含无效换行。')
  const models = modelList(config.model, config.models)
  const id = config.id ?? info.id
  const apiKey = config.apiKey
  const redacted = redactor(apiKey)
  const fetcher: FetchLike = config.fetch ?? ((input, init) => globalThis.fetch(input, init))

  const provider: ModelProvider = {
    id,
    name: config.name ?? info.providerName,
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
      // A saved service can change protocol, and one protocol's signature means nothing to another.
      const signer = `${info.id}\n${id}\n${model}`
      const call = wire.request(config.baseURL, apiKey, { model, messages, tools, signer, ...(effort ? { effort } : {}) })
      const body = await openEventStream(
        fetcher,
        call.url,
        {
          method: 'POST',
          signal,
          redirect: 'error',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...call.headers },
          body: JSON.stringify(call.body),
        },
        safeError,
      )
      yield* wire.decode(body, signal, safeError, signer)
    },
  }
  return {
    id,
    name: config.name ?? info.pluginName,
    version: info.version,
    description: info.description,
    activate(context) {
      context.registerProvider(provider)
    },
  }
}
