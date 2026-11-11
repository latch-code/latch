import { describe, expect, it } from 'vitest'
import { AGENT_PRESETS } from '@latch/protocol'
import { presetOffer } from '../src/index.ts'

const offer = (id: string) => presetOffer(AGENT_PRESETS.find(preset => preset.id === id)!)

describe('which harnesses Latch never forwards to a model service', () => {
  it('says so of the vendor agents that keep to their own login', () => {
    for (const id of ['claude-agent', 'cursor']) expect(offer(id).capabilities.models).toMatchObject({ wires: [], ownOnly: true })
  })

  it('leaves it unsaid of one Latch forwards, and of one it may forward later', () => {
    expect(offer('codex').capabilities.models).not.toHaveProperty('ownOnly')
    expect(offer('opencode').capabilities.models).not.toHaveProperty('ownOnly')
  })
})
