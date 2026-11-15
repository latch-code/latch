import { describe, expect, it } from 'vitest'
import { replyReader } from '../src/model-reply.ts'

const bytes = (text: string) => new TextEncoder().encode(text)
const SSE = 'text/event-stream; charset=utf-8'

/** Feeds the reply in pieces of `size` bytes, so lines and characters are split across chunks. */
function read(wire: 'responses', contentType: string, text: string, size = 7) {
  const reader = replyReader(wire, contentType)
  const all = bytes(text)
  for (let start = 0; start < all.length; start += size) reader.feed(all.subarray(start, start + size))
  return reader.end()
}

const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`
const completed = (model: string) =>
  event('response.completed', {
    response: {
      model,
      status: 'completed',
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 5 },
      },
    },
  })

describe('what the gateway reads of a reply', () => {
  it('reads the model and tokens of a streamed Responses reply, however it is split', () => {
    const text =
      event('response.created', { response: { model: 'gpt-x', status: 'in_progress', usage: null } })
      + event('response.output_text.delta', { delta: '模型的回答' })
      + completed('gpt-x-2026-01-01')
    for (const size of [1, 3, 7, 4096])
      expect(read('responses', SSE, text, size)).toEqual({
        model: 'gpt-x-2026-01-01',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, reasoningTokens: 5 },
        ended: true,
      })
  })

  it('says what a reply has said so far, and that it is over once its last event arrives, before the stream ends', () => {
    const reader = replyReader('responses', SSE)
    reader.feed(bytes(event('response.created', { response: { model: 'gpt-x', status: 'in_progress', usage: null } })))
    expect(reader.facts()).toEqual({ model: 'gpt-x' })
    reader.feed(bytes(completed('gpt-x-2026-01-01')))
    expect(reader.facts()).toEqual({
      model: 'gpt-x-2026-01-01',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, reasoningTokens: 5 },
      ended: true,
    })
    // A reply sent whole is read only once it has all arrived.
    const whole = replyReader('responses', 'application/json')
    whole.feed(bytes(JSON.stringify({ model: 'gpt-x', usage: { input_tokens: 1, output_tokens: 1 } })))
    expect(whole.facts()).toEqual({})
  })

  it('passes over events it does not read, however long, and still reads the end', () => {
    const long = 'x'.repeat(5 * 1024 * 1024)
    const text = event('response.output_text.delta', { delta: long }) + completed('gpt-x')
    expect(read('responses', SSE, text, 64 * 1024)).toMatchObject({ model: 'gpt-x', usage: { inputTokens: 100 } })
  })

  it('gives up on an event too large to hold, and reads the ones after it', () => {
    const long = 'x'.repeat(5 * 1024 * 1024)
    // No event names: every data line may be the one that matters, so it is held up to the limit.
    const text =
      `data: ${JSON.stringify({ type: 'response.completed', response: { model: long, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`
      + `data: ${JSON.stringify({ type: 'response.completed', response: { model: 'small', usage: { input_tokens: 3, output_tokens: 2 } } })}\n\n`
    expect(read('responses', SSE, text, 64 * 1024)).toEqual({ model: 'small', usage: { inputTokens: 3, outputTokens: 2 }, ended: true })
  })

  it('says when the reply itself failed', () => {
    expect(read('responses', SSE, event('response.failed', { response: { model: 'gpt-x', status: 'failed', error: {} } }))).toEqual({
      model: 'gpt-x',
      failed: true,
      ended: true,
    })
    expect(read('responses', SSE, `data: ${JSON.stringify({ type: 'error', message: 'nope' })}\n\n`)).toEqual({ failed: true, ended: true })
  })

  it('reads a Responses reply that was not streamed', () => {
    const body = JSON.stringify({ model: 'gpt-x', status: 'completed', output: [], usage: { input_tokens: 7, output_tokens: 3 } })
    expect(read('responses', 'application/json', body)).toEqual({ model: 'gpt-x', usage: { inputTokens: 7, outputTokens: 3 }, ended: true })
  })

  it('reads nothing from a reply that is not what the protocol sends, and never throws', () => {
    expect(read('responses', SSE, 'data: {not json\n\n: comment\n\nevent: response.completed\ndata: []\n\n')).toEqual({})
    expect(read('responses', 'application/json', '<html>busy</html>')).toEqual({})
    expect(read('responses', SSE, '')).toEqual({})
  })
})
