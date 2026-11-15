import { createElement } from 'react'
import { testHarness } from '@latch/testkit'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot, HostCatalog } from '@latch/protocol'
import { SetupCard } from '../src/newSession/NewSession.tsx'
import { sessionMenuSections } from '../src/sessionMenu.ts'
import { SettingsPage, settingsSections } from '../src/settings/SettingsPage.tsx'
import { harnessName, startBlock } from '../src/composerChoice.ts'

const noop = () => {}
const catalog: HostCatalog = {
  harnesses: [testHarness('standard', { kind: 'builtin', label: 'Standard' })],
  providers: [],
  workspaces: [{ id: 'default', name: 'app', path: '/work/app' }],
  defaults: { harnessId: 'standard', mode: 'agent', workspaceId: 'default' },
}
/**
 * An owner on a Host that predates the catalog (and its provider, agent, workspace and session APIs) and
 * device confirmation (its snapshot has no `host`, and the device still carries the old owner role).
 */
const legacy = {
  instanceId: 'host',
  device: { id: 'd', name: 'Mac', role: 'owner', createdAt: '', lastSeenAt: '', revoked: false },
  tasks: [],
  approvals: [],
  demo: false,
  hostName: 'host',
  execution: { ready: false, providerId: 'openai-compatible', modelConfigurationRequired: true },
} as unknown as AppSnapshot

describe('older Host without a catalog', () => {
  it('offers only settings the Host can serve', () => {
    // The device page needs the newer device API, and model services the catalog, so both are hidden on such a Host.
    expect(settingsSections(legacy)).toEqual(['general', 'plugins', 'shortcuts', 'about'])
    expect(settingsSections({ ...legacy, catalog })).toEqual([
      'general',
      'providers',
      'engines',
      'workspaces',
      'plugins',
      'shortcuts',
      'about',
    ])
    const html = renderToStaticMarkup(
      createElement(SettingsPage, { snapshot: legacy, section: 'general', onClose: noop, onSection: noop, onChanged: noop }),
    )
    expect(html).not.toContain('settings-tab-engines')
  })

  it('says model services cannot be set up here instead of offering a page the Host cannot serve', () => {
    const block = startBlock(legacy, { harnessId: 'standard', mode: 'agent' } as never)
    expect(block).toMatchObject({ kind: 'model-required', settable: false })
    if (block?.kind !== 'model-required') throw new Error('expected the model service block')
    const html = renderToStaticMarkup(createElement(SetupCard, { block, owner: true, onSetup: noop }))
    expect(html).toContain('较旧')
    expect(html).not.toContain('<button')
  })

  it('keeps session actions to export', () => {
    const task = { harnessId: 'standard', id: 's', title: 't', status: 'idle' as const, updatedAt: '' }
    const actions = { rename: noop, pin: noop, archive: noop, export: noop, remove: noop }
    expect(sessionMenuSections(task, actions, false).flatMap(section => section.items.map(item => item.id))).toEqual(['export'])
    expect(sessionMenuSections(task, actions, true).flatMap(section => section.items.map(item => item.id))).toEqual([
      'rename',
      'pin',
      'export',
      'archive',
      'delete',
    ])
  })
})
