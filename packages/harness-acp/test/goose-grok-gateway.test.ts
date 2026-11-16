import type { ModelWire } from '@latch/protocol'
import type { ModelRoute } from '@latch/sdk'
import { describe, expect, it } from 'vitest'
import { gooseProfile } from '../src/profiles/goose.ts'
import { grokProfile } from '../src/profiles/grok.ts'
import type { GatewayPlace, HarnessProfile } from '../src/profiles/types.ts'

type Launch = Extract<NonNullable<HarnessProfile['gateway']>, { via: 'launch' }>

function launchOf(profile: HarnessProfile): Launch {
  if (profile.gateway?.via !== 'launch') throw new Error('not a launch route')
  return profile.gateway
}

/** The gateway's address as the Host gives it: `/v1` for the two OpenAI protocols, the bare origin otherwise. */
const place = (wire: ModelWire): GatewayPlace => ({
  baseURL: wire === 'responses' || wire === 'chat-completions' ? 'http://127.0.0.1:4010/v1' : 'http://127.0.0.1:4010',
  models: [{ id: 'main-model', capabilities: { vision: true } }, { id: 'vendor/side(model)' }],
  file: name => `/private/session/gateway/${name}`,
})

const route = (wire: ModelWire, upstream?: ModelWire): ModelRoute => ({
  providerId: 'svc',
  model: 'main-model',
  wire,
  origin: 'https://service.example',
  ...(upstream ? { upstream } : {}),
})

describe('goose on a model service', () => {
  const gateway = launchOf(gooseProfile)
  const common = (provider: string) => ({
    GOOSE_PROVIDER: provider,
    GOOSE_MODEL: 'main-model',
    GOOSE_SUBAGENT_PROVIDER: provider,
    GOOSE_SUBAGENT_MODEL: 'main-model',
    // The tool shim would send replies to an interpreter model of the person's own.
    GOOSE_TOOLSHIM: 'false',
  })

  it('points its openai provider at the gateway with a path that fixes Chat Completions whatever the model is called', () => {
    const launch = gateway.deliver(place('chat-completions'), route('chat-completions'))
    expect(launch).toEqual({
      // Not goose's default `v1/chat/completions`, under which a model's name alone would pick Responses.
      env: { ...common('openai'), OPENAI_HOST: 'http://127.0.0.1:4010', OPENAI_BASE_PATH: '/v1/chat/completions' },
    })
    expect(new URL(launch.env!.OPENAI_BASE_PATH!, `${launch.env!.OPENAI_HOST}/`).href).toBe('http://127.0.0.1:4010/v1/chat/completions')
  })

  it('fixes Responses by its path, and is offered exactly the three protocols', () => {
    expect(gateway.deliver(place('responses'), route('responses')).env).toEqual({
      ...common('openai'),
      OPENAI_HOST: 'http://127.0.0.1:4010',
      OPENAI_BASE_PATH: 'v1/responses',
    })
    expect(gateway.wires).toEqual(['chat-completions', 'responses', 'anthropic-messages'])
  })

  it('points its anthropic provider at the gateway and leaves the openai variables unset', () => {
    expect(gateway.deliver(place('anthropic-messages'), route('anthropic-messages'))).toEqual({
      env: { ...common('anthropic'), ANTHROPIC_HOST: 'http://127.0.0.1:4010' },
    })
  })

  it('puts the token in the variable its provider reads, and never writes it, a file or an argument itself', () => {
    expect(gateway.tokenEnv).toBe('OPENAI_API_KEY')
    expect(gateway.tokenEnvByWire).toEqual({ 'anthropic-messages': 'ANTHROPIC_API_KEY' })
    for (const wire of gateway.wires) {
      const launch = gateway.deliver(place(wire), route(wire))
      expect(launch.files).toBeUndefined()
      expect(launch.args).toBeUndefined()
      expect(Object.keys(launch.env!).every(name => gateway.envNames.includes(name))).toBe(true)
      expect(Object.keys(launch.env!).some(name => /KEY|TOKEN|SECRET/u.test(name))).toBe(false)
      expect(JSON.stringify(launch)).not.toContain('service.example')
    }
  })

  it('hides the option that would move a session to another provider, and requires the version it was checked against', () => {
    expect(gateway.hiddenConfig).toEqual(['provider'])
    expect(gooseProfile.version).toBe(2)
    expect(gateway.templates).toEqual({})
    expect(gateway.minimumVersion?.minimum).toBe('1.57.0')
    // Marked experimental: a delegated subagent's provider cannot be pinned.
    expect(gateway.experimental).toBe(true)
    expect(gateway.credentialInherited).toBe(true)
    for (const output of [' 1.57.0\n', 'goose 1.57.0\n', '1.57.0']) expect(gateway.minimumVersion?.read(output)).toBe('1.57.0')
    expect(gateway.minimumVersion?.read('A newer goose 1.60.0 is available (you have 1.58.0)')).toBeUndefined()
  })
})

describe('Grok Build on a model service', () => {
  const gateway = launchOf(grokProfile)

  it.each([
    ['chat-completions', 'chat_completions', 'http://127.0.0.1:4010/v1'],
    ['responses', 'responses', 'http://127.0.0.1:4010/v1'],
    ['anthropic-messages', 'messages', 'http://127.0.0.1:4010/v1'],
  ] as const)('writes a home of its own for %s whose custom models name the key by its variable', (wire, backend, address) => {
    const launch = gateway.deliver(place(wire), route(wire))
    expect(launch.env).toEqual({ GROK_HOME: '/private/session/gateway' })
    expect(launch.args).toBeUndefined()
    expect(Object.keys(launch.files!)).toEqual(['config.toml'])
    expect(launch.files!['config.toml']).toBe(
      [
        '[models]',
        'default = "main-model"',
        'web_search = "main-model"',
        '',
        '[model."main-model"]',
        'model = "main-model"',
        'name = "main-model"',
        `base_url = "${address}"`,
        'env_key = "LMG_TOKEN"',
        `api_backend = "${backend}"`,
        '',
        '[model."vendor/side(model)"]',
        'model = "vendor/side(model)"',
        'name = "vendor/side(model)"',
        `base_url = "${address}"`,
        'env_key = "LMG_TOKEN"',
        `api_backend = "${backend}"`,
        '',
      ].join('\n'),
    )
  })

  it('quotes a model ID so that it cannot open another table or key', () => {
    const odd = { ...place('responses'), models: [{ id: 'a"]\n[model."b' }] }
    const text = gateway.deliver(odd, { ...route('responses'), model: 'a"]\n[model."b' }).files!['config.toml']!
    expect(text.split('\n').filter(line => line.startsWith('['))).toEqual(['[models]', '[model."a\\"]\\n[model.\\"b"]'])
  })

  it('carries the token in LMG_TOKEN alone and is marked experimental', () => {
    expect(gateway.tokenEnv).toBe('LMG_TOKEN')
    expect(gateway.envNames).toEqual(['GROK_HOME'])
    expect(gateway.experimental).toBe(true)
    expect(gateway.credentialInherited).toBe(true)
    expect(grokProfile.version).toBe(2)
    for (const wire of gateway.wires)
      expect(JSON.stringify(gateway.deliver(place(wire), route(wire)))).not.toMatch(/lmg1\.|service\.example/u)
  })
})

describe('Grok Build token counts', () => {
  it('reads this turn’s count from the prompt answer’s _meta, as a real one sent it', () => {
    // Grok 1.0.x, 2026-11-16, a turn of two model calls (sanitised).
    const answer = {
      stopReason: 'end_turn',
      _meta: {
        totalTokens: 29_908,
        usage: {
          inputTokens: 59_537,
          outputTokens: 123,
          totalTokens: 59_660,
          cachedReadTokens: 59_264,
          cacheCreationTokens: 0,
          reasoningTokens: 40,
          modelCalls: 2,
        },
      },
    }
    expect(grokProfile.usageScope).toBe('turn')
    expect(grokProfile.turnUsage?.(answer)).toEqual({
      inputTokens: 59_537,
      outputTokens: 123,
      cachedReadTokens: 59_264,
      cachedWriteTokens: 0,
      thoughtTokens: 40,
    })
    expect(grokProfile.turnUsage?.({ stopReason: 'end_turn' })).toBeUndefined()
  })
})
