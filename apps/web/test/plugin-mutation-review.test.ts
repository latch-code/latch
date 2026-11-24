// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PluginPackageReview } from '@latch/protocol'
import {
  isPluginPackageReview,
  PluginMutationDialog,
  PluginRiskFacts,
  reviewedPluginMutation,
  type PluginMutationTarget,
} from '../src/settings/PluginMutationReview.tsx'

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
      expect(action('确认应用').getAttribute('aria-disabled')).not.toBe('true')
      await render({ ...target, operation: 'rollback' })
      expect(action('确认回退').getAttribute('aria-disabled')).toBe('true')
      expect(host.textContent).toContain('无法读取此版本的完整审阅信息')
      act(() => action('确认回退').click())
      expect(onConfirm).not.toHaveBeenCalled()
      await render({ ...target, operation: 'apply', revision: '3'.repeat(64) })
      expect(action('确认应用').getAttribute('aria-disabled')).toBe('true')
      expect(host.textContent).toContain('无法读取此版本的完整审阅信息')
      act(() => action('确认应用').click())
      expect(onConfirm).not.toHaveBeenCalled()
    } finally {
      await act(async () => root.unmount())
      host.remove()
      vi.unstubAllGlobals()
    }
  })
})
