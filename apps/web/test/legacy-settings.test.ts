import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot, HostCatalog } from '@latch/protocol'
import { sessionMenuSections } from '../src/sessionMenu.ts'
import { SettingsPage, settingsSections } from '../src/settings/SettingsPage.tsx'
import { harnessName } from '../src/composerChoice.ts'
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
  it('offers only settings the Host can serve, with the single-provider form for model setup', () => {
    // The device page needs the newer device API, so it is hidden on such a Host.
    expect(settingsSections(legacy)).toEqual(['general', 'providers', 'plugins', 'about'])
    expect(settingsSections({ ...legacy, catalog })).toEqual(['general', 'providers', 'agents', 'workspaces', 'plugins', 'about'])
    const html = renderToStaticMarkup(
      createElement(SettingsPage, { snapshot: legacy, section: 'providers', onSection: noop, onChanged: noop }),
    )
    expect(html).toContain('当前执行端版本只支持一个 OpenAI 兼容接口')
    expect(html).not.toContain('settings-tab-agents')
    expect(html).not.toContain('settings-tab-workspaces')
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
