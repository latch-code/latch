import { describe, expect, it } from 'vitest'
import { AGENT_PRESETS, pairRoute } from '@latch/protocol'
import { presetOffer } from '../src/index.ts'

const offer = (id: string) => presetOffer(AGENT_PRESETS.find(preset => preset.id === id)!)

describe('which harnesses Latch never forwards to a model service', () => {
  it('says so of the vendor agents that keep to their own login', () => {
    expect(offer('cursor').capabilities.models).toMatchObject({ wires: [], ownOnly: true })
  })

  it('leaves it unsaid of one Latch forwards, and of one it may forward later', () => {
    expect(offer('codex').capabilities.models).not.toHaveProperty('ownOnly')
    expect(offer('opencode').capabilities.models).not.toHaveProperty('ownOnly')
    expect(offer('claude-agent').capabilities.models).toMatchObject({ wires: ['anthropic-messages'] })
    expect(offer('claude-agent').capabilities.models).not.toHaveProperty('ownOnly')
  })

  it('forwards Qwen Code, goose and Grok Build over Chat, Responses and Anthropic, each marked experimental', () => {
    for (const id of ['qwen', 'goose', 'grok']) {
      const facts = offer(id).capabilities
      for (const kind of ['openai-compatible', 'openai-responses', 'anthropic'] as const)
        expect(pairRoute(facts, { kind }), id).toMatchObject({ kind: 'passthrough', experimental: true })
      // None can keep the gateway credential from the commands it runs, and clients are told.
      expect(facts.models.credentialInherited, id).toBe(true)
    }
    for (const id of ['codex', 'opencode', 'claude-agent', 'pi', 'dsh'])
      expect(offer(id).capabilities.models, id).not.toHaveProperty('credentialInherited')
  })

  it('offers no service to Antigravity, which takes no model provider of another\u2019s, nor to Cursor', () => {
    expect(pairRoute(offer('antigravity').capabilities, { kind: 'openai-compatible' })).toEqual({
      kind: 'unavailable',
      reason: 'not-forwarded',
    })
    for (const id of ['cursor', 'antigravity']) expect(offer(id).capabilities.models, id).toMatchObject({ wires: [], ownOnly: true })
  })
})
