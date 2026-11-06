import type { HarnessPlugin } from '@latch/sdk'
import { anthropicWire } from '../anthropic-wire.ts'
import { createServicePlugin, type ServiceConfig } from '../service.ts'

/** Native Messages API adapter with the same strictness as the Chat Completions adapter. */
export function createAnthropicPlugin(config: ServiceConfig): HarnessPlugin {
  return createServicePlugin(config, anthropicWire, {
    id: 'anthropic',
    providerName: 'Anthropic',
    pluginName: 'Anthropic',
    version: '1.0.0',
    description: '通过 Anthropic Messages 接口流式调用模型；支持文字、推理内容与多轮工具调用。',
  })
}
