import { describe, expect, it } from 'vitest'
import { pairedModels, prefixedModels } from '../src/profiles/gateway-model.ts'

describe('native gateway model values', () => {
  it.each(['model', 'vendor/model', 'a,b', '含空格 model', 'quoted"model'])(
    'preserves the complete model ID %s in both native forms',
    id => {
      for (const values of [prefixedModels('latch'), pairedModels('latch')]) expect(values.id(values.value(id))).toBe(id)
    },
  )

  it('does not mistake another provider or a bare display label for its own prefixed model', () => {
    const values = prefixedModels('latch')
    for (const value of ['other/model', 'model', 'not-latch/model', 'latch/', 'latch']) expect(values.id(value)).toBeUndefined()
  })

  it('rejects malformed, empty and foreign dsh model pairs without accepting suffix matches', () => {
    const values = pairedModels('latch')
    for (const value of ['model', '["other","model"]', '["latch",""]', '["latch",4]', '["latch","model","other"]', '{}'])
      expect(values.id(value)).toBeUndefined()
  })
})
