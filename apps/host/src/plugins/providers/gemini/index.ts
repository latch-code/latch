import type { HarnessPlugin } from '@latch/sdk'
import { geminiWire } from '../gemini-wire.ts'
import { createServicePlugin, type ServiceConfig } from '../service.ts'

/** Gemini generateContent adapter with the same strictness as the Chat Completions adapter. */
export function createGeminiPlugin(config: ServiceConfig): HarnessPlugin {
  return createServicePlugin(config, geminiWire, {
    id: 'gemini',
    providerName: 'Gemini',
    pluginName: 'Gemini',
    version: '1.0.0',
    description: '通过 Gemini generateContent 接口流式调用模型；支持文字、思考摘要与多轮工具调用。',
  })
}
