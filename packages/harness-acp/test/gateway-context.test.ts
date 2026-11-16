import { describe, expect, it } from 'vitest'
import { profileFor } from '../src/profiles/index.ts'
import type { GatewayPlace } from '../src/profiles/types.ts'

const place = (files: Record<string, string> = {}): GatewayPlace => ({
  baseURL: 'http://127.0.0.1:4100/gateway',
  models: [{ id: 'small', capabilities: { contextTokens: 64_000 } }, { id: 'plain' }],
  file: name => {
    files[name] = name
    return `/private/session/gateway/${name}`
  },
})
function deliver(presetId: string, given: GatewayPlace) {
  const gateway = profileFor(presetId)!.gateway!
  if (gateway.via !== 'launch') throw new Error(`${presetId} is not delivered at launch`)
  return gateway.deliver(given, route)
}

const route = { providerId: 'service', model: 'small', wire: 'chat-completions', origin: 'https://example.invalid' } as const

describe('a declared context window on the gateway wires', () => {
  it('gives OpenCode the window as the model’s `limit.context`, and nothing for a model without one', () => {
    const launch = deliver('opencode', place())
    const config = JSON.parse(launch.env!.OPENCODE_CONFIG_CONTENT!) as {
      providers: { latch: { models: Record<string, { limit?: unknown }> } }
    }
    expect(config.providers.latch.models.small!.limit).toEqual({ context: 64_000 })
    expect(config.providers.latch.models.plain).not.toHaveProperty('limit')
  })

  it('gives DeepSeek Harness the window as the llm-pi-ai model’s `contextWindow`', () => {
    const launch = deliver('dsh', place())
    const patch = JSON.parse(Object.values(launch.files!)[0]!) as Array<{
      id: string
      config?: { providers?: Record<string, { models: Array<{ id: string; contextWindow?: number }> }> }
    }>
    const models = patch.find(entry => entry.id === 'llm-pi-ai')!.config!.providers!['latch-gateway']!.models
    expect(models.map(model => [model.id, model.contextWindow])).toEqual([
      ['small', 64_000],
      ['plain', undefined],
    ])
  })
})
