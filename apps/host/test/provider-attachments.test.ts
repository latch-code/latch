import { describe, it, expect } from 'vitest'
import type { HarnessPlugin, ModelProvider } from '@latch/sdk'
import { createOpenAIPlugin } from '../src/plugins/providers/openai-compatible/index.ts'
import { createAnthropicPlugin } from '../src/plugins/providers/anthropic/index.ts'
const mount = async (plugin: HarnessPlugin) => {
  let provider!: ModelProvider
  await plugin.activate({
    registerProvider: p => {
      provider = p
    },
    registerTool: () => {},
    registerHarness: () => {},
    registerUiPanel: () => {},
    registerClientPanel: () => {},
    registerSkill: () => {},
    registerTransport: () => {},
    onDispose: () => {},
  })
  return provider
}
const messages = [
  {
    role: 'user' as const,
    content: 'look',
    attachments: [
      { type: 'text' as const, text: 'logs', name: 'note.txt' },
      { type: 'image' as const, mimeType: 'image/png' as const, data: 'aGVsbG8=' },
    ],
  },
]
describe('provider attachment wire formats', () => {
  it.each(['openai', 'anthropic'] as const)(
    'sends %s image and text blocks through the injected fetch and refuses undeclared vision',
    async kind => {
      const seen: unknown[] = []
      const config = {
        baseURL: 'http://127.0.0.1:1/v1',
        apiKey: '',
        model: 'vision',
        modelCapabilities: { vision: { vision: true } },
        fetch: async (_url: unknown, init?: RequestInit) => {
          seen.push(JSON.parse(String(init?.body)))
          throw new Error('captured')
        },
      }
      const provider = await mount(kind === 'openai' ? createOpenAIPlugin(config) : createAnthropicPlugin(config))
      await expect(
        (async () => {
          for await (const _part of provider.stream({ messages, tools: [], signal: new AbortController().signal })) {
          }
        })(),
      ).rejects.toThrow('captured')
      const wire = seen[0] as { messages: Array<{ content: unknown }> }
      expect(wire.messages[0]!.content).toEqual(
        kind === 'openai'
          ? [
              { type: 'text', text: 'look' },
              { type: 'text', text: '[附件：note.txt]\nlogs' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
            ]
          : [
              { type: 'text', text: 'look' },
              { type: 'text', text: '[附件：note.txt]\nlogs' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
            ],
      )
      const unsupported = await mount(
        kind === 'openai'
          ? createOpenAIPlugin({ ...config, modelCapabilities: {} })
          : createAnthropicPlugin({ ...config, modelCapabilities: {} }),
      )
      await expect(
        (async () => {
          for await (const _part of unsupported.stream({ messages, tools: [], signal: new AbortController().signal })) {
          }
        })(),
      ).rejects.toMatchObject({ code: 'model-vision-unsupported' })
      expect(seen).toHaveLength(1)
    },
  )
})
