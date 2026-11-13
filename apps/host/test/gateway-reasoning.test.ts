import { describe, expect, it } from 'vitest'
import { ReasoningSeals } from '../src/model-gateway/reasoning.ts'
import { decodeAnthropic } from '../src/model-gateway/in/anthropic.ts'
import { encodeChat } from '../src/model-gateway/out/chat.ts'

const scope = { providerId: 'service', model: 'model', wire: 'responses' as const }
const state = {
  wire: 'responses' as const,
  item: {
    type: 'reasoning' as const,
    id: 'rs_native',
    encrypted_content: 'opaque-native-ciphertext',
    summary: [{ type: 'summary_text' as const, text: 'A public summary' }],
    status: 'completed' as const,
  },
}

describe('protocol-bound gateway reasoning', () => {
  it('preserves native opaque state, rather than substituting a visible summary', () => {
    const seals = new ReasoningSeals()
    const sealed = seals.seal(scope, state)
    expect(seals.open(scope, sealed)).toEqual(state)
    expect(seals.open({ ...scope, wire: 'chat-completions' }, sealed)).toBeUndefined()
    expect(seals.open({ ...scope, providerId: 'other' }, sealed)).toBeUndefined()
    expect(seals.open({ ...scope, model: 'other' }, sealed)).toBeUndefined()
    expect(new ReasoningSeals().open(scope, sealed)).toBeUndefined()
  })

  it('does not seal a state under a different upstream protocol', () => {
    expect(() => new ReasoningSeals().seal({ ...scope, wire: 'chat-completions' }, state)).toThrow()
  })

  it.each(['id', 'encrypted_content'] as const)('refuses a secret-bearing opaque field instead of corrupting its %s', field => {
    const unsafe = { ...state, item: { ...state.item, [field]: 'private-service-secret' } }
    expect(() => new ReasoningSeals().seal(scope, unsafe, text => text.replaceAll('private-service-secret', '[redacted]'))).toThrow(
      '包含敏感内容',
    )
  })

  it('redacts readable summaries before sealing, without changing native ciphertext', () => {
    const seals = new ReasoningSeals()
    const sealed = seals.seal(scope, state, text => text.replaceAll('public', '[redacted]'))
    expect(seals.open(scope, sealed)).toEqual({
      ...state,
      item: { ...state.item, summary: [{ type: 'summary_text', text: 'A [redacted] summary' }] },
    })
  })

  it('refuses incomplete and oversized native state before creating a replay envelope', () => {
    const seals = new ReasoningSeals()
    expect(() => seals.seal(scope, { ...state, item: { ...state.item, encrypted_content: '' } })).toThrow()
    expect(() => seals.seal(scope, { ...state, item: { ...state.item, encrypted_content: 'a'.repeat(4 * 1024 * 1024 + 1) } })).toThrow()
    expect(() => seals.seal(scope, { ...state, item: { ...state.item, id: '' } })).toThrow()
  })

  it('replays the authenticated item through Anthropic history and refuses to turn it into Chat reasoning text', () => {
    const seals = new ReasoningSeals()
    const request = decodeAnthropic(
      JSON.stringify({
        model: scope.model,
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'question' },
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'changed summary', signature: seals.seal(scope, state) }] },
          { role: 'user', content: 'continue' },
        ],
      }),
      value => seals.open(scope, value),
    )
    expect(request.input[1]).toEqual({ type: 'reasoning', state })
    expect(() => encodeChat(request)).toThrow('思考状态与上游协议不一致')
  })
})
