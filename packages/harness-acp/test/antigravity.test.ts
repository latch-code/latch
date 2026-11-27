import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { forgetCommandLookups, setCommandSearch } from '../src/index.ts'
import { replayTranscript } from './helpers/replay.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setCommandSearch(undefined)
  forgetCommandLookups()
})

// Frames recorded from Antigravity CLI 1.5.8 on 2026-11-15 and reduced; the transcript's header says how.
const RESUME = resolve(import.meta.dirname, 'fixtures/antigravity-resume.ndjson')

it('sets the model and thinking a session ran on again when Antigravity opens it with its defaults', async () => {
  const { detail, status, pending, marks } = await replayTranscript(RESUME, cleanups)
  // Every frame was played in order: after session/resume answered with the defaults, the driver set both again
  // before it sent the prompt.
  expect(status?.failure).toBeUndefined()
  expect(status).toMatchObject({ cursor: status?.total })
  expect(pending).toEqual([])
  expect(marks).toEqual([])
  expect(detail.summary.status).toBe('idle')
  expect(detail.config?.find(option => option.category === 'model')?.currentValue).toBe('gemini-4-hydrogen')
  expect(detail.config?.find(option => option.category === 'thought_level')?.currentValue).toBe('low')
  expect(detail.summary.model).toBe('Gemini 4 Hydrogen')
  expect(detail.messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['Hello.', 'Hello again.'])
  expect(detail.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['Say hello', 'And again'])
  // agy reports each turn's own count with cached input outside `inputTokens`: each turn puts cached reads back into input, and the session sums both turns.
  const perTurn = { inputTokens: 19_034, outputTokens: 91, cacheReadTokens: 7375, cacheWriteTokens: 0, reasoningTokens: 15 }
  expect(detail.messages.filter(message => message.role === 'user').map(message => message.turn?.usage)).toEqual([perTurn, perTurn])
  expect(detail.summary.usage).toEqual({
    inputTokens: 38_068,
    outputTokens: 182,
    cacheReadTokens: 14_750,
    cacheWriteTokens: 0,
    reasoningTokens: 30,
  })
})
