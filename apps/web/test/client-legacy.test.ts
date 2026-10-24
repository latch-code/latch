import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot, HostCatalog } from '@latch/protocol'
import { ApiError } from '../src/core/api.ts'
import { sessionMenuSections } from '../src/sessionMenu.ts'
import { SettingsPage, settingsSections } from '../src/settings/SettingsPage.tsx'
import { isMissingTask } from '../src/core/useHarness.ts'

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
      createElement(SettingsPage, { snapshot: legacy, initial: 'providers', onClose: noop, onChanged: noop }),
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
      'archive',
      'export',
      'delete',
    ])
  })
})

describe('selection that the Host no longer has', () => {
  it('is recognized from the task-not-found answer, not from connection failures', () => {
    expect(isMissingTask(new ApiError(404, 'task-not-found', '找不到该任务'))).toBe(true)
    expect(isMissingTask(new ApiError(404, 'not-found', '接口不存在'))).toBe(false)
    expect(isMissingTask(new ApiError(503, 'unavailable', '暂不可用'))).toBe(false)
    expect(isMissingTask(new TypeError('Failed to fetch'))).toBe(false)
  })
})
