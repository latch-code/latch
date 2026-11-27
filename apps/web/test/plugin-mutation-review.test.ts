// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PluginPackageReview, PluginPackageSummary } from '@latch/protocol'
import {
  isPluginPackageReview,
  PluginMutationDialog,
  PluginRiskFacts,
  reviewedPluginMutation,
  type PluginMutationTarget,
} from '../src/settings/PluginMutationReview.tsx'

import { usePluginAssets } from '../src/settings/PluginAssetsSettings.tsx'
import { provideSessionLinks } from '../src/core/sessionLinks.ts'

const base = '1'.repeat(64)
const revision = '2'.repeat(64)
const installId = 'a'.repeat(22)
const target: PluginMutationTarget = { id: 'example', name: '示例插件', operation: 'apply', revision }
const review: PluginPackageReview = {
  revision,
  version: '2.0.0',
  source: { kind: 'catalog', version: '2.0.0' },
  baseAppliedRevision: base,
  confirmationRequired: true,
  hostModules: ['host.mjs'],
  toolNames: [],
  panels: [],
  pages: [{ id: 'main', title: '主页面', dataVersion: 1, capabilities: { 'tasks.start': { projects: 'any' } } }],
  skills: [],
  dataPanels: [],
  findings: [],
  comparison: {
    revision: base,
    version: '1.0.0',
    changedSource: false,
    manifestChanged: true,
    changedFiles: [{ path: 'host.mjs', change: 'modified' }],
    changedExecution: true,
    expandedPageCapabilities: true,
  },
}

describe('plugin mutation review', () => {
  it('requires the exact target, the base comparison, and a renderable set of permissions', () => {
    expect(isPluginPackageReview(review, revision)).toBe(true)
    expect(isPluginPackageReview(review, base)).toBe(false)
    expect(isPluginPackageReview({ ...review, comparison: undefined }, revision)).toBe(false)
    expect(isPluginPackageReview({ ...review, confirmationRequired: undefined }, revision)).toBe(false)
    expect(isPluginPackageReview({ ...review, pages: [{ ...review.pages[0], capabilities: { 'new.action': true } }] })).toBe(false)
  })

  it('shows an unfamiliar Host finding with hidden characters escaped', () => {
    const unfamiliar = {
      ...review,
      findings: [{ kind: 'something\u202e-new', files: ['helper.mjs'] }],
    } as unknown as PluginPackageReview
    const html = renderToStaticMarkup(createElement(PluginRiskFacts, { review: unfamiliar }))
    expect(html).toContain('未识别的风险类型')
    expect(html).toContain('\\u{202E}')
    expect(html).toContain('helper.mjs')
    expect(html).toContain('1.0.0 → 2.0.0')
    expect(html).toContain('在任意项目开始会话')
    expect(html).toContain('data-secure=""')
  })

  it.each([
    { operation: 'apply', route: 'apply', fields: { revision } },
    { operation: 'rollback', route: 'rollback', fields: { revision } },
    { operation: 'enable', route: 'enabled', fields: { enabled: true } },
  ] as const)('binds $operation to the reviewed installation and applied revision', ({ operation, route, fields }) => {
    expect(reviewedPluginMutation({ ...target, operation }, { ...review, installId })).toEqual({
      path: `plugin-packages/example/${route}`,
      options: {
        method: 'POST',
        body: { ...fields, baseAppliedRevision: base, reviewedInstallId: installId, requestId: expect.any(String) },
      },
    })
  })

  it('keeps a fast successful settings update in the same dialog while the list refreshes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const record: PluginPackageSummary = {
      id: target.id,
      name: target.name,
      version: review.version,
      description: '',
      revision,
      appliedRevision: base,
      state: 'update-available',
      enabled: true,
      trusted: true,
      capabilities: [],
    }
    let writes = 0
    let finishRead!: () => void
    const refreshing = new Promise<void>(resolve => {
      finishRead = resolve
    })
    vi.stubGlobal('fetch', async (input: string) => {
      if (input.endsWith('/plugin-packages')) {
        if (writes) await refreshing
        return Response.json({ packages: [record] })
      }
      if (input.endsWith('/apply')) {
        writes++
        return Response.json({})
      }
      return Response.json({ review: { ...review, installId } })
    })
    function Settings() {
      const assets = usePluginAssets({ canEdit: true, onChanged: () => {}, onPreview: () => {} })
      return createElement(Fragment, null, createElement('button', { onClick: () => assets.applyDraft(record) }, 'open'), assets.dialogs)
    }
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const action = (label: string) => [...host.querySelectorAll('button')].find(button => button.textContent === label)!
    try {
      await act(async () => root.render(createElement(Settings)))
      await act(async () => action('open').click())
      const dialog = host.querySelector<HTMLDialogElement>('dialog.plugin-mutation-dialog')!
      await act(async () => action('确认更新').click())
      expect(dialog.open).toBe(true)
      expect(dialog.querySelector('[role="status"]')?.textContent).toBe('已更新至 v2.0.0')
      await act(async () => finishRead())
      expect(host.querySelector('dialog.plugin-mutation-dialog')).toBe(dialog)
      expect(action('确认更新')).toBeUndefined()
      await act(async () => action('完成').click())
      expect(host.querySelector('dialog.plugin-mutation-dialog')).toBeNull()
      expect(writes).toBe(1)
    } finally {
      finishRead()
      await act(async () => root.unmount())
      host.remove()
      vi.unstubAllGlobals()
    }
  })

  it('cannot write without the current installation identity or reuse an earlier review', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        input.includes('operation=apply') ? Response.json({ review: { ...review, installId } }) : Response.json({ review }),
      ),
    )
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    const render = (next: PluginMutationTarget) =>
      act(async () => root.render(createElement(PluginMutationDialog, { target: next, onConfirm, onClose })))
    const action = (label: string) => [...host.querySelectorAll('button')].find(button => button.textContent === label)!
    try {
      await render(target)
      expect(action('确认更新').getAttribute('aria-disabled')).not.toBe('true')
      await render({ ...target, operation: 'rollback' })
      expect(action('确认回退').getAttribute('aria-disabled')).toBe('true')
      expect(host.textContent).toContain('无法读取此版本的完整审阅信息')
      act(() => action('确认回退').click())
      expect(onConfirm).not.toHaveBeenCalled()
      await render({ ...target, operation: 'apply', revision: '3'.repeat(64) })
      expect(action('确认').getAttribute('aria-disabled')).toBe('true')
      expect(host.textContent).toContain('无法读取此版本的完整审阅信息')
      act(() => action('确认').click())
      expect(onConfirm).not.toHaveBeenCalled()
    } finally {
      await act(async () => root.unmount())
      host.remove()
      vi.unstubAllGlobals()
    }
  })

  it('keeps a confirmation off while a full-access session runs, except for sending an unknown write again', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ review: { ...review, installId } })),
    )
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onConfirm = vi.fn()
    const retryRequest = vi.fn()
    const render = (retry?: () => void) =>
      act(async () =>
        root.render(
          createElement(PluginMutationDialog, { target, onConfirm, onClose: vi.fn(), ...(retry ? { retryRequest: retry } : {}) }),
        ),
      )
    const action = (label: string) => [...host.querySelectorAll('button')].find(button => button.textContent === label)!
    const running = {
      id: 'session-1',
      title: '修复设置页',
      harnessId: 'codex',
      level: 'L3',
      status: 'running',
      updatedAt: '2026-01-01T00:00:00Z',
    }
    const links = (tasks: unknown[]) =>
      act(async () => provideSessionLinks({ snapshot: { tasks } as never, open: vi.fn(), stop: vi.fn(async () => undefined) }))
    try {
      await links([running])
      await render()
      expect(action('确认更新').getAttribute('aria-disabled')).toBe('true')
      expect(host.textContent).toContain('正在运行「修复设置页」，结束后才能应用插件。')
      act(() => action('确认更新').click())
      expect(onConfirm).not.toHaveBeenCalled()
      await render(retryRequest)
      expect(action('重试同一请求').getAttribute('aria-disabled')).not.toBe('true')
      act(() => action('重试同一请求').click())
      expect(retryRequest).toHaveBeenCalledTimes(1)
      await render()
      await links([{ ...running, status: 'completed' }])
      expect(action('确认更新').getAttribute('aria-disabled')).not.toBe('true')
      act(() => action('确认更新').click())
      expect(onConfirm).toHaveBeenCalledTimes(1)
    } finally {
      provideSessionLinks(null)
      await act(async () => root.unmount())
      host.remove()
      vi.unstubAllGlobals()
    }
  })
})
