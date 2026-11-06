import type { HarnessPlugin } from '@latch/sdk'
import { responsesWire } from '../responses-wire.ts'
import { createServicePlugin, type ServiceConfig } from '../service.ts'

/** OpenAI Responses adapter with the same strictness as the Chat Completions adapter. */
export function createResponsesPlugin(config: ServiceConfig): HarnessPlugin {
  return createServicePlugin(config, responsesWire, {
    id: 'openai-responses',
    providerName: 'OpenAI Responses',
    pluginName: 'OpenAI Responses',
    version: '1.0.0',
    description: '通过 OpenAI Responses 接口流式调用模型；支持文字与多轮工具调用，服务发来的推理内容也会显示。',
  })
}
