import { describe, expect, it } from 'vitest'
import { retryOfRefused } from '../src/core/refusedInput.ts'

describe('what 重试 sends after a mode could not be read back', () => {
  const empty = { draft: '  ', attachments: 0 }

  it('sends the input as it is now', () => {
    expect(retryOfRefused({ from: 'send' }, { draft: '再试一次', attachments: 0 })).toEqual({ kind: 'draft' })
    expect(retryOfRefused({ from: 'config' }, { draft: '再试一次', attachments: 0 })).toEqual({ kind: 'draft' })
    expect(retryOfRefused({ from: 'send' }, { draft: '', attachments: 1 })).toEqual({ kind: 'draft' })
  })

  it('sends again a prompt that never sat in the input', () => {
    expect(retryOfRefused({ from: 'send', prompt: '上一轮的提示' }, empty)).toEqual({ kind: 'prompt', prompt: '上一轮的提示' })
  })

  it('offers nothing when there is nothing to send: a refused mode change, or a cleared input', () => {
    expect(retryOfRefused({ from: 'config' }, empty)).toBeUndefined()
    expect(retryOfRefused({ from: 'send' }, empty)).toBeUndefined()
    expect(retryOfRefused(undefined, empty)).toBeUndefined()
  })
})
