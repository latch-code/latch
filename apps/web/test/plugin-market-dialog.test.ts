// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createPluginPackageTemplate,
  type AppSnapshot,
  type PluginCatalogPreview,
  type PluginPackageDetail,
  type PluginPackageReview,
  type PluginPackageSummary,
} from '@latch/protocol'
import { PluginMarketplace } from '../src/plugin-marketplace/PluginMarketplace.tsx'

const catalogManifests = {
  'shift-handoff': { name: 'Shift handoff', version: '1.0.0' },
  'release-review': { name: 'Release checklist panel', version: '1.0.0' },
  'release-check': { name: 'Release check history', version: '1.0.0' },
  'context-insights': { name: 'Context', version: '1.0.0' },
}
const id = 'shift-handoff'
const revision = '7'.repeat(64)
const installId = 'i'.repeat(22)
const bundle = createPluginPackageTemplate('skill', id)
const review: PluginPackageReview = {
  revision,
  version: bundle.manifest.version,
  source: { kind: 'catalog', version: bundle.manifest.version },
  baseAppliedRevision: null,
  confirmationRequired: false,
  hostModules: [],
  toolNames: [],
  panels: [],
  pages: [],
  skills: bundle.manifest.skills ?? [],
  dataPanels: bundle.manifest.dataPanels ?? [],
  findings: [],
}
const summary: PluginPackageSummary = {
  id,
  name: bundle.manifest.name,
  version: bundle.manifest.version,
  description: '',
  revision,
  enabled: false,
  trusted: false,
  capabilities: ['skill:guide'],
  state: 'draft',
  catalog: { revision, version: bundle.manifest.version },
}

let element: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('LATCH_CATALOG_MANIFESTS', catalogManifests)
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
})
afterEach(() => {
  act(() => root.unmount())
  element.remove()
  vi.unstubAllGlobals()
})

const render = (props: { snapshot: AppSnapshot; access: Parameters<typeof PluginMarketplace>[0]['access']; onManage?: () => void }) =>
  act(async () =>
    root.render(
      createElement(PluginMarketplace, {
        open: true,
        showBundled: true,
        source: 'bundled',
        onSourceChange: vi.fn(),
        onManage: props.onManage ?? vi.fn(),
        snapshot: props.snapshot,
        access: props.access,
      }),
    ),
  )
const buttons = (parent: ParentNode, label: string) => [...parent.querySelectorAll('button')].filter(item => item.textContent === label)
const card = (title: string) =>
  [...element.querySelectorAll<HTMLButtonElement>('.plugin-market-card-heading')].find(item => item.textContent === title)!
const dialog = () => element.querySelector<HTMLDialogElement>('dialog.plugin-market-dialog')!
const enabled = (button: HTMLButtonElement) => button.getAttribute('aria-disabled') !== 'true'
const settle = () => act(async () => await new Promise(resolve => setTimeout(resolve, 0)))

it('opens a bundled plugin in a dialog without install actions or package reads on a view-only device', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 404 }))
  vi.stubGlobal('fetch', fetch)
  await render({
    snapshot: { revision: 0, device: { id: 'viewer' } } as AppSnapshot,
    access: { legacy: false, local: false, admin: false, scopes: new Set(['view'] as const), device: null },
  })
  const listing = card('交接清单')
  expect(listing.getAttribute('aria-haspopup')).toBe('dialog')
  expect(dialog().open).toBe(false)
  await act(async () => listing.click())
  expect(dialog().open).toBe(true)
  expect(dialog().querySelector('.ui-dialog-title')?.textContent).toBe('交接清单')
  expect(dialog().textContent).toContain('运行权限')
  expect(dialog().textContent).toContain('请在这台 Mac 的 Latch 桌面端安装插件。')
  expect(buttons(dialog(), '审阅并安装')).toHaveLength(0)
  expect(buttons(dialog(), '应用')).toHaveLength(0)
  // The list stays underneath, with its cards' versions free of the old prefix.
  expect(element.querySelector('.plugin-market-gallery')).not.toBeNull()
  expect(element.textContent).not.toContain('随附 v')
  await act(async () => buttons(dialog(), '取消')[0]!.click())
  expect(dialog().open).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
})

it('saves a draft, shows the files and the Host review before Apply, and applies the reviewed revision in the dialog', async () => {
  const detail: PluginPackageDetail = { ...summary, bundle, review }
  let packages: PluginPackageSummary[] = []
  let releaseReview!: () => void
  const reviewHeld = new Promise<void>(resolve => {
    releaseReview = resolve
  })
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://host.test').pathname.replace(/^.*\/plugin-packages/u, 'plugin-packages')
    const query = new URL(url, 'http://host.test').search
    const method = init?.method ?? 'GET'
    calls.push({ method, path: path + query, ...(init?.body ? { body: JSON.parse(init.body as string) as unknown } : {}) })
    if (path === 'plugin-packages') return Response.json({ packages })
    if (path === 'plugin-packages/catalog/preview') return Response.json({ bundle, review } satisfies PluginCatalogPreview)
    if (path === 'plugin-packages/catalog/stage') {
      packages = [summary]
      return Response.json({ package: summary })
    }
    if (path === `plugin-packages/${id}`) return Response.json({ package: detail })
    if (path === `plugin-packages/${id}/review`) {
      await reviewHeld
      return Response.json({ review: { ...review, installId } })
    }
    if (path === `plugin-packages/${id}/apply`) {
      packages = [{ ...summary, state: 'applied', appliedRevision: revision, appliedVersion: summary.version, enabled: true }]
      return Response.json({ package: { ...detail, ...packages[0] } })
    }
    return new Response(null, { status: 404 })
  })
  vi.stubGlobal('fetch', fetch)
  const onManage = vi.fn()
  const device = { id: 'owner', dataScope: 'all' } as AppSnapshot['device']
  await render({
    snapshot: { revision: 0, device, catalog: { features: { pluginPackages: true } } } as AppSnapshot,
    access: { legacy: false, local: true, admin: true, scopes: new Set(['view', 'admin'] as const), device },
    onManage,
  })
  await act(async () => card('交接清单').click())
  await settle()
  const install = buttons(dialog(), '审阅并安装')[0]!
  expect(enabled(install)).toBe(true)
  // The catalog revision's risk facts come before saving anything.
  expect(dialog().textContent).toContain('运行权限与风险')
  expect(dialog().querySelector('.ui-dialog-footer')?.textContent).toContain('先保存草稿，应用后才会启用。')
  await act(async () => install.click())
  await settle()
  expect(calls.find(call => call.path === 'plugin-packages/catalog/stage')?.body).toMatchObject({ pluginId: id, revision })
  // The draft's files are readable while the Host's review is still on its way, and Apply waits for it.
  expect(dialog().open).toBe(true)
  expect(dialog().getAttribute('data-secure')).toBe('')
  expect(dialog().querySelector('.creator-plugin-source')?.textContent).toBe(bundle.files[0]!.content)
  expect(dialog().textContent).toContain('在哪里运行')
  const apply = () => buttons(dialog(), '应用')[0]!
  expect(enabled(apply())).toBe(false)
  // A click on the waiting button sends nothing.
  await act(async () => apply().click())
  await act(async () => releaseReview())
  await settle()
  expect(dialog().textContent).toContain('运行权限与风险')
  expect(enabled(apply())).toBe(true)
  expect(calls.some(call => call.path === `plugin-packages/${id}/apply`)).toBe(false)
  await act(async () => apply().click())
  await settle()
  const applied = calls.filter(call => call.path === `plugin-packages/${id}/apply`)
  expect(applied).toHaveLength(1)
  expect(applied[0]).toMatchObject({ method: 'POST', body: { revision, reviewedInstallId: installId, baseAppliedRevision: null } })
  expect(dialog().textContent).toContain('已安装 v1.0.0')
  expect(onManage).not.toHaveBeenCalled()
  await act(async () => buttons(dialog(), '完成')[0]!.click())
  expect(dialog().open).toBe(false)
})
