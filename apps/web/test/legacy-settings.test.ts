import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot, HostCatalog } from '@latch/protocol'
import { SetupCard } from '../src/components/NewSession.tsx'
import { sessionMenuSections } from '../src/sessionMenu.ts'
import { SettingsPage, settingsSections } from '../src/settings/SettingsPage.tsx'
import { harnessName, startBlock } from '../src/composerChoice.ts'
import { pluginName } from '../src/settings/PluginsSettings.tsx'

const noop = () => {}
const catalog: HostCatalog = {
  harnesses: [{ id: 'standard', name: 'Standard', source: 'builtin', status: 'ready', modes: ['chat', 'agent'], models: 'host' }],
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
    expect(settingsSections(legacy)).toEqual(['general', 'shortcuts', 'plugins', 'about'])
    expect(settingsSections({ ...legacy, catalog })).toEqual([
      'general',
      'providers',
      'engines',
      'workspaces',
      'shortcuts',
      'plugins',
      'about',
    ])
    const html = renderToStaticMarkup(
      createElement(SettingsPage, { snapshot: legacy, section: 'general', onSection: noop, onChanged: noop }),
    )
    expect(html).not.toContain('settings-tab-engines')
  })

  it('says model services cannot be set up here instead of offering a page the Host cannot serve', () => {
    const block = startBlock(legacy, { harnessId: 'standard', mode: 'agent' } as never)
    expect(block).toMatchObject({ kind: 'model-required', settable: false })
    const html = renderToStaticMarkup(createElement(SetupCard, { block: block!, owner: true, onSetup: noop }))
    expect(html).toContain('较旧')
    expect(html).not.toContain('<button')
  })

  it('keeps session actions to export', () => {
    const task = { id: 's', title: 't', status: 'idle' as const, updatedAt: '' }
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

describe('the built-in harness on a Host from before its rename', () => {
  it('reads 「Latch 内置」 in settings, though the Host still says 「Standard Harness」', () => {
    const old = { id: 'standard', name: 'Standard Harness', source: 'builtin' as const }
    expect(harnessName(old)).toBe('Latch 内置')
    expect(harnessName({ id: 'codex', name: 'Codex', source: 'acp' })).toBe('Codex')
    // Only the built-in one: a plugin harness that calls itself standard keeps its own name.
    expect(harnessName({ id: 'standard', name: 'Standard Harness', source: 'plugin' })).toBe('Standard Harness')
    expect(pluginName({ name: 'Standard Harness', capabilities: ['harness:standard'] })).toBe('Latch 内置')
    expect(pluginName({ name: '工作区文件', capabilities: ['tool:read_file'] })).toBe('工作区文件')
  })
})
