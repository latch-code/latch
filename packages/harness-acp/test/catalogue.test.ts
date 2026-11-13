import { describe, expect, it } from 'vitest'
import type { SessionConfigOption } from '@latch/protocol'
import { catalogueReadOf, shownCatalogue, startCatalogue, withModelOptions } from '../src/catalogue.ts'
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
  it("reads by selection only where the read runs no turn, no model call and none of the person's own hooks", () => {
    const rule = (presetId: string) => catalogueReadOf(HARNESS_PROFILES.get(presetId))
    // Codex's model/list opens no thread, on its own app-server and through the adapter's; it reports no modes.
    expect(rule('codex')).toEqual({ when: 'select', modes: false })
    expect(catalogueReadOf(FALLBACK_PROFILES.get('codex'))).toEqual({ when: 'select', modes: false })
    // An empty ACP session: no prompt, so no turn and no model call.
    for (const presetId of ['dsh', 'cursor', 'gemini', 'goose', 'qwen', 'opencode'])
      expect(rule(presetId)).toEqual({ when: 'select', modes: true })
    // Starting these runs the person's own session hooks and extensions, so only a person asks.
    expect(rule('pi')).toEqual({ when: 'request', modes: true })
    expect(rule('claude-agent')).toEqual({ when: 'request', modes: true })
    // A command with no profile was confirmed as the program to run, and its empty session runs no turn either.
    expect(catalogueReadOf(undefined)).toEqual({ when: 'select', modes: true })
    // Every preset decides; none is left to the default.
    expect([...HARNESS_PROFILES.keys()].sort()).toEqual([
      'claude-agent',
      'codex',
      'cursor',
      'dsh',
      'gemini',
      'goose',
      'opencode',
      'pi',
      'qwen',
    ])
  })
})
