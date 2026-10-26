import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPluginPackageTemplate, type PluginPackageBundle } from '@latch/protocol'
import { PluginRegistry } from '@latch/core'
import { AppError, type HarnessPlugin } from '@latch/sdk'
import { PluginAssets, pluginTrustRequestId, type PluginAssetActor } from '../src/plugin-assets.ts'
import { checkedPluginBundle } from '../src/plugin-package-bundle.ts'
import { loadPluginPackage } from '../src/plugin-packages.ts'
import { cleanupPluginGenerations } from '../scripts/cleanup-plugin-generations.ts'
import { acquireDataDirLock } from '../src/host-state.ts'
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
      await panel.render({ session: { id: 's', title: '', status: 'idle', updatedAt: '' }, signal: new AbortController().signal }),
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
