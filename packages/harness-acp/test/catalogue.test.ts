import { describe, expect, it } from 'vitest'
import type { SessionConfigOption } from '@latch/protocol'
import {
  catalogueReadOf,
  declaredThinking,
  gatewayThinkingLevels,
  serviceDeclarationHash,
  shownCatalogue,
  shownServiceOptions,
  startCatalogue,
  withModelOptions,
  withServiceOptions,
} from '../src/catalogue.ts'
import { FALLBACK_PROFILES, HARNESS_PROFILES } from '../src/profiles/index.ts'

const hash = 'a'.repeat(64)
const select = (id: string, category: string, values: string[], name = (value: string) => value): SessionConfigOption => ({
  id,
  name: id,
  category,
  currentValue: values[0]!,
  options: values.map(value => ({ value, name: name(value) })),
})
const built = (options: SessionConfigOption[]) =>
  startCatalogue(undefined, {
    options,
    isMode: () => false,
    startMode: undefined,
    definitionHash: hash,
    launchHash: hash,
    at: 'now',
    source: 'session',
  })

describe('the catalogue a phone receives with every snapshot', () => {
  it('keeps a long list of models a person picks from, and leaves out values nobody picks from a list', () => {
    const models = Array.from({ length: 150 }, (_, index) => `provider/model-${index}`)
    const shown = shownCatalogue(built([select('model', 'model', [...models, 'x'.repeat(300)])]))!
    expect(shown.options[0]!.options.map(item => item.value)).toEqual(models)
  })

  it('drops the models seen longest ago, then everything, rather than grow past its size', () => {
    const levels = Array.from({ length: 40 }, (_, index) => `level-${index}`)
    let stored = built([select('model', 'model', ['m0']), select('effort', 'thought_level', levels)])
    for (let model = 1; model < 32; model++)
      stored = {
        ...stored,
        perModel: withModelOptions(stored.perModel, [
          select('model', 'model', [`m${model}`]),
          select('effort', 'thought_level', levels, value => value.repeat(8)),
        ]),
      }
    const shown = shownCatalogue(stored)!
    expect(new TextEncoder().encode(JSON.stringify(shown)).length).toBeLessThanOrEqual(64 * 1024)
    expect(shown.perModel.length).toBeLessThan(stored.perModel.length)
    expect(shown.perModel[0]!.model).toBe('m31')
    const huge = Array.from({ length: 200 }, (_, index) => `${'n'.repeat(200)}${index}`)
    expect(shownCatalogue(built([select('model', 'model', huge, value => value), select('other', 'model_config', huge)]))).toBeUndefined()
  })
})

describe("when a draft reads a Harness's lists by itself", () => {
  it('prefetches once per confirmed definition across all built-in profiles, while honouring an explicit request-only rule', () => {
    const rule = (presetId: string) => catalogueReadOf(HARNESS_PROFILES.get(presetId))
    // Codex's model/list opens no thread, on its own app-server and through the adapter's; it reports no modes.
    expect(rule('codex')).toEqual({ when: 'select', modes: false })
    expect(catalogueReadOf(FALLBACK_PROFILES.get('codex'))).toEqual({ when: 'select', modes: false })
    // Grok Build's answer to initialize lists its models and thinking; that process opens no session.
    expect(rule('grok')).toEqual({ when: 'select', modes: false })
    // Empty private-folder reads with no prompt report models, thinking, modes and commands once per definition.
    for (const presetId of ['dsh', 'cursor', 'opencode', 'goose', 'qwen', 'pi', 'claude-agent', 'antigravity'])
      expect(rule(presetId)).toEqual({ when: 'select', modes: true })
    expect(catalogueReadOf(FALLBACK_PROFILES.get('claude-agent'))).toEqual({ when: 'select', modes: true })
    // An explicit request-only profile still stays manual until requested.
    expect(catalogueReadOf({ catalogueRead: { when: 'request' } })).toEqual({ when: 'request', modes: true })
    // A command with no profile was confirmed as the program to run, and its empty session runs no turn either.
    expect(catalogueReadOf(undefined)).toEqual({ when: 'select', modes: true })
    // Every preset decides; none is left to the default.
    expect([...HARNESS_PROFILES.keys()].sort()).toEqual([
      'antigravity',
      'claude-agent',
      'codex',
      'cursor',
      'dsh',
      'goose',
      'grok',
      'opencode',
      'pi',
      'qwen',
    ])
  })
})

describe('options remembered for a model of a service', () => {
  const entry = (model: string, options: SessionConfigOption[]) => ({
    definitionHash: hash,
    providerId: 'svc',
    model,
    declarationHash: hash,
    options,
    reportedAt: 'x',
  })

  it('keys the declaration the same whether a field is absent or empty, and on what it declares only', () => {
    const plain = serviceDeclarationHash({ entry: 'responses' })
    expect(serviceDeclarationHash({ entry: 'responses', upstream: 'responses', capabilities: { thinking: [] } })).toBe(plain)
    expect(serviceDeclarationHash({ entry: 'responses', upstream: 'chat-completions' })).not.toBe(plain)
    expect(serviceDeclarationHash({ entry: 'responses', capabilities: { thinking: ['high'] } })).not.toBe(plain)
    expect(serviceDeclarationHash({ entry: 'responses', capabilities: { vision: true } })).not.toBe(plain)
  })

  it('keeps only what follows the model, newest first, one entry per pair, and shows only pairs with a choice', () => {
    const effort = select('effort', 'thought_level', ['low', 'high'])
    const one = withServiceOptions(undefined, entry('a', [select('model', 'model', ['a']), select('mode', 'mode', ['x']), effort]))
    expect(one[0]!.options).toEqual([effort])
    const two = withServiceOptions(one, entry('b', [select('effort', 'thought_level', ['default'])]))
    expect(withServiceOptions(two, entry('a', [effort])).map(item => item.model)).toEqual(['a', 'b'])
    const shown = shownServiceOptions(
      two.map(item => ({ providerId: item.providerId, model: item.model, options: item.options, source: 'session' })),
    )
    expect(shown?.map(item => item.model)).toEqual(['a'])
    expect(shownServiceOptions([])).toBeUndefined()
  })
})

describe('thinking on a gateway model', () => {
  const claude = (currentValue: string): SessionConfigOption => ({
    ...select('effort', 'thought_level', ['default', 'low', 'medium', 'high', 'xhigh', 'max']),
    currentValue,
  })

  it('lets the gateway decide on a converted Anthropic route or a declared model, and leaves a plain forward alone', () => {
    expect(gatewayThinkingLevels({ entry: 'anthropic-messages', upstream: 'chat-completions', levels: ['high', 'max'] })).toEqual([
      'high',
      'max',
    ])
    expect(gatewayThinkingLevels({ entry: 'anthropic-messages', upstream: 'chat-completions' })).toEqual([])
    expect(gatewayThinkingLevels({ entry: 'anthropic-messages', levels: ['max'] })).toEqual(['max'])
    expect(gatewayThinkingLevels({ entry: 'anthropic-messages', upstream: 'anthropic-messages' })).toBeUndefined()
    expect(gatewayThinkingLevels({ entry: 'chat-completions', upstream: 'responses', levels: ['high'] })).toBeUndefined()
  })

  it('offers 默认 and the declared levels only, and reads a level the model lacks as 默认', () => {
    expect(declaredThinking(claude('max'), ['high', 'max'], 'default')).toMatchObject({
      currentValue: 'max',
      options: [{ value: 'default' }, { value: 'high' }, { value: 'max' }],
    })
    expect(declaredThinking(claude('max'), ['high'], 'default')).toMatchObject({
      currentValue: 'default',
      options: [{ value: 'default' }, { value: 'high' }],
    })
    expect(declaredThinking(claude('high'), [], 'default')).toBeUndefined()
    expect(declaredThinking(claude('high'), ['none'], 'default')).toBeUndefined()
    expect(declaredThinking(select('effort', 'thought_level', ['low', 'high']), ['high'], 'default')).toBeUndefined()
  })
})
