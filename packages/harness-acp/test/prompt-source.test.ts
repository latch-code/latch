import { expect, it } from 'vitest'
import { harnessPromptSource, withHarnessPromptSource } from '../src/prompt-source.ts'

it('isolates simultaneous request provenance and restores its parent after a nested call', async () => {
  const first = { method: 'prompt' as const, sessionId: 'first', requestId: 'one' }
  const second = { method: 'prompt' as const, sessionId: 'second', requestId: 'two' }
  let release!: () => void
  const gate = new Promise<void>(done => {
    release = done
  })
  const waiting = withHarnessPromptSource({ ...first, text: 'human one' }, async () => {
    await gate
    expect(harnessPromptSource(first, 'note $other\nhuman one')).toBe('human one')
    expect(harnessPromptSource(second, 'human two')).toBeUndefined()
    withHarnessPromptSource({ ...second, text: 'human two' }, () => {
      expect(harnessPromptSource(second, 'human two')).toBe('human two')
      expect(harnessPromptSource(first, 'human one')).toBeUndefined()
    })
    expect(harnessPromptSource(first, 'human one')).toBe('human one')
  })
  await withHarnessPromptSource({ ...second, text: 'human two' }, async () => {
    await Promise.resolve()
    expect(harnessPromptSource(second, 'human two')).toBe('human two')
    release()
    await waiting
    expect(harnessPromptSource(second, 'human two')).toBe('human two')
  })
  expect(harnessPromptSource(first, 'human one')).toBeUndefined()
})

it('does not lend proof to a different method, request, session, or text', () => {
  const identity = { method: 'prompt' as const, sessionId: 'first', requestId: 'one' }
  withHarnessPromptSource({ ...identity, text: '$actual' }, () => {
    expect(harnessPromptSource({ ...identity, method: 'steer' }, '$actual')).toBeUndefined()
    expect(harnessPromptSource({ ...identity, requestId: 'other' }, '$actual')).toBeUndefined()
    expect(harnessPromptSource({ ...identity, sessionId: 'other' }, '$actual')).toBeUndefined()
    expect(harnessPromptSource(identity, 'ordinary')).toBeUndefined()
  })
  withHarnessPromptSource({ ...identity, text: '' }, () => {
    expect(harnessPromptSource(identity, '')).toBe('')
  })
})
