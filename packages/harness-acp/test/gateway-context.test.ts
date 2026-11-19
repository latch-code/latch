import { describe, expect, it } from 'vitest'
import { profileFor } from '../src/profiles/index.ts'
import { claudeProfile } from '../src/profiles/claude-agent.ts'
import { dshWindowBudget } from '../src/profiles/dsh.ts'
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

  it('sizes DeepSeek Harness’s output and compaction headroom to a declared window, so it compacts before the window', () => {
    const launch = deliver('dsh', place())
    const patch = JSON.parse(Object.values(launch.files!)[0]!) as Array<{ id: string; config?: Record<string, unknown> }>
    const models = (
      patch.find(entry => entry.id === 'llm-pi-ai')!.config!.providers as Record<string, { models: Array<Record<string, unknown>> }>
    )['latch-gateway']!.models
    expect(models.map(model => [model.id, model.maxTokens])).toEqual([
      ['small', 16_000],
      ['plain', undefined],
    ])
    expect(patch.find(entry => entry.id === 'compaction-basic')!.config).toEqual({
      modelPolicies: [{ provider: 'latch-gateway', model: 'small', headroomTokens: 8_000 }],
    })
    // dsh-compaction-basic starts at floor(min(W × 0.8, W − O − headroom)) and keeps 16% of W − O: always a positive start
    // below the window, above what it keeps.
    for (const window of [1024, 64_000, 128_000, 200_000, 1_000_000, 16_777_216]) {
      const { maxTokens, headroomTokens } = dshWindowBudget(window)
      const start = Math.floor(Math.min(window * 0.8, window - maxTokens - headroomTokens))
      expect(start, String(window)).toBeGreaterThan(Math.floor((window - maxTokens) * 0.16))
      expect(start).toBeLessThan(window)
    }
    expect(
      [64_000, 200_000, 1_000_000].map(window => {
        const { maxTokens, headroomTokens } = dshWindowBudget(window)
        return Math.floor(Math.min(window * 0.8, window - maxTokens - headroomTokens))
      }),
    ).toEqual([40_000, 142_232, 800_000])
  })

  it('tells Claude a declared window through its own settings, the same on the adapter and directly, and nothing without one', () => {
    const anthropic = { ...route, wire: 'anthropic-messages' } as const
    const wide: GatewayPlace = { ...place(), models: [{ id: 'small', capabilities: { contextTokens: 200_000 } }] }
    for (const gateway of [profileFor('claude-agent')!.gateway!, claudeProfile.gateway!]) {
      if (gateway.via !== 'launch') throw new Error('Claude is delivered at launch')
      const env = (given: GatewayPlace, model = 'small') => gateway.deliver(given, { ...anthropic, model }).env!
      // Below 100,000 the auto-compact window cannot be set; the window itself is enough for an ID Claude does not know.
      expect(env(place())).toMatchObject({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: '64000' })
      expect(env(place())).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW')
      expect(env(wide)).toMatchObject({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' })
      expect(env(place(), 'plain')).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
      expect(env(place(), 'plain')).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW')
      expect(env(place())).toMatchObject({ CLAUDE_CODE_MAX_RETRIES: '2' })
      for (const name of Object.keys(env(wide))) expect(gateway.envNames).toContain(name)
    }
  })

  it('leaves Codex no retries of its own on the gateway: the gateway already tried what heals in seconds', () => {
    const gateway = profileFor('codex')!.gateway!
    if (gateway.via !== 'launch') throw new Error('Codex is delivered at launch')
    const args = gateway.deliver(place(), { ...route, wire: 'responses' }).args!
    expect(args).toContain('model_providers.latch.request_max_retries=0')
    expect(args).toContain('model_providers.latch.stream_max_retries=0')
  })
})
