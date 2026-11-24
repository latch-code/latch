// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import {
  createPluginPackageTemplate,
  type AppSnapshot,
  type PluginCatalogPreview,
  type PluginCatalogStage,
  type PluginNpmStage,
  type PluginPackageSummary,
} from '@latch/protocol'
import { setLocale } from '../src/core/i18n.ts'
import { setAuthHooks } from '../src/core/api.ts'
import {
  addPluginSource,
  editPluginSource,
  readPluginBundle,
  needsPageBuild,
  manifestReach,
  packageReach,
  pluginReach,
  typedManifest,
} from '../src/settings/pluginAssets.ts'
import { pluginItems, shelfOf } from '../src/settings/PluginsSettings.tsx'
import { usePluginAssets } from '../src/settings/PluginAssetsSettings.tsx'
import { usePluginAddMarketplace } from '../src/plugin-marketplace/PluginAddMarketplace.tsx'
import { PluginMarketplace } from '../src/plugin-marketplace/PluginMarketplace.tsx'
import { usePluginCatalog } from '../src/plugin-marketplace/usePluginCatalog.ts'

describe('editable plugin imports', () => {
  it('preserves an exported format-2 page and routes TypeScript to the Host builder', () => {
    const page = { id: 'main', title: 'Checklist', entry: 'index.tsx', capabilities: { 'tasks.read': true }, dataVersion: 1 }
    const manifest = {
      formatVersion: 2,
      id: 'checklist',
      version: '1.0.0',
      name: 'Checklist',
      description: '',
      requires: { appSdk: '^1' },
      apps: [page],
    }
    const bundle = { manifest, files: [{ path: 'index.tsx', content: 'export default {}' }] }
    const restored = readPluginBundle(JSON.stringify(bundle))
    expect(restored).toEqual(bundle)
    expect(needsPageBuild(restored.manifest)).toBe(true)
    expect(needsPageBuild({ ...restored.manifest, apps: [{ ...restored.manifest.apps![0]!, entry: 'built.js' }] })).toBe(false)
    expect(() => readPluginBundle(JSON.stringify({ ...bundle, manifest: { ...manifest, apps: [null] } }))).toThrow()
  })
  it.each(['skill', 'tool', 'react-ui'] as const)('round-trips the %s template without executing its source', kind => {
    const bundle = createPluginPackageTemplate(kind)
    expect(readPluginBundle(JSON.stringify(bundle))).toEqual(bundle)
  })
  it('preserves all unrelated contributions while editing and adding sources', () => {
    const bundle = createPluginPackageTemplate('skill')
    const next = addPluginSource(editPluginSource(bundle, 'SKILL.md', '按项目事实完成工作。'), 'tools/format.mjs')
    expect(next.manifest).toEqual(bundle.manifest)
    expect(next.files).toEqual([
      { path: 'SKILL.md', content: '按项目事实完成工作。' },
      { path: 'tools/format.mjs', content: '' },
    ])
    expect(bundle.files[0]!.content).not.toBe(next.files[0]!.content)
  })
  it.each(['../outside', '/root.mjs', 'a//b', 'a/./b', 'C:/x', 'a\\x', 'SKILL.md', 'skill.MD', 'SKILL.md/child', 'latch-plugin.json'])(
    'refuses an ambiguous file path %s',
    path => {
      expect(() => addPluginSource(createPluginPackageTemplate('skill'), path)).toThrow()
    },
  )
  it.each([null, [], {}, { manifest: {} }, { manifest: { ...createPluginPackageTemplate('skill').manifest, skills: [null] }, files: [] }])(
    'refuses an import the editor cannot render safely',
    input => {
      expect(() => readPluginBundle(JSON.stringify(input))).toThrow()
    },
  )
  it('counts UTF-8 bytes and bounds file contents before putting them in the editor', () => {
    const bundle = createPluginPackageTemplate('skill')
    bundle.files[0]!.content = '文'.repeat(340000)
    expect(() => readPluginBundle(JSON.stringify(bundle))).toThrow()
  })

  it('ignores a file read from before editing access was restored and keeps a new read locked until it finishes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('fetch', async () => Response.json({ packages: [] }))
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    function ImportEditor({ canEdit }: { canEdit: boolean }) {
      const assets = usePluginAssets({ canEdit, onChanged: () => {}, onPreview: () => {} })
      return createElement(
        Fragment,
        null,
        createElement('button', { disabled: !canEdit || assets.locked, onClick: assets.importFile }, '导入文件…'),
        assets.dialogs,
      )
    }
    const render = (canEdit: boolean) => act(async () => root.render(createElement(ImportEditor, { canEdit })))
    const button = () => host.querySelector('button')!
    const chooseFile = (id: string) => {
      const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
      const file = new File([], `${id}.latch-plugin.json`)
      let finish!: (text: string) => void
      vi.spyOn(file, 'text').mockReturnValue(
        new Promise(resolve => {
          finish = resolve
        }),
      )
      const data = new DataTransfer()
      data.items.add(file)
      act(() => {
        input.files = data.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
      const bundle = createPluginPackageTemplate('skill', id)
      bundle.manifest.name = id
      return () => act(async () => finish(JSON.stringify(bundle)))
    }
    try {
      await render(true)
      const finishOld = chooseFile('old-plugin')
      expect(button().disabled).toBe(true)
      await render(false)
      await render(true)
      expect(button().disabled).toBe(false)

      const finishNew = chooseFile('new-plugin')
      await finishOld()
      expect(button().disabled).toBe(true)
      expect(host.querySelector('dialog[open]')).toBeNull()
      await finishNew()
      expect(button().disabled).toBe(false)
      expect(host.querySelector<HTMLInputElement>('dialog[open] input')?.value).toBe('new-plugin')
    } finally {
      act(() => root.unmount())
      host.remove()
      vi.unstubAllGlobals()
    }
  })
})

describe('where a plugin runs', () => {
  const manifest = { formatVersion: 1 as const, id: 'p', name: 'p', version: '1', description: '' }
  const ids = (reach: Array<{ id: string }>) => reach.map(item => item.id)

  it('names each part the manifest holds, as it is edited', () => {
    expect(ids(manifestReach(manifest))).toEqual([])
    expect(ids(manifestReach({ ...manifest, panels: [{ id: 'a', title: 'a', entry: 'a.mjs' }] }))).toEqual(['page'])
    expect(ids(manifestReach({ ...manifest, host: ['a.mjs'] }))).toEqual(['host'])
    expect(ids(manifestReach({ ...manifest, skills: [{ id: 's', name: 's', description: '', file: 's.md' }] }))).toEqual(['text'])
  })

  it('follows the manifest as typed in the advanced tab, since applying there applies that text', () => {
    const typed = JSON.stringify({ ...manifest, panels: [{ id: 'a', title: 'a', entry: 'a.mjs' }] })
    expect(ids(manifestReach(typedManifest(typed, manifest)))).toEqual(['page'])
    expect(typedManifest('{ not json', manifest)).toBe(manifest)
    expect(typedManifest('[]', manifest)).toBe(manifest)
  })

  it('counts a connection plugin as code on the Mac', () => {
    expect(ids(pluginReach({ capabilities: ['transport:relay'] }))).toEqual(['host'])
  })

  it('names a panel a Host module registered, which its manifest never declares', () => {
    expect(ids(packageReach({ ...manifest, host: ['a.mjs'] }, { capabilities: ['ui:a'] }))).toEqual(['page', 'host'])
  })

  it('keeps naming a panel the applied revision delivers after a draft removed it', () => {
    expect(ids(packageReach(manifest, { capabilities: ['ui:a'] }))).toEqual(['page'])
  })

  it('says what the Host runs before the manifest is read, or when it cannot be', () => {
    expect(ids(packageReach(undefined, { capabilities: ['tool:a'] }))).toEqual(['host'])
    expect(ids(packageReach(undefined, { capabilities: [] }))).toEqual([])
  })

  it('reads the same from what a loaded plugin provides', () => {
    expect(ids(pluginReach({ capabilities: ['ui:panel', 'tool:read'] }))).toEqual(['page', 'host'])
    expect(ids(pluginReach({ capabilities: ['skill:x'] }))).toEqual(['text'])
    expect(ids(pluginReach({ capabilities: [] }))).toEqual([])
  })
})

describe('plugin shelves', () => {
  it('stands a plugin on the shelf named for what it does', () => {
    expect(shelfOf(['tool:read'])).toBe('tool')
    expect(shelfOf(['ui:panel', 'skill:x'])).toBe('tool')
    expect(shelfOf(['skill:x'])).toBe('skill')
    expect(shelfOf(['provider:openai'])).toBe('tool')
    expect(shelfOf(['harness:acp'])).toBe('tool')
    expect(shelfOf(['transport:relay'])).toBe('connection')
  })

  it('leaves services and Harnesses to their own pages, but not a package of the person', () => {
    const plugin = { id: 'x', name: 'x', version: '1', description: '', enabled: true, activeRuns: 0 }
    const listed = pluginItems(
      [
        { ...plugin, id: 'service', capabilities: ['provider:openai'], managed: 'provider' as const },
        { ...plugin, id: 'agent', capabilities: ['harness:codex'], managed: 'agent' as const },
        { ...plugin, id: 'standard', capabilities: ['harness:standard'], managed: 'core' as const },
        { ...plugin, id: 'ask', capabilities: ['tool:ask'], managed: 'core' as const },
        { ...plugin, id: 'own', capabilities: ['provider:mine'] },
      ],
      [],
    )
    expect(listed.map(item => item.key)).toEqual(['plugin:ask', 'plugin:own'])
  })

  it('lists a package once, with its own state, and a loaded plugin it owns not again', () => {
    const plugin = { id: 'mine', name: 'mine', version: '1', description: '', enabled: true, activeRuns: 0, capabilities: ['skill:x'] }
    const other = { ...plugin, id: 'core', name: 'core', capabilities: ['tool:read'], managed: 'core' as const }
    const record = {
      id: 'mine',
      name: '我的技能',
      version: '1',
      description: '',
      revision: 'r',
      enabled: true,
      trusted: false,
      capabilities: ['skill:x'],
      state: 'applied' as const,
    }
    expect(pluginItems([plugin, other], [record]).map(item => [item.key, item.name, item.state])).toEqual([
      ['package:mine', '我的技能', '已开启'],
      ['plugin:core', 'core', '始终开启'],
    ])
  })
})

const catalogManifests = {
  'shift-handoff': { name: 'Shift handoff', version: '1.0.0' },
  'release-review': { name: 'Release checklist panel', version: '1.0.0' },
  'release-check': { name: 'Release check history', version: '1.0.0' },
  'context-insights': { name: 'Context', version: '1.0.0' },
}

it('finds bundled plugins by their displayed English filter labels', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('LATCH_CATALOG_MANIFESTS', catalogManifests)
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  setLocale('en')
  try {
    await act(async () =>
      root.render(
        createElement(PluginMarketplace, {
          open: true,
          showBundled: true,
          source: 'bundled',
          onSourceChange: vi.fn(),
          snapshot: { revision: 0, device: { id: 'catalog-viewer' } } as AppSnapshot,
          access: { legacy: false, local: false, admin: false, scopes: new Set(['view'] as const), device: null },
          onManage: vi.fn(),
        }),
      ),
    )
    const search = element.querySelector('input[type="search"]') as HTMLInputElement
    const nativeInputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    for (const [term, title] of [
      ['App pages', 'Release check history'],
      ['Tools', 'Release checklist panel'],
    ]) {
      await act(async () => {
        nativeInputSetter.call(search, term)
        search.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(Array.from(element.querySelectorAll('h3'), item => item.textContent)).toEqual([title])
    }
  } finally {
    act(() => root.unmount())
    element.remove()
    setLocale('zh-CN')
    vi.unstubAllGlobals()
  }
})

it('separates locally installed plugins sharing a bundled ID from confirmed bundled installations', async () => {
  const local: Omit<PluginPackageSummary, 'id'> = {
    name: 'Local copy',
    description: '',
    version: '3.0.0',
    revision: 'draft',
    appliedRevision: 'applied',
    appliedVersion: '2.0.0',
    state: 'update-available',
    enabled: true,
    trusted: true,
    capabilities: [],
  }
  const packages: PluginPackageSummary[] = [
    { ...local, id: 'context-insights', catalogUpdate: { version: '1.0.0', status: 'different-source' } },
    { ...local, id: 'shift-handoff' },
    { ...local, id: 'release-review', catalog: { version: '2.0.0', revision: 'applied' } },
  ]
  const device = { id: 'catalog-viewer', dataScope: 'all' } as AppSnapshot['device']
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('LATCH_CATALOG_MANIFESTS', catalogManifests)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => (url.endsWith('/plugin-packages') ? Response.json({ packages }) : new Response(null, { status: 404 }))),
  )
  try {
    await act(async () =>
      root.render(
        createElement(PluginMarketplace, {
          open: true,
          showBundled: true,
          source: 'bundled',
          onSourceChange: vi.fn(),
          snapshot: { device, catalog: { features: { pluginPackages: true } } } as AppSnapshot,
          access: { legacy: false, local: true, admin: true, scopes: new Set(['view', 'admin'] as const), device },
          onManage: vi.fn(),
        }),
      ),
    )
    const versions = (parent: ParentNode) =>
      [...parent.querySelectorAll('.plugin-market-versions > span')].map(element => element.textContent)
    const card = (title: string) =>
      [...element.querySelectorAll('.plugin-market-card')].find(item => item.querySelector('h3')?.textContent === title)!
    const collision = ['随附 v1.0.0', '这台 Mac 上的同标识插件 · v2.0.0']
    expect(versions(card('交接清单'))).toEqual(collision)
    expect(versions(card('发布清单面板'))).toEqual(['随附 v1.0.0', '已安装 v2.0.0', '草稿 v3.0.0'])
    const explicitConflict = card('上下文')
    expect(versions(explicitConflict)).toEqual(collision)
    await act(async () => explicitConflict.querySelector('button')?.click())
    expect(versions(element)).toEqual(collision)
    expect(element.textContent).toContain('查看已有插件')
    expect(element.textContent).not.toContain('审阅并安装')
  } finally {
    act(() => root.unmount())
    element.remove()
    vi.unstubAllGlobals()
  }
})

it.each(['source', 'stage'] as const)('retains the npm %s receipt after downgrading and restoring local permissions', async kind => {
  const registry = 'https://registry.example.test/npm/'
  const stage: PluginNpmStage = {
    release: { registry, name: '@example/plugin', version: '2.0.0', integrity: 'sha512-' + 'A'.repeat(86) + '==' },
    revision: '1'.repeat(64),
    requestId: 'original-request',
    update: { pluginId: 'existing', baseRevision: '2'.repeat(64), installId: 'i'.repeat(22), replaceLocalDraft: true },
  }
  const source = { registry, baseRegistry: null, baseRevision: '3'.repeat(64), requestId: 'source-request' }
  const request = kind === 'source' ? source : stage
  const storageKey = 'example-npm-tab'
  const pendingKey = storageKey + ':' + kind
  sessionStorage.setItem(pendingKey, JSON.stringify(request))
  let response: 'denied' | 'busy' | 'saved' = 'denied'
  const send = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return Response.json({ registry, revision: 'source-revision' })
    if (response === 'denied') return Response.json({ error: 'plugin-package-scope' }, { status: 403 })
    if (response === 'busy') return Response.json({ error: kind === 'source' ? 'rate-limited' : 'plugin-package-busy' }, { status: 429 })
    return Response.json(url.endsWith('/registry') ? { registry, revision: 'source-revision' } : { package: { id: 'existing' } })
  })
  const onStage = vi.fn()
  const onManage = vi.fn()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', send)
  const element = document.createElement('div')
  const root = createRoot(element)
  function Market({ editable }: { editable: boolean }) {
    return usePluginAddMarketplace({
      active: true,
      editable,
      npmEnabled: true,
      externalEnabled: false,
      storageKey,
      records: [],
      onStage,
      onManage,
    }).content
  }
  const render = (editable: boolean) => act(async () => root.render(createElement(Market, { editable })))
  const retry = () => [...element.querySelectorAll('button')].find(button => button.textContent === '重试同一请求')
  const writes = () => send.mock.calls.filter(([, init]) => init?.method === 'POST' || init?.method === 'PUT')
  try {
    await render(true)
    expect(retry()).toBeDefined()
    await act(async () => retry()!.click())
    expect(writes()).toHaveLength(1)
    expect(sessionStorage.getItem(pendingKey)).toBe(JSON.stringify(request))
    await act(async () => root.render(null))
    send.mockClear()
    await render(false)
    expect(retry()).toBeUndefined()
    expect(send).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(pendingKey)).toBe(JSON.stringify(request))
    response = 'busy'
    await render(true)
    expect(retry()).toBeDefined()
    await act(async () => retry()!.click())
    expect(sessionStorage.getItem(pendingKey)).toBe(JSON.stringify(request))
    response = 'saved'
    await act(async () => retry()!.click())
    expect(writes().map(([, init]) => JSON.parse(init!.body as string))).toEqual([request, request])
    expect(sessionStorage.getItem(pendingKey)).toBeNull()
    expect(onStage).toHaveBeenCalledTimes(kind === 'stage' ? 1 : 0)
  } finally {
    act(() => root.unmount())
    sessionStorage.removeItem(pendingKey)
    vi.unstubAllGlobals()
  }
})

it('keeps a catalog request after an unknown write and a busy retry, only on the original Host and device', async () => {
  const keyFor = (hostId: string, deviceId: string) => 'latch:catalog-market:' + JSON.stringify([hostId, deviceId])
  const storageKey = keyFor('host-1', 'device-1')
  const id = 'bundled-example'
  const revision = '4'.repeat(64)
  const bundle = createPluginPackageTemplate('skill', id)
  const preview: PluginCatalogPreview = {
    bundle,
    review: {
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
    },
  }
  const writes: PluginCatalogStage[] = []
  const renew = vi.fn(async () => true)
  const uninstallRenew = setAuthHooks({ renew })
  let inFlight: AbortSignal | null | undefined
  let finish!: (response: Response) => void
  const send = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/preview')) return Response.json(preview)
    writes.push(JSON.parse(init!.body as string) as PluginCatalogStage)
    if (writes.length === 1 || writes.length === 3) return Response.json({ error: 'plugin-package-busy' }, { status: 429 })
    if (writes.length === 2) return Response.json({ error: 'plugin-package-write-unknown' }, { status: 503 })
    if (writes.length === 4) {
      inFlight = init?.signal
      return new Promise<Response>(resolve => {
        finish = resolve
      })
    }
    return Response.json({ package: { id } })
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', send)
  const element = document.createElement('div')
  const root = createRoot(element)
  const onStage = vi.fn()
  function Market({ editable, keyForDevice }: { editable: boolean; keyForDevice: string }) {
    const catalog = usePluginCatalog({
      selectedId: id,
      localRevision: undefined,
      active: true,
      editable,
      connected: true,
      storageKey: keyForDevice,
      onStage,
    })
    return createElement(
      Fragment,
      null,
      catalog.preview && editable ? createElement('button', { onClick: catalog.stageSelected }, '暂存') : null,
      catalog.stagePending ? createElement('button', { onClick: catalog.retryStage }, '重试同一请求') : null,
    )
  }
  const render = (editable: boolean, keyForDevice = storageKey) =>
    act(async () => root.render(createElement(Market, { editable, keyForDevice })))
  const button = (label: string) => [...element.querySelectorAll('button')].find(item => item.textContent === label)
  const click = (label: string) => act(async () => button(label)!.click())
  try {
    await render(true)
    await click('暂存')
    expect(sessionStorage.getItem(storageKey)).toBeNull()
    expect(button('重试同一请求')).toBeUndefined()
    await click('暂存')
    expect(writes[0]?.requestId).not.toBe(writes[1]?.requestId)
    const request = writes[1]
    expect(request).toMatchObject({ pluginId: id, revision })
    expect(sessionStorage.getItem(storageKey)).toBe(JSON.stringify(request))
    await act(async () => root.render(null))
    await render(false)
    expect(button('重试同一请求')).toBeUndefined()
    expect(sessionStorage.getItem(storageKey)).toBe(JSON.stringify(request))
    for (const unrelated of [keyFor('host-2', 'device-1'), keyFor('host-1', 'device-2')]) {
      await render(true, unrelated)
      expect(button('重试同一请求')).toBeUndefined()
      expect(writes).toHaveLength(2)
    }
    await render(true)
    await click('重试同一请求')
    expect(sessionStorage.getItem(storageKey)).toBe(JSON.stringify(request))
    expect(writes[2]).toEqual(request)
    await click('重试同一请求')
    expect(writes[3]).toEqual(request)
    expect(inFlight?.aborted).toBe(false)
    await render(true, keyFor('host-2', 'device-1'))
    expect(inFlight?.aborted).toBe(true)
    await act(async () => finish(Response.json({ error: 'renewal-required' }, { status: 401 })))
    expect(renew).not.toHaveBeenCalled()
    expect(writes).toHaveLength(4)
    expect(button('重试同一请求')).toBeUndefined()
    expect(sessionStorage.getItem(storageKey)).toBe(JSON.stringify(request))
    await render(true)
    await click('重试同一请求')
    expect(writes[4]).toEqual(request)
    expect(onStage).toHaveBeenCalledOnce()
    expect(sessionStorage.getItem(storageKey)).toBeNull()
  } finally {
    act(() => root.unmount())
    uninstallRenew()
    sessionStorage.removeItem(storageKey)
    vi.unstubAllGlobals()
  }
})
