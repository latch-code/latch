import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot, HostCatalog, TaskDetail } from '@latch/protocol'
import { Transcript } from '../src/components/Transcript.tsx'
import { ApiError } from '../src/core/api.ts'
import { sessionMenuSections } from '../src/sessionMenu.ts'
import { SettingsPage, settingsSections } from '../src/settings/SettingsPage.tsx'
import { isMissingTask } from '../src/core/useHarness.ts'
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
      'export',
      'archive',
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

describe('history from a Host that records no times', () => {
  it('renders without times, durations, separators or a thinking timer, and its footer keeps the tokens', () => {
    const detail: TaskDetail = {
      summary: { id: 's', title: 't', status: 'idle', updatedAt: '' },
      messages: [
        { id: 'u', role: 'user', text: '一' },
        { id: 'a', role: 'assistant', text: '答', reasoning: '想', usage: { inputTokens: 1200, outputTokens: 30 } },
        { id: 'tool:1', role: 'tool', text: 'ok', toolName: 'run', state: 'completed', tool: { kind: 'execute' } },
        { id: 'b', role: 'assistant', text: '好' },
      ],
      approvals: [],
      liveText: '',
      cursor: 1,
    }
    const html = renderToStaticMarkup(
      createElement(Transcript, { detail, approvals: [], busy: new Map(), onDecide: noop, harnessName: 'Latch' }),
    )
    expect(html).not.toContain('<time')
    expect(html).not.toContain('time-separator')
    expect(html).not.toContain('用时')
    expect(html).not.toContain('思考了')
    expect(html).not.toContain('process-time')
    expect(html).toContain('思考过程')
    expect(html).toContain('>输入 1.2k tokens</span>')
    expect(html).toContain('>输出 30 tokens</span>')
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
