import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPluginPackageTemplate, type PluginCatalogStage, type PluginNpmStage, type PluginPackageBundle } from '@latch/protocol'
import { PluginRegistry } from '@latch/core'
import { AppError, type HarnessPlugin } from '@latch/sdk'
import {
  PluginAssets,
  describePluginAsset,
  installIdOf,
  pluginApplyPayload,
  pluginTrustRequestId,
  type PluginAssetActor,
} from '../src/plugin-assets.ts'
import { checkedPluginBundle } from '../src/plugin-package-bundle.ts'
import { catalogUpdate } from '../src/plugin-catalog.ts'
import { pluginReviewSource, reviewPluginPackage } from '../src/plugin-package-review.ts'
import { loadPluginPackage } from '../src/plugin-packages.ts'
import { cleanupPluginGenerations } from '../scripts/cleanup-plugin-generations.ts'
import { acquireDataDirLock } from '../src/host-state.ts'
import { agentPluginRevision } from '../src/agent-revisions.ts'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture(
  options: Parameters<typeof PluginAssets.open>[1] = { audit: { append: async () => ({ seq: 1, hash: 'a'.repeat(64) }) } },
) {
  const path = await mkdtemp(join(tmpdir(), 'latch-assets-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  const store = await PluginAssets.open(path, options)
  cleanups.push(() => store.close())
  const actor: PluginAssetActor = { actor: { deviceId: 'dev_' + 'a'.repeat(22), listener: 'unix' }, authorize: () => {} }
  return { path, store, actor }
}
const rid = () => randomUUID()
it('updates only the same unmodified bundled release at a newer SemVer and stages without reapplying', async () => {
  const { store, actor } = await fixture()
  const id = 'catalog-example'
  const candidate = (version: string, text: string) => {
    const bundle = createPluginPackageTemplate('skill', id)
    bundle.manifest.version = version
    bundle.files[0]!.content = text
    return checkedPluginBundle(bundle)
  }
  const one = candidate('1.9.0', 'First'),
    two = candidate('1.10.0', 'Second')
  await store.stageCatalog({ pluginId: id, revision: one.revision, requestId: rid() }, one, actor)
  await store.apply(id, one.revision, rid(), actor, async (_, commit) => commit())
  const installed = store.get(id)
  const old = describePluginAsset(installed)
  const update = { installId: installIdOf(installed), baseRevision: one.revision }
  expect(catalogUpdate(candidate('1.9.0+rebuilt', 'changed'), old)).toBe('same-version-changed')
  expect(catalogUpdate(candidate('1.8.0', 'earlier'), old)).toBe('older')
  expect(catalogUpdate(two, old)).toBe('available')
  await expect(
    store.stageCatalog(
      { pluginId: id, revision: two.revision, requestId: rid(), update: { ...update, baseRevision: '1'.repeat(64) } },
      two,
      actor,
    ),
  ).rejects.toMatchObject({ code: 'plugin-package-changed' })

  const request = { pluginId: id, revision: two.revision, requestId: rid(), update }
  await store.stageCatalog(request, two, actor)
  expect((await store.replayCatalog(request, actor))?.replay).toBe(true)
  const saved = store.get(id)
  expect(saved).toMatchObject({
    revision: two.revision,
    appliedRevision: one.revision,
    enabled: true,
    catalog: { version: '1.10.0', revision: two.revision },
  })
  expect(pluginReviewSource(saved, one.revision)).toEqual({ kind: 'catalog', version: '1.9.0' })

  const edited = candidate('1.10.0', 'Local edit')
  await store.save(edited.bundle, rid(), actor, two.revision)
  const three = candidate('2.0.0', 'Third')
  await expect(
    store.stageCatalog(
      {
        pluginId: id,
        revision: three.revision,
        requestId: rid(),
        update: { installId: installIdOf(saved), baseRevision: edited.revision },
      },
      three,
      actor,
    ),
  ).rejects.toMatchObject({ code: 'plugin-catalog-local-changes' })
  expect(store.get(id).bundle.files).toEqual(edited.bundle.files)
})

it('shows real app grants and broader capabilities alongside Code and Host warnings even when code was already approved', () => {
  const bundle = createPluginPackageTemplate('tool', 'review-risk')
  bundle.manifest.formatVersion = 2
  bundle.manifest.panels = [{ id: 'panel', title: 'Panel', entry: 'panel.mjs', context: true }]
  bundle.manifest.apps = [
    {
      id: 'actions',
      title: 'Actions',
      entry: 'actions.js',
      dataVersion: 1,
      capabilities: {
        'tasks.start': { projects: ['a'] },
        storage: ['plugin'],
      },
    },
  ]
  bundle.files.push({ path: 'actions.js', content: '' }, { path: 'panel.mjs', content: '' })
  const earlier = checkedPluginBundle(bundle)
  const updated = structuredClone(bundle)
  updated.manifest.apps![0]!.capabilities = {
    'tasks.start': { projects: ['a', 'b'] },
    'tasks.continue': true,
    'tasks.readOwn': true,
    storage: ['plugin', 'project'],
  }
  const candidate = checkedPluginBundle(updated)
  const result = reviewPluginPackage(
    candidate,
    { kind: 'local' },
    {
      appliedBundle: earlier.bundle,
      appliedRevision: earlier.revision,
      approvedApps: { actions: bundle.manifest.apps![0]!.capabilities },
      trusted: [earlier.executionHash!],
    },
    true,
  )
  expect(result).toMatchObject({
    baseAppliedRevision: earlier.revision,
    comparison: { changedExecution: false, expandedPageCapabilities: true, manifestChanged: true, changedFiles: [] },
    pages: [
      {
        id: 'actions',
        approved: bundle.manifest.apps![0]!.capabilities,
        addedCapabilities: {
          'tasks.start': { projects: ['b'] },
          'tasks.continue': true,
          'tasks.readOwn': true,
          storage: ['project'],
        },
      },
    ],
    adoptsData: true,
    confirmationRequired: true,
  })
  expect(result.findings.map(item => item.kind)).toEqual(
    expect.arrayContaining([
      'host-access',
      'workbench-access',
      'context-statistics',
      'tool-registration',
      'starts-sessions',
      'continues-sessions',
      'reads-own-replies',
      'writes-storage',
    ]),
  )
})

describe('editable local plugin assets', () => {
  it('cleans only owned orphan source generations at the locked startup boundary and preserves durable assets', async () => {
    const { store, actor, path } = await fixture(),
      bundle = createPluginPackageTemplate('skill', 'orphan-guide')
    await store.save(bundle, rid(), actor)
    const record = store.get('orphan-guide'),
      source = await store.materialize(record),
      parent = join(store.directory, 'generations')
    await mkdir(join(parent, 'owner-notes'), { mode: 0o700 })
    const similar = '.' + randomUUID() + '\n'
    await mkdir(join(parent, similar), { mode: 0o700 })
    await writeFile(join(parent, 'owner-notes', 'keep.txt'), 'owner data')
    await symlink(join(parent, 'owner-notes'), join(parent, '.' + randomUUID()))
    expect(await readFile(join(source.path, 'SKILL.md'), 'utf8')).toBe(bundle.files[0]!.content)
    const lock = await acquireDataDirLock(path, 'host')
    try {
      expect(await cleanupPluginGenerations(path)).toBe(2)
    } finally {
      await lock.release()
    }
    expect((await readdir(parent)).toSorted()).toEqual([similar, 'owner-notes'].toSorted())
    expect(await readFile(join(parent, 'owner-notes', 'keep.txt'), 'utf8')).toBe('owner data')
    expect(store.get(record.id).revision).toBe(record.revision)
    const next = await store.materialize(record)
    cleanups.push(next.release)
    expect(await readFile(join(next.path, 'SKILL.md'), 'utf8')).toBe(bundle.files[0]!.content)
  })
  it('refuses a linked source directory instead of traversing outside private storage during cleanup', async () => {
    const { store, path } = await fixture(),
      outside = await mkdtemp(join(tmpdir(), 'latch-orphan-outside-'))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    await writeFile(join(outside, 'keep.txt'), 'never remove')
    await symlink(outside, join(store.directory, 'generations'))
    const lock = await acquireDataDirLock(path, 'host')
    try {
      await expect(cleanupPluginGenerations(path)).rejects.toMatchObject({ code: 'plugin-package-private' })
    } finally {
      await lock.release()
    }
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('never remove')
  })
  it('provides ready skill/data, tool and React templates and never executes a saved draft', async () => {
    const { store, actor } = await fixture()
    for (const kind of ['skill', 'tool', 'react-ui'] as const) {
      const bundle = createPluginPackageTemplate(kind, kind),
        checked = checkedPluginBundle(bundle)
      expect(!!checked.executionHash).toBe(kind !== 'skill')
      await store.save(bundle, rid(), actor)
      expect(store.get(kind)).toMatchObject({ enabled: false, revision: checked.revision })
    }
    const registry = new PluginRegistry()
    cleanups.push(() => registry.close())
    const record = store.get('skill'),
      generation = await store.materialize(record)
    cleanups.push(generation.release)
    const plugin = await loadPluginPackage(generation.path)
    registry.register(plugin)
    await registry.enable(plugin.id)
    expect(registry.skills()).toMatchObject([{ id: 'skill:guide' }])
    const panel = registry.acquireUiPanel('skill:overview')
    expect(
      await panel.render({
        session: { harnessId: 'standard', id: 's', title: '', status: 'idle', updatedAt: '' },
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ blocks: [{ type: 'text' }] })
    panel.release()
  })
  it('keeps source/application trust stable for ordinary skill edits and display names, but binds executable source and configuration', () => {
    const bundle: PluginPackageBundle = { ...createPluginPackageTemplate('tool', 'mixed') }
    bundle.manifest.skills = [{ id: 'guide', name: 'guide', description: '', file: 'SKILL.md' }]
    bundle.files.push({ path: 'SKILL.md', content: 'first' })
    const original = checkedPluginBundle(bundle)
    const text = structuredClone(bundle)
    text.files[1]!.content = 'second'
    text.manifest.name = 'renamed'
    expect(checkedPluginBundle(text).revision).not.toBe(original.revision)
    expect(checkedPluginBundle(text).executionHash).toBe(original.executionHash)
    text.files[0]!.content += '\n// new code'
    expect(checkedPluginBundle(text).executionHash).not.toBe(original.executionHash)
    const config = structuredClone(bundle)
    config.manifest.config = { command: 'different' }
    expect(checkedPluginBundle(config).executionHash).not.toBe(original.executionHash)
  })
  it('rejects malformed, escaping, duplicate and over-budget assets before an import can occur', () => {
    const bundle = createPluginPackageTemplate('skill')
    for (const path of ['../secret', '/absolute', 'a//b', 'a/./b', 'C:/file', 'a\\b', 'latch-plugin.json'])
      expect(() => checkedPluginBundle({ ...bundle, files: [...bundle.files, { path, content: 'never imported' }] })).toThrow()
    expect(() => checkedPluginBundle({ ...bundle, files: [...bundle.files, { path: 'skill.md', content: '' }] })).toThrow()
    expect(() => checkedPluginBundle({ ...bundle, files: [{ path: 'SKILL.md', content: 'x'.repeat(32001) }] })).toThrow()
    expect(() => checkedPluginBundle({ ...bundle, files: [...bundle.files, { path: 'large', content: 'x'.repeat(1000001) }] })).toThrow()
    expect(() =>
      checkedPluginBundle({ ...bundle, files: [...bundle.files, { path: 'a', content: '' }, { path: 'a/b', content: '' }] }),
    ).toThrow()
    const duplicate = structuredClone(bundle)
    duplicate.manifest.dataPanels!.push(duplicate.manifest.dataPanels![0]!)
    expect(() => checkedPluginBundle(duplicate)).toThrow()
  })
  it('confirms a newly declared Context projection and restores it on client modules only', async () => {
    const { store, actor } = await fixture()
    const bundle = createPluginPackageTemplate('react-ui', 'context-fixture')
    const ordinary = checkedPluginBundle(bundle)
    const originalAgentRevision = agentPluginRevision(ordinary.bundle)
    bundle.manifest.panels![0]!.context = true
    const context = checkedPluginBundle(bundle)
    expect(context.executionHash).not.toBe(ordinary.executionHash)
    expect(agentPluginRevision(context.bundle)).not.toBe(originalAgentRevision)
    expect(checkedPluginBundle(context.bundle)).toEqual(context)
    expect(() =>
      checkedPluginBundle({
        ...bundle,
        manifest: {
          ...bundle.manifest,
          panels: [],
          dataPanels: [{ id: 'data', title: 'Data', context: true, document: { blocks: [] } }],
        },
      }),
    ).toThrow()
    await store.save(ordinary.bundle, rid(), actor)
    await store.trust(bundle.manifest.id, ordinary.executionHash!, pluginTrustRequestId(rid()), actor)
    await store.save(context.bundle, rid(), actor, ordinary.revision)
    await expect(store.apply(bundle.manifest.id, context.revision, rid(), actor, async () => {})).rejects.toMatchObject({
      code: 'plugin-package-untrusted',
    })
    await store.trust(bundle.manifest.id, context.executionHash!, pluginTrustRequestId(rid()), actor)
    const generation = await store.materialize(store.get(bundle.manifest.id))
    cleanups.push(generation.release)
    const registry = new PluginRegistry()
    cleanups.push(() => registry.close())
    const plugin = await loadPluginPackage(generation.path)
    registry.register(plugin)
    await registry.enable(plugin.id)
    expect(registry.uiPanels()).toMatchObject([{ context: true }])
    expect(registry.list().find(item => item.id === plugin.id)?.capabilities).toContain('ui-context:' + bundle.manifest.panels![0]!.id)
    await registry.disable(plugin.id)
    expect(registry.uiPanels()).toEqual([])
  })
  it('separates drafts and application snapshots, enforces revision conflicts and binds mutation receipts to their device and payload', async () => {
    const { store, actor } = await fixture(),
      bundle = createPluginPackageTemplate('skill'),
      requestId = rid()
    await store.save(bundle, requestId, actor)
    expect((await store.save(bundle, requestId, actor)).replay).toBe(true)
    const original = store.get(bundle.manifest.id)
    const changed = structuredClone(bundle)
    changed.files[0]!.content = 'updated'
    await expect(store.save(changed, requestId, actor)).rejects.toMatchObject({ code: 'request-conflict' })
    await expect(store.save(changed, rid(), actor, 'a'.repeat(64))).rejects.toMatchObject({ code: 'plugin-package-changed' })
    await store.apply(original.id, original.revision, rid(), actor, async (_state, commit) => commit())
    await store.save(changed, rid(), actor, original.revision)
    expect(store.get(original.id).bundle.files[0]!.content).toBe('updated')
    expect(store.get(original.id).appliedBundle!.files[0]!.content).toBe(bundle.files[0]!.content)
  })
  it('requires an approved executable digest before activating a real module, and preserves it across a restart', async () => {
    const { store, path, actor } = await fixture(),
      bundle = createPluginPackageTemplate('tool', 'upper')
    await store.save(bundle, rid(), actor)
    const record = store.get('upper')
    await expect(store.apply('upper', record.revision, rid(), actor, async () => {})).rejects.toMatchObject({
      code: 'plugin-package-untrusted',
    })
    await store.trust('upper', record.executionHash!, pluginTrustRequestId(rid()), actor)
    const registry = new PluginRegistry()
    cleanups.push(() => registry.close())
    const applyId = rid(),
      activate = vi.fn(async (state: Parameters<Parameters<typeof store.apply>[4]>[0], commit: () => Promise<void>) => {
        const entry = state.packages.find(item => item.id === 'upper')!,
          generation = await store.materialize(entry)
        const plugin = await loadPluginPackage(generation.path)
        registry.register({
          ...plugin,
          async activate(context) {
            context.onDispose(generation.release)
            await plugin.activate(context)
          },
        })
        await registry.enable(plugin.id)
        await commit()
      })
    await store.apply('upper', record.revision, applyId, actor, activate)
    expect(activate).toHaveBeenCalledTimes(1)
    await store.apply('upper', record.revision, applyId, actor, activate)
    expect(activate).toHaveBeenCalledTimes(1)
    const reopened = await PluginAssets.open(path, { audit: { append: async () => ({ seq: 1, hash: 'a'.repeat(64) }) } })
    cleanups.push(() => reopened.close())
    expect(reopened.get('upper')).toMatchObject({ enabled: true, appliedRevision: record.revision, trusted: [record.executionHash] })
  })
  it('rechecks authorization after audit and allows deletion despite audit failure', async () => {
    let denied = false,
      fail = false
    const audit = vi.fn(async () => {
      if (fail) throw new Error('audit failed')
      return { seq: 1, hash: 'a'.repeat(64) }
    })
    const { store, actor } = await fixture({ audit: { append: audit } }),
      bundle = createPluginPackageTemplate('skill')
    actor.authorize = () => {
      if (denied) throw new AppError(403, 'revoked', 'revoked')
    }
    await store.save(bundle, rid(), actor)
    fail = true
    const removed = await store.remove(bundle.manifest.id, store.get(bundle.manifest.id).revision, rid(), actor, async (_state, commit) =>
      commit(),
    )
    expect(removed.audited).toBe(false)
    expect(store.list()).toEqual([])
    fail = false
    audit.mockImplementationOnce(async () => {
      denied = true
      return { seq: 1, hash: 'a'.repeat(64) }
    })
    await expect(store.save(bundle, rid(), actor)).rejects.toMatchObject({ code: 'revoked' })
    expect(store.list()).toEqual([])
    expect(JSON.stringify(audit.mock.calls)).not.toContain('工作方法')
  })
  it('settles an uncertain import using the first snapshot, bound to its device, session and kind, including after restart', async () => {
    let interrupt = true
    const options = {
      audit: { append: vi.fn(async () => ({ seq: 1, hash: 'a'.repeat(64) })) },
      atomicFs: {
        open: (...args: Parameters<typeof open>) => open(...args),
        rename: async (from: string, to: string) => {
          await rename(from, to)
          if (interrupt) {
            interrupt = false
            throw new Error('directory sync unknown')
          }
        },
      },
    }
    const { store, actor, path } = await fixture(options)
    const first = createPluginPackageTemplate('skill', 'receipt-draft')
    const request = rid(),
      session = 'creator-session',
      revision = checkedPluginBundle(first).revision
    await expect(store.importDraft(first, session, request, actor, 'plugin')).rejects.toMatchObject({
      code: 'plugin-package-write-unknown',
    })
    await expect(store.replayImport('another-session', 'plugin', request, actor)).rejects.toMatchObject({ code: 'request-conflict' })
    await expect(store.replayImport(session, 'app', request, actor)).rejects.toMatchObject({ code: 'request-conflict' })
    const other = { ...actor, actor: { ...actor.actor, deviceId: 'dev_' + 'b'.repeat(22) } }
    await expect(store.replayImport(session, 'plugin', request, other)).rejects.toMatchObject({ code: 'plugin-package-write-unknown' })
    first.files[0]!.content = 'the Agent revised the source'
    const settled = await store.replayImport(session, 'plugin', request, actor)
    expect(settled).toMatchObject({ replay: true, importedRevision: revision, record: { revision } })
    expect(settled?.record?.bundle.files[0]?.content).not.toBe(first.files[0]?.content)
    expect(options.audit.append).toHaveBeenCalledTimes(1)
    expect(await store.replayImport(session, 'plugin', request, other)).toBeUndefined()
    const next = (await store.importDraft(first, session, rid(), actor, 'plugin')).record!
    const reopened = await PluginAssets.open(path, options)
    cleanups.push(() => reopened.close())
    expect(await reopened.replayImport(session, 'plugin', request, actor)).toMatchObject({
      replay: true,
      importedRevision: revision,
      record: { revision: next.revision },
    })
    await reopened.remove(next.id, next.revision, rid(), actor, async (_state, commit) => commit())
    await reopened.importDraft(first, session, rid(), actor, 'plugin')
    await expect(reopened.replayImport(session, 'plugin', request, actor)).rejects.toMatchObject({ status: 410 })
  })
  it.each(['npm', 'catalog'] as const)('recovers an uncertain %s stage from its exact device and intent', async source => {
    let interrupt = true
    const options = {
      audit: { append: vi.fn(async () => ({ seq: 1, hash: 'a'.repeat(64) })) },
      atomicFs: {
        open: (...args: Parameters<typeof open>) => open(...args),
        rename: async (from: string, to: string) => {
          await rename(from, to)
          if (interrupt) {
            interrupt = false
            throw new Error('directory sync unknown')
          }
        },
      },
    }
    const { store, actor, path } = await fixture(options)
    const bundle = createPluginPackageTemplate('skill', 'staged-receipt')
    const downloaded = checkedPluginBundle(bundle)
    const input: PluginCatalogStage = { requestId: rid(), revision: downloaded.revision, pluginId: bundle.manifest.id }
    const release: PluginNpmStage['release'] = {
      registry: 'https://registry.example.test/',
      name: 'npm-receipt',
      version: bundle.manifest.version,
      integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
    }
    const stage = (assets: PluginAssets, requestId: string) =>
      source === 'npm'
        ? assets.stageNpm({ requestId, revision: input.revision, release }, downloaded, actor)
        : assets.stageCatalog({ ...input, requestId }, downloaded, actor)
    const replay = (assets: PluginAssets, device = actor, revision = input.revision) =>
      source === 'npm'
        ? assets.replayNpm({ requestId: input.requestId, revision, release }, device)
        : assets.replayCatalog({ ...input, revision }, device)
    await expect(stage(store, input.requestId)).rejects.toMatchObject({ code: 'plugin-package-write-unknown' })
    const other = { ...actor, actor: { ...actor.actor, deviceId: 'dev_' + 'b'.repeat(22) } }
    await expect(replay(store, other)).rejects.toMatchObject({ code: 'plugin-package-write-unknown' })
    await expect(replay(store, actor, 'a'.repeat(64))).rejects.toMatchObject({ code: 'request-conflict' })
    expect(await replay(store)).toMatchObject({ replay: true, record: { enabled: false, revision: downloaded.revision } })
    expect(options.audit.append).toHaveBeenCalledTimes(1)
    const restarted = await PluginAssets.open(path, options)
    cleanups.push(() => restarted.close())
    expect(await replay(restarted)).toMatchObject({
      replay: true,
      record: source === 'npm' ? { npm: release } : { catalog: { version: release.version, revision: input.revision } },
    })
    await restarted.remove(bundle.manifest.id, downloaded.revision, rid(), actor, async (_state, commit) => commit())
    await stage(restarted, rid())
    await expect(replay(restarted)).rejects.toMatchObject({ code: 'plugin-package-removed' })
    expect(restarted.list()).toHaveLength(1)
  })

  it('keeps approved data adoption on the original receipt and never carries it to a replacement installation', async () => {
    let interrupt = false
    const { store, actor, path } = await fixture({
      audit: { append: async () => ({ seq: 1, hash: 'a'.repeat(64) }) },
      atomicFs: {
        open: (...args: Parameters<typeof open>) => open(...args),
        rename: async (from, to) => {
          await rename(from, to)
          if (interrupt) {
            interrupt = false
            throw new Error('directory sync unknown')
          }
        },
      },
    })
    const id = 'data-adoption'
    const bundle: PluginPackageBundle = {
      manifest: {
        formatVersion: 2,
        id,
        name: 'Data',
        version: '1.0.0',
        description: '',
        apps: [
          {
            id: 'view',
            title: 'Data',
            entry: 'view.js',
            dataVersion: 1,
            capabilities: { storage: ['plugin'] },
          },
        ],
      },
      files: [{ path: 'view.js', content: '' }],
    }
    const { revision } = checkedPluginBundle(bundle)
    const approve = { view: bundle.manifest.apps![0]!.capabilities }
    await store.save(bundle, rid(), actor)
    const request = rid()
    const commit = async (_state: unknown, publish: () => Promise<void>) => publish()
    interrupt = true
    await expect(store.apply(id, revision, request, actor, commit, approve, { baseAppliedRevision: null }, true)).rejects.toMatchObject({
      code: 'plugin-package-write-unknown',
    })
    expect(store.pendingAdoption(id, revision, request, actor)).toBe(true)
    expect(store.pendingAdoption(id, revision, rid(), actor)).toBe(false)
    const applied = await store.apply(id, revision, request, actor, commit, approve, { baseAppliedRevision: null }, true)
    expect(applied.adoptOwner).toBe(installIdOf(applied.record!))

    const restarted = await PluginAssets.open(path, { audit: { append: async () => ({ seq: 1, hash: 'a'.repeat(64) }) } })
    cleanups.push(() => restarted.close())
    const replay = () => restarted.replay(id, 'apply', request, pluginApplyPayload(revision, { baseAppliedRevision: null }), actor)
    expect(replay()).toMatchObject({ adoptOwner: applied.adoptOwner, replay: true })
    await restarted.remove(id, revision, rid(), actor, commit)
    await restarted.save(bundle, rid(), actor)
    await restarted.apply(id, revision, rid(), actor, commit, approve)
    expect(replay()?.adoptOwner).toBeUndefined()
  })

  it('matches receipts from before imports kept their captured revision by the historical intent hash', async () => {
    const { store, path, actor } = await fixture()
    const sample = createPluginPackageTemplate('skill', 'older-import')
    const request = rid()
    const imported = await store.importDraft(sample, 'old-session', request, actor)
    const file = join(store.directory, 'assets.json')
    const data = JSON.parse(await readFile(file, 'utf8')) as { receipts: Record<string, { imported?: unknown }> }
    for (const receipt of Object.values(data.receipts)) delete receipt.imported
    await writeFile(file, JSON.stringify(data))
    const reopened = await PluginAssets.open(path, { audit: { append: async () => ({ seq: 1, hash: 'a'.repeat(64) }) } })
    cleanups.push(() => reopened.close())
    expect(await reopened.replayImport('old-session', 'app', request, actor)).toMatchObject({
      replay: true,
      importedRevision: imported.record?.revision,
    })
    expect(await reopened.replayImport('other-session', 'app', request, actor)).toBeUndefined()
  })

  it('keeps uncertain atomic writes bound to the original request and re-runs an application effect before acknowledging it', async () => {
    let afterRename = false
    const { store, actor } = await fixture({
      audit: { append: async () => ({ seq: 1, hash: 'a'.repeat(64) }) },
      atomicFs: {
        open: (...args) => open(...args),
        rename: async (from, to) => {
          await rename(from, to)
          if (afterRename) {
            afterRename = false
            throw new Error('after rename')
          }
        },
      },
    })
    const bundle = createPluginPackageTemplate('skill'),
      created = await store.save(bundle, rid(), actor),
      record = created.record!
    const applyId = rid(),
      effect = vi.fn(async (_state: Parameters<Parameters<typeof store.apply>[4]>[0], commit: () => Promise<void>) => commit())
    afterRename = true
    await expect(store.apply(record.id, record.revision, applyId, actor, effect)).rejects.toMatchObject({
      code: 'plugin-package-write-unknown',
    })
    expect(() => store.list()).toThrow()
    await expect(store.save({ ...bundle, manifest: { ...bundle.manifest, id: 'another' } }, rid(), actor)).rejects.toMatchObject({
      code: 'plugin-package-write-unknown',
    })
    expect(store.candidate(record.id, record.revision, applyId, actor).appliedRevision).toBe(record.revision)
    await store.apply(record.id, record.revision, applyId, actor, effect)
    expect(effect).toHaveBeenCalledTimes(2)
    expect(store.get(record.id).enabled).toBe(true)
  })
  it('retires contributions immediately while old run leases finish and disposal still waits for actual release', async () => {
    const disposed = vi.fn(),
      registry = new PluginRegistry()
    cleanups.push(() => registry.close())
    const plugin: HarnessPlugin = {
      id: 'retired',
      name: 'retired',
      version: '1',
      description: '',
      activate(context) {
        context.registerProvider({
          id: 'fixture',
          name: 'fixture',
          model: 'fixture',
          async *stream() {
            yield { type: 'finish', reason: 'stop' }
          },
        })
        context.onDispose(disposed)
      },
    }
    registry.register(plugin, { revision: 'a'.repeat(64) })
    await registry.enable(plugin.id)
    const lease = registry.acquire('fixture')
    registry.retire(plugin.id)
    expect(() => registry.acquire('fixture')).toThrow()
    expect(disposed).not.toHaveBeenCalled()
    expect(lease.provider.model).toBe('fixture')
    lease.release()
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledTimes(1))
    await registry.enable(plugin.id)
    const resumed = registry.acquire('fixture')
    expect(resumed.provider.id).toBe('fixture')
    expect(registry.revisionSnapshot([plugin.id])).toEqual({ persistent: true, revisions: { [plugin.id]: 'a'.repeat(64) } })
    resumed.release()
  })
})
