import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { deliverPiGateway, piGatewayBudget, piGatewayStartupFailure } from '../src/profiles/pi-gateway.ts'

describe('pi gateway operating budgets', () => {
  it('leaves missing bounds for the exact official catalog rather than inventing a capacity', () => {
    expect(piGatewayBudget({})).toBeUndefined()
  })

  it('accepts explicit positive bounds including the documented maxima', () => {
    expect(piGatewayBudget({ PI_GATEWAY_CONTEXT_TOKENS: '32768', PI_GATEWAY_OUTPUT_TOKENS: '4096' })).toEqual({
      contextTokens: 32768,
      outputTokens: 4096,
    })
    expect(piGatewayBudget({ PI_GATEWAY_CONTEXT_TOKENS: '16777216', PI_GATEWAY_OUTPUT_TOKENS: '1048576' })).toEqual({
      contextTokens: 16777216,
      outputTokens: 1048576,
    })
  })

  it.each([
    ['0', '1'],
    ['10', '11'],
    ['1.2', '1'],
    ['1e6', '1'],
    ['-1', '1'],
    [' 10', '1'],
    ['16777217', '1'],
    ['16777216', '1048577'],
    ['NaN', '1'],
    ['Infinity', '1'],
    ['10', undefined],
    [undefined, '1'],
  ])('refuses invalid context %s and output %s before starting an Agent', (context, output) => {
    const env = {
      ...(context === undefined ? {} : { PI_GATEWAY_CONTEXT_TOKENS: context }),
      ...(output === undefined ? {} : { PI_GATEWAY_OUTPUT_TOKENS: output }),
    }
    expect(() => piGatewayBudget(env)).toThrow(expect.objectContaining({ code: 'invalid-gateway-budget' }))
  })

  it('maps only its own fixed startup marker to an actionable message, never copies arbitrary stderr', () => {
    expect(piGatewayStartupFailure('unrelated private output')).toBeUndefined()
    expect(piGatewayStartupFailure('Error: LATCH_PI_GATEWAY_BUDGET_REQUIRED\nprivate data')).toContain('PI_GATEWAY_CONTEXT_TOKENS')
    expect(piGatewayStartupFailure('Error: LATCH_PI_GATEWAY_BUDGET_REQUIRED\nprivate data')).not.toContain('private data')
  })
})

it.each(['gemini', 'chat-completions', 'responses', 'anthropic-messages'] as const)(
  'runs the delivered pi extension for %s with scoped streaming, bounded output and an in-memory credential across reloads',
  async wire => {
    const root = await mkdtemp(join(tmpdir(), 'latch-pi-gateway-extension-'))
    const file = join(root, 'pi-gateway.mjs')
    const url = pathToFileURL(file).href
    const key = `lmg1.${'g'.repeat(43)}`
    try {
      const module = join(root, 'node_modules', '@earendil-works', 'pi-ai')
      await mkdir(module, { recursive: true })
      await writeFile(
        join(module, 'package.json'),
        JSON.stringify({
          type: 'module',
          exports: { './providers/all': './catalog.mjs', './models': './models.mjs', './compat': './stream.mjs' },
        }),
      )
      await writeFile(join(module, 'catalog.mjs'), 'export const getBuiltinProviders = () => []; export const getBuiltinModels = () => [];')
      await writeFile(join(module, 'models.mjs'), 'export const clampThinkingLevel = (_model, level) => level;')
      await writeFile(
        join(module, 'stream.mjs'),
        'const api = () => ({ streamSimple: (model, context, options) => ({ model, context, options }) }); export { api as openAICompletionsApi, api as openAIResponsesApi, api as anthropicMessagesApi, api as googleGenerativeAIApi };',
      )
      const launch = deliverPiGateway(
        {
          baseURL: 'http://127.0.0.1:1234',
          file: name => join(root, name),
          models: [{ id: 'service-only', capabilities: { vision: true, thinking: ['low', 'high', 'xhigh'] } }],
          budget: { contextTokens: 32768, outputTokens: 4096 },
        },
        { providerId: 'service', model: 'service-only', wire, origin: 'https://example.invalid' },
      )
      await writeFile(file, launch.files!['pi-gateway.ts']!)
      await writeFile(join(root, 'pi-gateway.json'), launch.files!['pi-gateway.json']!)
      expect(JSON.stringify(launch)).not.toContain(key)
      const extension = (await import(url)) as { default: (pi: object) => void }
      const registerProvider = vi.fn()
      const pi = { registerProvider }
      vi.stubEnv('LMG_TOKEN', key)
      extension.default(pi)
      expect(process.env.LMG_TOKEN).toBeUndefined()
      expect(registerProvider).toHaveBeenCalledWith(
        'latch-gateway',
        expect.objectContaining({
          apiKey: key,
          models: [expect.objectContaining({ id: 'service-only', input: ['text', 'image'], contextWindow: 32768, maxTokens: 4096 })],
        }),
      )
      extension.default(pi)
      expect(registerProvider).toHaveBeenCalledTimes(2)
      if (wire === 'gemini') expect(registerProvider.mock.calls[0]![1].models[0].thinkingLevelMap.xhigh).toBeNull()
      type Delegate = {
        model: { contextWindow: number; maxTokens: number }
        options: { maxTokens: number; onPayload: (payload: unknown, model?: unknown) => Promise<unknown> }
      }
      const provider = registerProvider.mock.calls[0]![1] as {
        api: string
        streamSimple: (model: object, context: object, options: object) => Delegate
      }
      const model = { provider: 'latch-gateway', api: provider.api, id: 'service-only', contextWindow: 999999, maxTokens: 99999 }
      const delegated = provider.streamSimple(model, {}, { reasoning: 'low', maxTokens: 90000 })
      expect(delegated.model).toMatchObject({ contextWindow: 32768, maxTokens: 4096 })
      expect(delegated.options.maxTokens).toBe(4096)
      const field = wire === 'responses' ? 'max_output_tokens' : wire === 'chat-completions' ? 'max_completion_tokens' : 'max_tokens'
      const payload =
        wire === 'gemini'
          ? { model: 'service-only', config: { temperature: 0.3, maxOutputTokens: 90000, thinkingConfig: { thinkingBudget: -1 } } }
          : { model: 'service-only', [field]: 90000 }
      if (wire === 'gemini') {
        expect(await delegated.options.onPayload(payload)).toEqual({
          model: 'service-only',
          config: { temperature: 0.3, maxOutputTokens: 4096, thinkingConfig: { includeThoughts: true, thinkingLevel: 'LOW' } },
        })
        expect(payload.config!.thinkingConfig).toEqual({ thinkingBudget: -1 })
        const summary = provider.streamSimple(model, {}, { reasoning: 'high' })
        expect(await summary.options.onPayload(payload)).toMatchObject({ config: { thinkingConfig: { thinkingLevel: 'HIGH' } } })
      } else expect(await delegated.options.onPayload(payload)).toEqual({ model: 'service-only', [field]: 4096 })
      const deleted = provider.streamSimple(
        model,
        {},
        { reasoning: 'low', onPayload: () => (wire === 'gemini' ? { model: 'service-only', config: {} } : { model: 'service-only' }) },
      )
      expect(await deleted.options.onPayload(payload)).toMatchObject(
        wire === 'gemini' ? { config: { maxOutputTokens: 4096 } } : { [field]: 4096 },
      )
      const tampered = provider.streamSimple(model, {}, { reasoning: 'low', onPayload: () => ({ model: 'other' }) })
      await expect(tampered.options.onPayload(payload)).rejects.toThrow('model payload is unavailable')
      expect(() => provider.streamSimple({ ...model, provider: 'other' }, {}, { reasoning: 'low' })).toThrow('model is unavailable')
      if (wire === 'gemini') expect(() => provider.streamSimple(model, {}, { reasoning: 'xhigh' })).toThrow('thinking level is unavailable')
      const smaller = provider.streamSimple({ ...model, contextWindow: 8192, maxTokens: 1024 }, {}, { reasoning: 'low', maxTokens: 512 })
      expect(smaller.model).toMatchObject({ contextWindow: 8192, maxTokens: 512 })
    } finally {
      vi.unstubAllEnvs()
      Reflect.deleteProperty(globalThis, Symbol.for(`${url}:gateway-token`))
      await rm(root, { recursive: true, force: true })
    }
  },
)
