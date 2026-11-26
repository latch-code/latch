// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createPluginPackageTemplate,
  type AppSnapshot,
  type PluginCatalogCheckResult,
  type PluginCatalogPreview,
  type PluginPackageDetail,
  type PluginPackageReview,
  type PluginPackageSummary,
} from '@latch/protocol'
import { PluginMarketplace } from '../src/plugin-marketplace/PluginMarketplace.tsx'
import { useInstalledPluginSwitch } from '../src/plugin-marketplace/InstalledPluginSwitch.tsx'

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

const render = (props: {
  snapshot: AppSnapshot
  access: Parameters<typeof PluginMarketplace>[0]['access']
  source?: Parameters<typeof PluginMarketplace>[0]['source']
  onManage?: (id: string) => void
}) =>
  act(async () =>
    root.render(
      createElement(PluginMarketplace, {
        open: true,
        showBundled: true,
        source: props.source ?? 'bundled',
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
const admin = (hostId: string) => {
  const device = { id: 'owner', dataScope: 'all' } as AppSnapshot['device']
  return {
    snapshot: { revision: 0, device, host: { hostId }, catalog: { features: { pluginPackages: true } } } as AppSnapshot,
    access: { legacy: false, local: true, admin: true, scopes: new Set(['view', 'admin'] as const), device },
  }
}
function checkedCatalog(version: string): PluginCatalogCheckResult {
  return {
    plugins: Object.keys(catalogManifests).map(pluginId => ({
      id: pluginId,
      version,
      revision,
      commit: 'a'.repeat(40),
      ...(pluginId === id ? { updateStatus: 'available' as const } : {}),
    })),
  }
}

it('locks an in-use installed switch, retries its original write, and enables only the reviewed applied revision', async () => {
  const requests: unknown[] = []
  const onChanged = vi.fn()
  let uncertain = true
  let activeRuns = 1
  let state = true
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/plugins')) return Response.json({ plugins: [{ id, enabled: state, activeRuns }] })
    if (url.includes('/review?')) {
      expect(new URL(url, 'http://latch.invalid').searchParams.get('revision')).toBe(revision)
      return Response.json({ review: { ...review, baseAppliedRevision: revision, installId } })
    }
    if (!url.endsWith('/enabled')) throw new Error('unexpected route')
    const body = JSON.parse(String(init.body))
    requests.push(body)
    if (uncertain) return Response.json({ error: 'plugin-package-write-unknown' }, { status: 503 })
    state = body.enabled
    return Response.json({ package: { id, enabled: state } })
  })
  vi.stubGlobal('fetch', fetch)
  function Card({ storageKey, editable, snapshotRevision }: { storageKey: string; editable: boolean; snapshotRevision: number }) {
    const controls = useInstalledPluginSwitch({
      active: true,
      editable,
      connected: true,
      storageKey,
      revision: snapshotRevision,
      onChanged,
    })
    const record = { ...summary, revision: 'a'.repeat(64), appliedRevision: revision, enabled: state }
    return createElement(Fragment, null, controls.control(record, '交接'), controls.feedback)
  }
  const draw = (storageKey: string, editable: boolean, snapshotRevision = 0) =>
    act(async () => root.render(createElement(Card, { storageKey, editable, snapshotRevision })))
  const toggle = () => element.querySelector<HTMLButtonElement>('[role="switch"]')!
  const retry = () => buttons(element, '重试同一请求')
  await draw('switch-test', true)
  expect(enabled(toggle())).toBe(false)
  await act(async () => toggle().click())
  expect(requests).toEqual([])
  activeRuns = 0
  await draw('switch-test', true, 1)
  await act(async () => toggle().click())
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ enabled: false, requestId: expect.any(String) })
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  expect(retry()).toHaveLength(1)
  await draw('switch-test', false)
  expect(retry()).toHaveLength(0)
  expect(enabled(toggle())).toBe(false)
  await draw('other-device', true)
  expect(retry()).toHaveLength(0)
  uncertain = false
  await draw('switch-test', true)
  await act(async () => retry()[0].click())
  expect(requests[1]).toEqual(requests[0])
  expect(retry()).toHaveLength(0)
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  await act(async () => toggle().click())
  expect(requests).toHaveLength(2)
  const approve = buttons(element, '确认启用')[0]
  expect(enabled(approve)).toBe(true)
  await act(async () => approve.click())
  expect(requests[2]).toMatchObject({ enabled: true, reviewedInstallId: installId, baseAppliedRevision: revision })
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  expect(onChanged).toHaveBeenCalledTimes(2)
})

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
  expect(buttons(element, '检查更新')).toHaveLength(0)
  // The list stays underneath, with its cards' versions free of the old prefix.
  expect(element.querySelector('.plugin-market-gallery')).not.toBeNull()
  expect(element.textContent).not.toContain('随附 v')
  await act(async () => buttons(dialog(), '取消')[0]!.click())
  expect(dialog().open).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
})

it('manages an applied package with no release source by its local identity and hides it when access is revoked', async () => {
  const owner = admin('inventory')
  const { catalog: _catalog, ...local } = summary
  const record = { ...local, name: '本机自建交接', description: '自定义交接流程', state: 'applied', appliedRevision: revision }
  const official = { ...summary, id: 'context-insights', appliedRevision: revision }
  const fetch = vi.fn(async (url: string) =>
    url.endsWith('/plugin-packages') ? Response.json({ packages: [record, official] }) : Response.json(checkedCatalog('2.0.0')),
  )
  vi.stubGlobal('fetch', fetch)
  const onManage = vi.fn()
  await render({ ...owner, source: 'installed', onManage })
  await settle()
  const panel = element.querySelector('[role="tabpanel"]:not([hidden])')!
  const cards = [...panel.querySelectorAll('li')]
  expect(cards).toHaveLength(2)
  expect(cards[0]!.parentElement).toBe(cards[1]!.parentElement)
  const custom = cards.find(card => card.textContent?.includes(record.name))!
  expect(custom.textContent).toContain(record.description)
  expect(custom.textContent).toContain(record.version)
  expect(buttons(custom, '检查更新')).toHaveLength(0)
  expect(buttons(custom, '审阅更新')).toHaveLength(0)
  await act(async () => buttons(custom, '管理')[0]!.click())
  expect(onManage).toHaveBeenCalledExactlyOnceWith(record.id)

  fetch.mockClear()
  await render({ ...owner, source: 'installed', access: { ...owner.access, admin: false, scopes: new Set(['view']) } })
  expect(element.textContent).not.toContain(record.name)
  expect([...element.querySelectorAll('[role="tab"]')].some(tab => tab.textContent === '已安装')).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
})

it('keeps the bundled review after a failed check, then refreshes all four cards and the open update dialog on a manual retry', async () => {
  const version = '2.0.0'
  const newBundle = { ...bundle, manifest: { ...bundle.manifest, version, description: '官方新版本的说明' } }
  const remoteRevision = '8'.repeat(64)
  const commit = 'a'.repeat(40)
  const checked = checkedCatalog(version)
  checked.plugins.find(plugin => plugin.id === id)!.revision = remoteRevision
  const current = { ...summary, state: 'applied' as const, enabled: true, appliedVersion: summary.version, appliedRevision: revision }
  const requests: Array<{ force?: true }> = []
  const stage = vi.fn()
  let release!: () => void
  const held = new Promise<void>(done => {
    release = done
  })
  let online = false
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/catalog/check')) {
      requests.push(JSON.parse(String(init?.body)) as { force?: true })
      if (requests.length === 1)
        return Response.json({ error: 'plugin-external-github-rate-limit', message: 'untrusted details' }, { status: 429 })
      await held
      online = true
      return Response.json(checked)
    }
    if (url.endsWith('/plugin-packages')) {
      return Response.json({
        packages: [
          { ...current, catalogUpdate: { version: online ? version : summary.version, status: online ? 'available' : 'current' } },
        ],
      })
    }
    if (url.endsWith('/catalog/preview')) {
      return Response.json({
        bundle: online ? newBundle : bundle,
        review: online ? { ...review, revision: remoteRevision, version, source: { kind: 'catalog', version, commit } } : review,
        installed: { id, installId, revision, version: summary.version, modified: false },
        updateAvailable: online,
        updateStatus: online ? 'available' : 'current',
      } satisfies PluginCatalogPreview)
    }
    if (url.endsWith('/catalog/stage')) {
      stage(JSON.parse(String(init?.body)) as unknown)
      return Response.json({ package: { ...current, version, revision: remoteRevision } })
    }
    return new Response(null, { status: 404 })
  })
  await render(admin('fixture'))
  await settle()
  expect(requests).toEqual([{}])
  expect(element.textContent).toContain('未能检查官方目录')
  expect(element.textContent).toContain('GitHub 暂时限制匿名读取')
  expect(element.textContent).not.toContain('untrusted details')
  expect(element.textContent).not.toContain('没有可用更新')
  await act(async () => card('交接清单').click())
  expect(dialog().textContent).toContain('已安装 v1.0.0')
  expect(dialog().textContent).not.toContain('已保存此随附版本')
  expect(dialog().textContent).toContain('运行权限与风险')
  await act(async () => buttons(dialog(), '检查更新')[0]!.click())
  expect(requests).toEqual([{}, { force: true }])
  expect(dialog().textContent).toContain('正在检查官方插件目录')
  await act(async () => release())
  await settle()
  for (const metadata of element.querySelectorAll('.plugin-market-card .plugin-market-versions'))
    expect(metadata.textContent).toContain('v2.0.0')
  expect(dialog().textContent).toContain('可更新到 v2.0.0')
  expect(dialog().textContent).toContain('官方新版本的说明')
  expect(dialog().querySelector('a[href*="/tree/"]')?.getAttribute('href')).toBe(
    `https://github.com/latch-code/plugin-market/tree/${commit}/plugins/${id}`,
  )
  expect(dialog().querySelector('a[href*="/commit/"]')?.getAttribute('href')).toBe(
    `https://github.com/latch-code/plugin-market/commit/${commit}`,
  )
  expect(stage).not.toHaveBeenCalled()
  await act(async () => buttons(dialog(), '审阅更新')[0]!.click())
  expect(stage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ pluginId: id, revision: remoteRevision, update: { installId, baseRevision: revision } }),
  )
})

it('discards a late catalog from another Host, including a response that arrives after abort', async () => {
  let finish!: (value: Response) => void
  let count = 0
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.endsWith('/catalog/check')) {
      count++
      if (count === 1)
        return new Promise<Response>(resolve => {
          finish = resolve
        })
      return Response.json(checkedCatalog('2.0.0'))
    }
    return Response.json({ packages: [] })
  })
  await render(admin('first'))
  await render(admin('second'))
  await act(async () => finish(Response.json(checkedCatalog('9.0.0'))))
  await settle()
  const gallery = element.querySelector('.plugin-market-gallery')!
  expect(gallery.textContent).toContain('v2.0.0')
  expect(gallery.textContent).not.toContain('v9.0.0')
  expect(count).toBe(2)
})

it.each([true, false])(
  'keeps the installed version and the official draft distinct after a successful check (applied: %s)',
  async applied => {
    const version = '2.0.0'
    const previous = '6'.repeat(64)
    const result = checkedCatalog(version)
    result.plugins.find(plugin => plugin.id === id)!.updateStatus = 'current'
    const record: PluginPackageSummary = {
      ...summary,
      version,
      catalog: { version, revision },
      catalogUpdate: { version, status: 'current' },
      appliedVersion: applied ? version : '1.0.0',
      appliedRevision: applied ? revision : previous,
      state: applied ? 'applied' : 'update-available',
    }
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/catalog/check')) return Response.json(result)
      if (url.endsWith('/plugin-packages')) return Response.json({ packages: [record] })
      if (url.endsWith('/catalog/preview'))
        return Response.json({
          bundle: { ...bundle, manifest: { ...bundle.manifest, version } },
          review: { ...review, version, source: { kind: 'catalog', version, commit: 'a'.repeat(40) } },
          installed: { id, revision, installId, version, modified: false },
          updateStatus: 'current',
          updateAvailable: false,
        } satisfies PluginCatalogPreview)
      return new Response(null, { status: 404 })
    })
    await render(admin('fixture'))
    await settle()
    await act(async () => card('交接清单').click())
    expect(dialog().textContent).toContain(applied ? '已安装 v2.0.0' : '已安装 v1.0.0')
    expect(dialog().textContent).toContain(applied ? '没有可用更新' : '草稿 v2.0.0')
    expect(buttons(dialog(), '审阅更新')).toHaveLength(0)
    expect(buttons(dialog(), '审阅草稿')).toHaveLength(applied ? 0 : 1)
    expect(dialog().textContent?.includes('没有可用更新')).toBe(applied)
  },
)

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

it('keeps the open dialog steady across update checks, draft review transitions and closing', async () => {
  const draftVersion = '1.2.0'
  const draftRevision = '9'.repeat(64)
  const commit = 'b'.repeat(40)
  const draftBundle = { ...bundle, manifest: { ...bundle.manifest, version: draftVersion } }
  const draftReview: PluginPackageReview = {
    ...review,
    revision: draftRevision,
    version: draftVersion,
    baseAppliedRevision: revision,
    source: { kind: 'catalog', version: draftVersion, commit },
    comparison: {
      revision,
      version: summary.version,
      expandedPageCapabilities: false,
      changedExecution: false,
      manifestChanged: true,
      changedSource: false,
      changedFiles: [{ path: 'SKILL.md', change: 'modified' }],
    },
  }
  const record: PluginPackageSummary = {
    ...summary,
    version: draftVersion,
    revision: draftRevision,
    catalog: { version: draftVersion, revision: draftRevision, commit },
    catalogUpdate: { version: draftVersion, status: 'current' },
    appliedVersion: summary.version,
    appliedRevision: revision,
    state: 'update-available',
  }
  const checked = (): PluginCatalogCheckResult => ({
    plugins: Object.keys(catalogManifests).map(pluginId => ({
      id: pluginId,
      version: pluginId === id ? draftVersion : '1.0.0',
      revision: pluginId === id ? draftRevision : revision,
      commit,
      ...(pluginId === id ? { updateStatus: 'current' as const } : {}),
    })),
  })
  let holdPreview = false
  let releasePreview!: () => void
  let holdDraft = false
  let releaseDraft!: () => void
  let holdMutationReview = false
  let releaseMutationReview!: () => void
  let draftReads = 0
  let mutationReads = 0
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(url, 'http://host.test').pathname.replace(/^.*\/plugin-packages/u, 'plugin-packages')
    if (path === 'plugin-packages/catalog/check') return Response.json(checked())
    if (path === 'plugin-packages') return Response.json({ packages: [record] })
    if (path === 'plugin-packages/catalog/preview') {
      if (holdPreview) {
        await new Promise<void>(resolve => {
          releasePreview = resolve
        })
      }
      return Response.json({
        bundle: draftBundle,
        review: draftReview,
        installed: { id, installId, revision: draftRevision, version: draftVersion, modified: false },
        updateStatus: 'current',
        updateAvailable: false,
      } satisfies PluginCatalogPreview)
    }
    if (path === `plugin-packages/${id}`) {
      draftReads++
      if (holdDraft) {
        await new Promise<void>(resolve => {
          releaseDraft = resolve
        })
      }
      return Response.json({ package: { ...record, bundle: draftBundle, review: draftReview } satisfies PluginPackageDetail })
    }
    if (path === `plugin-packages/${id}/review`) {
      mutationReads++
      if (holdMutationReview) {
        await new Promise<void>(resolve => {
          releaseMutationReview = resolve
        })
      }
      return Response.json({ review: { ...draftReview, installId } })
    }
    return new Response(null, { status: 404 })
  })

  await render(admin('steady'))
  await settle()
  await act(async () => card('交接清单').click())
  await settle()
  expect(dialog().textContent).toContain('文件与源码')
  expect(dialog().textContent).toContain('运行权限与风险')

  // Clicking 检查更新 refreshes the catalog and preview without dropping the existing preview to a loading spinner.
  holdPreview = true
  await act(async () => buttons(dialog(), '检查更新')[0]!.click())
  await settle()
  expect(dialog().textContent).toContain('文件与源码')
  expect(dialog().textContent).toContain('运行权限与风险')
  expect(dialog().textContent).not.toContain('正在读取插件审阅信息')
  holdPreview = false
  await act(async () => releasePreview())
  await settle()

  // Clicking 审阅草稿 reads the draft and its apply review in parallel without collapsing the dialog to 正在读取草稿…
  holdDraft = true
  holdMutationReview = true
  await act(async () => buttons(dialog(), '审阅草稿')[0]!.click())
  await settle()
  expect(draftReads).toBe(1)
  expect(mutationReads).toBe(1)
  expect(dialog().textContent).not.toContain('正在读取草稿')
  expect(dialog().textContent).toContain('文件与源码')
  holdDraft = false
  holdMutationReview = false
  await act(async () => {
    releaseDraft()
    releaseMutationReview()
  })
  await settle()
  expect(dialog().getAttribute('data-secure')).toBe('')
  expect(dialog().textContent).toContain('在哪里运行')
  expect(dialog().textContent).toContain('运行权限与风险')
  expect(draftReads).toBe(1)

  // Closing from the secure review step keeps data-secure for immediate dismissal and never renders a stray 完成 footer.
  await act(async () => buttons(dialog(), '取消')[0]!.click())
  expect(dialog().open).toBe(false)
  expect(dialog().getAttribute('data-secure')).toBe('')
  expect(buttons(dialog(), '完成')).toHaveLength(0)
})
