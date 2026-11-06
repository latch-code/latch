import type { HarnessPlugin } from '@latch/sdk'
import { chatWire } from '../chat-wire.ts'
import { createServicePlugin, type ServiceConfig } from '../service.ts'

/** Chat Completions adapter. The plugin and provider ID defaults to the legacy `openai-compatible`. */
export function createOpenAIPlugin(config: ServiceConfig): HarnessPlugin {
  return createServicePlugin(config, chatWire, {
    id: 'openai-compatible',
    providerName: 'OpenAI 兼容接口',
    pluginName: 'OpenAI 兼容模型',
    version: '1.1.0',
    description: '通过 Chat Completions 接口调用用户配置的模型；支持流式文字、推理内容与多轮 function tool calls。',
  })
}
