import type { ModelWire } from '@latch/protocol'
import type { ModelRoute } from '@latch/sdk'
import { describe, expect, it } from 'vitest'
import { qwenProfile } from '../src/profiles/qwen.ts'
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

describe('Qwen Code on a model service', () => {
  const gateway = launchOf(qwenProfile)

  it.each([
    ['chat-completions', 'openai', 'chat-completions', 'http://127.0.0.1:4010/v1'],
    ['responses', 'openai', 'responses', 'http://127.0.0.1:4010/v1'],
    ['anthropic-messages', 'anthropic', undefined, 'http://127.0.0.1:4010'],
  ] as const)('writes private system settings for %s that name the key by its variable only', (wire, auth, wireApi, baseUrl) => {
    const launch = gateway.deliver(place(wire), route(wire))
    expect(launch.args).toBeUndefined()
    expect(launch.sessionMeta).toBeUndefined()
    expect(launch.env).toEqual({ QWEN_CODE_SYSTEM_SETTINGS_PATH: '/private/session/gateway/qwen-system-settings.json' })
    expect(Object.keys(launch.env!).every(name => gateway.envNames.includes(name))).toBe(true)
    const settings = JSON.parse(launch.files!['qwen-system-settings.json']!) as Record<string, any>
    expect(settings.security).toEqual({ auth: { selectedType: auth } })
    expect(settings.model).toEqual({ name: 'main-model', baseUrl })
    // Every built-in key is written: this protocol's with the service's models, the others empty, so a list of the
    // person's under any of them is replaced.
    expect(Object.keys(settings.modelProviders).sort()).toEqual(['anthropic', 'gemini', 'openai', 'openai-responses', 'vertex-ai'])
    for (const [key, list] of Object.entries(settings.modelProviders)) if (key !== auth) expect(list, key).toEqual([])
    expect(settings.modelProviders[auth]).toEqual([
      {
        id: 'main-model',
        name: 'main-model',
        baseUrl,
        envKey: 'LMG_TOKEN',
        ...(wireApi ? { wireApi } : {}),
        generationConfig: { modalities: { image: true } },
      },
      { id: 'vendor/side(model)', name: 'vendor/side(model)', baseUrl, envKey: 'LMG_TOKEN', ...(wireApi ? { wireApi } : {}) },
    ])
  })

  it('clears every model Qwen Code would use for a side call or a fallback', () => {
    const settings = JSON.parse(gateway.deliver(place('responses'), route('responses')).files!['qwen-system-settings.json']!) as Record<
      string,
      unknown
    >
    for (const name of ['fastModel', 'visionModel', 'compactionModel', 'advisorModel', 'modelFallbacks', 'imageModel', 'voiceModel'])
      expect(settings[name]).toBe('')
    // No grade of the person's is allowed, and no subagent runs: its own file could name a model of another route.
    expect(settings.agents).toEqual({ builtin: { exploreModel: 'inherit' }, allowedGrades: [] })
    expect(settings.permissions).toEqual({ deny: ['Agent'] })
    // Nothing else is set: the person's hooks, tools and other rules stay theirs.
    expect(Object.keys(settings).sort()).toEqual(
      [
        ...['advisorModel', 'agents', 'compactionModel', 'fastModel', 'imageModel', 'model', 'modelFallbacks'],
        ...['modelProviders', 'permissions', 'security', 'visionModel', 'voiceModel'],
      ].sort(),
    )
  })

  it('carries the token in LMG_TOKEN alone, and nothing it writes holds a value for it', () => {
    expect(gateway.tokenEnv).toBe('LMG_TOKEN')
    for (const wire of gateway.wires) {
      const launch = gateway.deliver(place(wire), route(wire))
      const written = JSON.stringify(launch)
      expect(written).not.toMatch(/lmg1\.|apiKey|api_key|authorization/iu)
      expect(written).not.toContain('service.example')
    }
  })

  it('reads a service model only from the exact value of its own auth type', () => {
    const { models } = gateway
    expect(models?.reportedOnly).toBe(true)
    expect(models!.value('vendor/side(model)', 'chat-completions')).toBe('vendor/side(model)(openai)')
    expect(models!.id('vendor/side(model)(openai)', 'chat-completions')).toBe('vendor/side(model)')
    // A Responses entry sits in the `openai` list and is listed under its effective protocol.
    expect(models!.value('vendor/side(model)', 'responses')).toBe('vendor/side(model)(openai-responses)')
    expect(models!.id('vendor/side(model)(openai-responses)', 'responses')).toBe('vendor/side(model)')
    expect(models!.id('vendor/side(model)(openai)', 'responses')).toBeUndefined()
    expect(models!.value('claude', 'anthropic-messages')).toBe('claude(anthropic)')
    // The Gemini protocol is not one Latch points Qwen Code at.
    expect(models!.id('flash(gemini)', 'gemini')).toBeUndefined()
    // Another protocol's entry of the same ID, a route ID, a bare ID and an empty ID are not this service's models.
    for (const value of ['main-model(anthropic)', 'qwen-route:v1:abcdef', 'main-model', '(openai)', 'main-model(qwen-oauth)'])
      expect(models!.id(value, 'chat-completions')).toBeUndefined()
    expect(models!.id('main-model(openai)')).toBeUndefined()
  })

  it('marks a model choice as the session alone and requires the version these settings were checked against', () => {
    expect(qwenProfile.modelSetMeta).toEqual({ 'qwen.session.modelPersistDefault': false })
    expect(qwenProfile.version).toBe(2)
    // Wired from reading its source, not from a run: clients say 实验性, and that its commands can read the credential.
    expect(gateway.experimental).toBe(true)
    expect(gateway.credentialInherited).toBe(true)
    expect(gateway.wires).toEqual(['chat-completions', 'responses', 'anthropic-messages'])
    expect(gateway.templates).toEqual({ files: 1 })
    expect(gateway.minimumVersion?.minimum).toBe('0.26.8')
    expect(gateway.minimumVersion?.read('0.26.8\n')).toBe('0.26.8')
    expect(gateway.minimumVersion?.read('Update available 0.27.2 -> 0.27.3\n0.27.2\n')).toBeUndefined()
  })
})
