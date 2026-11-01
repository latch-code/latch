import { describe, expect, it } from 'vitest'
import { carriedIndex, withMatchKeys } from '../src/components/transcriptFind.ts'

describe('the match a reader is on', () => {
  const keyed = (...ids: Array<[string, number?]>) =>
    withMatchKeys(ids.map(([messageId, outputIndex]) => ({ messageId, ...(outputIndex === undefined ? {} : { outputIndex }) })))

  it('follows it when matches appear before it', () => {
    const before = keyed(['b'], ['c', 0], ['c', 1])
    const after = keyed(['a'], ['b'], ['c', 0], ['c', 1])
    expect(carriedIndex(before[1]!.key, after, 1)).toBe(2)
    expect(carriedIndex(before[0]!.key, after, 0)).toBe(1)
  })

  it('tells occurrences in a row apart and keeps them when the row grows', () => {
    const before = keyed(['a'], ['a'])
    expect(carriedIndex(before[1]!.key, keyed(['a'], ['a'], ['a']), 1)).toBe(1)
  })

  it('stays near where it was when the match is gone', () => {
    expect(carriedIndex('gone', keyed(['a'], ['b']), 5)).toBe(1)
    expect(carriedIndex('gone', [], 3)).toBe(0)
    expect(carriedIndex(undefined, keyed(['a'], ['b']), 1)).toBe(1)
  })
})
