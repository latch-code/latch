import { describe, expect, it } from 'vitest'
import type { SessionConfigOption } from '@latch/protocol'
import { shownCatalogue, startCatalogue, withModelOptions } from '../src/catalogue.ts'

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
