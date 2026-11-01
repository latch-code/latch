import { BUILTIN_HARNESS_LABEL } from '@latch/protocol'
import { describe, expect, it } from 'vitest'
import { harnessFacts, trustOf, type HarnessKind } from '../src/harness-trust.ts'

const STRONGEST = {
  models: { owner: 'latch', catalogue: 'live', wires: ['responses'] },
  permission: { enforcement: 'latch', rejectionNote: true },
  tools: { shell: false },
  display: { label: BUILTIN_HARNESS_LABEL, mark: 'latch' },
} as const
const facts = (kind: HarnessKind, ...[declared, name]: [Parameters<typeof harnessFacts>[0]?, string?]) =>
  harnessFacts(declared, name ?? 'Driver', kind)
const strongest = (kind: HarnessKind) => facts(kind, STRONGEST as never)

describe('what a driver can say about itself', () => {
  it('reaches L1 only as the built-in driver, whatever another one declares', () => {
    expect(trustOf('builtin', strongest('builtin'))).toEqual({ kind: 'builtin', level: 'L1', enforcement: 'latch' })
    for (const kind of ['acp', 'plugin'] as const)
      expect(trustOf(kind, strongest(kind))).toEqual({ kind, level: 'L3', enforcement: 'harness' })
  })

  it('lets the built-in driver declare less, and then it is not L1', () => {
    const lowered = facts('builtin', { permission: { enforcement: 'none' } })
    expect(trustOf('builtin', lowered)).toEqual({ kind: 'builtin', level: 'L3', enforcement: 'none' })
  })

  it('takes the weakest value for what is left out, and for values that are no such thing', () => {
    const weakest = {
      models: { owner: 'harness', catalogue: 'none', wires: [] },
      permission: { enforcement: 'none', rejectionNote: false },
      tools: { shell: true, fileMentions: false },
      display: { label: 'Driver', mark: 'plugin' },
    }
    expect(facts('plugin', undefined)).toEqual(weakest)
    const garbage = {
      models: { owner: 'everyone', catalogue: 'all', wires: ['carrier-pigeon', 'responses', 'responses'] },
      permission: { enforcement: 'root', rejectionNote: 'yes' },
    }
    expect(facts('plugin', garbage as never)).toEqual({ ...weakest, models: { ...weakest.models, wires: ['responses'] } })
  })

  it('cannot read as safer than Latch can vouch for: only the built-in driver can say it runs no commands', () => {
    expect(strongest('builtin').tools.shell).toBe(false)
    expect(strongest('acp').tools.shell).toBe(true)
    expect(strongest('plugin').tools.shell).toBe(true)
  })

  it('cannot pass for the built-in harness by name or icon', () => {
    for (const label of [BUILTIN_HARNESS_LABEL, ' latch内置 ', 'Latch​ 内置', 'Ｌａｔｃｈ 内置']) {
      const shown = facts('plugin', { display: { label, mark: 'latch' } }).display
      expect(shown.label).toContain('非内置')
      expect(shown.mark).toBe('plugin')
    }
    // A definition's own name goes the same way as a declared one.
    expect(facts('acp', undefined, BUILTIN_HARNESS_LABEL).display).toEqual({ label: `${BUILTIN_HARNESS_LABEL}（非内置）` })
    expect(strongest('builtin').display).toEqual({ label: BUILTIN_HARNESS_LABEL, mark: 'latch' })
  })

  it('names an icon only from the set a client draws, never a URL', () => {
    expect(facts('acp', { display: { mark: 'codex' } }).display.mark).toBe('codex')
    expect(facts('plugin', { display: { mark: 'codex' } }).display.mark).toBe('codex')
    expect(facts('acp', { display: { mark: 'https://example.test/x.svg' } }).display.mark).toBeUndefined()
    expect(facts('plugin', { display: { mark: '../../secret' } }).display.mark).toBe('plugin')
  })

  it('shows a name that is visible and bounded', () => {
    const { label } = facts('acp', { display: { label: `a‮b${'x'.repeat(200)}` } }).display
    expect(label).not.toContain('‮')
    expect(label.length).toBeLessThanOrEqual(80)
  })
})
