import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { AppManifestEntry, PluginPackageBundle, PluginPackageDetail, PluginPackageSummary } from '@latch/protocol'
import { AppError, type HarnessPlugin } from '@latch/sdk'
import type { PluginRegistry } from '@latch/core'
import { json, jsonBody, safeDecode } from './http-util.ts'
import {
  PluginAssets,
  pluginTrustRequestId,
  type PluginAssetActor,
  type PluginAssetRecord,
  type PluginAssetMutation,
  type PluginAssetDescriptor,
  type PluginAssetEffect,
  describePluginAsset,
  installIdOf,
} from './plugin-assets.ts'
import { PLUGIN_PACKAGE_BYTES, checkedPluginBundle } from './plugin-package-bundle.ts'
import { loadPluginPackage } from './plugin-packages.ts'
import { capabilitySet, capabilitySetHash, withinApproved } from './app-capabilities.ts'

const requestId = z.string().min(8).max(128),
  hash = z.string().regex(/^[a-f0-9]{64}$/u)
const createSchema = z.strictObject({ requestId, bundle: z.unknown() }),
  saveSchema = createSchema.extend({ baseRevision: hash })
const applySchema = z.strictObject({ requestId, revision: hash }),
  deleteSchema = z.strictObject({ requestId, baseRevision: hash, deleteData: z.boolean().optional() }),
  enabledSchema = z.strictObject({ requestId, enabled: z.boolean() })
export interface PluginApplyConfirmation {
  id: string
  name: string
  revision: string
  /** Present when the package's Host or React code is not yet trusted. */
  executionHash?: string
  hostModules: number
  clientPanels: number
  /** Present when the pages ask for more than this computer approved: every page with all its capabilities. */
  apps?: AppManifestEntry[]
  capabilitiesHash?: string
  /** The plugin takes over page data that a deleted plugin with this ID kept. */
  adoptsData?: true
}
/** How an apply or rollback with pages came to be trusted; recorded before it takes effect. */
export interface PluginAppTrust {
  id: string
  revision: string
  capabilitiesHash: string
  operation: 'apply' | 'rollback'
  trust: 'confirmed' | 'capabilities-approved'
}
interface Options<Caller> {
  assets: PluginAssets
  registry: PluginRegistry
  installedIds?: Set<string>
  authorize(caller: Caller): PluginAssetActor
  confirm(req: IncomingMessage, caller: Caller, input: PluginApplyConfirmation): Promise<void>
  /** Audits a page trust decision; a failure refuses the apply. */
  appTrust?(caller: Caller, input: PluginAppTrust): Promise<void>
  /** After a plugin is deleted: removes its page data when its owner asked for it (`remove`), or only lets go of it. */
  removeData?(caller: Caller, id: string, remove: boolean): Promise<{ audited: boolean }>
  /** Whose page data the plugin's directory holds: none, this record's, or a deleted record's kept data. */
  dataClaim?(plugin: { id: string; owner: string }): Promise<'none' | 'own' | 'other'>
  /** Hands kept data to this record, once a confirmation said so. */
  adoptData?(plugin: { id: string; owner: string }): Promise<void>
  serial<T>(actor: PluginAssetActor, operation: () => Promise<T>): Promise<T>
  unmount(id: string): Promise<void>
  mount(id: string): Promise<void>
  changed(): void
  unavailableReason?(id: string): string | undefined
  /** Plugin packages a new version held off on its first start (update-window.ts); turning one on or removing it releases it. */
  held?: { isHeld(id: string): boolean; release(id: string): Promise<void> }
}

/** Constructing the object is inert. Only activate imports the approved immutable source; disposal removes that generation. */
export function installedAssetPlugin(assets: PluginAssets, record: PluginAssetRecord): HarnessPlugin {
  const bundle = record.appliedBundle
  if (!bundle) throw new AppError(409, 'plugin-package-not-applied', '请先应用这个插件。')
  return {
    id: record.id,
    name: bundle.manifest.name,
    version: bundle.manifest.version,
    description: bundle.manifest.description,
    package: { formatVersion: 1 },
    async activate(context) {
      const generation = await assets.materialize(record)
      context.onDispose(generation.release)
      const plugin = await loadPluginPackage(generation.path)
      await plugin.activate(context)
    },
  }
}

export function createPluginPackageRoutes<Caller>(options: Options<Caller>) {
  const { assets, registry } = options
  const installedIds = options.installedIds ?? new Set<string>()
  const namespace = (id: string) => {
    if (!installedIds.has(id) && registry.list().some(plugin => plugin.id === id))
      throw new AppError(409, 'plugin-package-id-in-use', '这个标识已由启动参数或内置插件占用，请换一个插件标识。')
  }
  function summary(record: PluginAssetDescriptor): PluginPackageSummary {
    const info = installedIds.has(record.id) ? registry.list().find(plugin => plugin.id === record.id) : undefined
    const unavailableReason = options.held?.isHeld(record.id)
      ? '这个插件与更新后的 Latch 不兼容，已停用；资产仍保留，更新插件后可重新启用。'
      : record.enabled && info?.enabled !== true
        ? '插件尚未成功启用，请检查声明、标识和本地依赖。'
        : installedIds.has(record.id)
          ? options.unavailableReason?.(record.id)
          : undefined
    return {
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.description,
      revision: record.revision,
      ...(record.appliedRevision ? { appliedRevision: record.appliedRevision } : {}),
      ...(record.executionHash ? { executionHash: record.executionHash } : {}),
      enabled: record.enabled && info?.enabled === true,
      trusted: record.executionHash === undefined || record.trusted.includes(record.executionHash),
      capabilities: info?.capabilities ?? [],
      ...(unavailableReason ? { unavailableReason } : {}),
      state: !record.appliedRevision ? 'draft' : record.revision === record.appliedRevision ? 'applied' : 'update-available',
      ...(record.rollbackRevisions.length ? { rollbackRevisions: record.rollbackRevisions } : {}),
    }
  }
  const detail = (record: PluginAssetRecord): PluginPackageDetail => ({
    ...summary(describePluginAsset(record)),
    bundle: structuredClone(record.bundle),
  })
  /**
   * Pages ask for capabilities; trust binds that set, not the code, because a page's frame never holds the page's
   * authority. A first apply or a wider set takes the confirmation; Host or React code keeps its per-digest one.
   */
  async function trustFor(
    req: IncomingMessage,
    caller: Caller,
    id: string,
    revision: string,
    bundle: PluginPackageBundle,
    record: { id: string; installId?: string; trusted: string[]; approvedApps?: PluginAssetRecord['approvedApps'] },
    executionHash: string | undefined,
    operation: PluginAppTrust['operation'],
  ) {
    const apps = bundle.manifest.apps ?? [],
      set = capabilitySet(bundle.manifest),
      capabilitiesHash = capabilitySetHash(set)
    const untrusted = executionHash && !record.trusted.includes(executionHash) ? executionHash : undefined
    // Data a deleted plugin with this ID kept is taken over only with a confirmation that says so.
    const owner = { id, owner: installIdOf(record) }
    const adoptsData =
      apps.some(app => app.capabilities.storage) && (await options.dataClaim?.(owner)) === 'other' ? (true as const) : undefined
    const widens = apps.length > 0 && (!withinApproved(set, record.approvedApps) || adoptsData === true)
    if (untrusted || widens)
      await options.confirm(req, caller, {
        id,
        name: bundle.manifest.name,
        revision,
        ...(untrusted ? { executionHash: untrusted } : {}),
        hostModules: bundle.manifest.host?.length ?? 0,
        clientPanels: bundle.manifest.panels?.length ?? 0,
        ...(widens ? { apps, capabilitiesHash } : {}),
        ...(adoptsData ? { adoptsData } : {}),
      })
    if (apps.length)
      await options.appTrust?.(caller, { id, revision, capabilitiesHash, operation, trust: widens ? 'confirmed' : 'capabilities-approved' })
    return {
      approve: widens ? set : undefined,
      capabilitiesHash,
      adopt: adoptsData ? async () => options.adoptData?.(owner) : async () => {},
    }
  }
  /** Swaps the registered package for the snapshot `state` holds; a failure leaves the previous one mounted. */
  const activate =
    (id: string, actor: PluginAssetActor): PluginAssetEffect =>
    async (state, commit) => {
      await options.unmount(id)
      actor.authorize()
      try {
        await registry.replace(
          installedAssetPlugin(
            assets,
            state.packages.find(record => record.id === id)!,
          ),
          async () => {
            actor.authorize()
            await commit()
          },
          { revision: state.packages.find(record => record.id === id)!.appliedRevision },
        )
        installedIds.add(id)
      } catch (cause) {
        await options.mount(id)
        if (cause instanceof AppError) throw cause
        throw new AppError(502, 'plugin-package-activation-failed', '插件未能应用，旧版和草稿已保留。请检查模块声明与本地依赖。')
      }
      await options.mount(id)
    }
  let active = 0
  const activeDevices = new Map<string, number>()
  return {
    async handle(req: IncomingMessage, res: ServerResponse, caller: Caller, path: string, method: string): Promise<boolean> {
      if (path !== '/link/api/plugin-packages' && !path.startsWith('/link/api/plugin-packages/')) return false
      const actor = options.authorize(caller)
      const deviceId = actor.actor.deviceId,
        count = activeDevices.get(deviceId) ?? 0
      if (active >= 4 || count >= 2) throw new AppError(429, 'plugin-package-busy', '同时处理的插件请求过多，请稍后再试。')
      active++
      activeDevices.set(deviceId, count + 1)
      try {
        const reply = (result: PluginAssetMutation, status = 200) => {
          actor.authorize()
          if (!result.audited) res.setHeader('x-latch-audit', 'failed')
          options.changed()
          json(res, result.record ? { package: detail(result.record) } : { removed: true }, status)
        }
        if (path === '/link/api/plugin-packages') {
          if (method === 'GET') {
            const packages = assets.descriptors().map(summary)
            actor.authorize()
            json(res, { packages })
            return true
          }
          if (method === 'POST') {
            const input = createSchema.parse(await jsonBody(req, PLUGIN_PACKAGE_BYTES + 65536))
            actor.authorize()
            await options.serial(actor, async () => {
              namespace(checkedPluginBundle(input.bundle).bundle.manifest.id)
              const result = await assets.save(input.bundle, input.requestId, actor)
              reply(result, 201)
            })
            return true
          }
          throw new AppError(404, 'not-found', '接口不存在。')
        }
        const match = /^\/link\/api\/plugin-packages\/([^/]+)(?:\/(apply|export|enabled|rollback))?$/u.exec(path)
        if (!match) throw new AppError(404, 'not-found', '接口不存在。')
        const id = safeDecode(match[1]!),
          action = match[2]
        if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id)) throw new AppError(400, 'plugin-package-id', '插件标识无效。')
        if (method === 'GET' && action === undefined) {
          const record = assets.get(id)
          actor.authorize()
          json(res, { package: detail(record) })
          return true
        }
        if (method === 'GET' && action === 'export') {
          const record = assets.get(id)
          actor.authorize()
          res.setHeader('content-disposition', `attachment; filename="${id}.latch-plugin.json"`)
          json(res, { bundle: record.bundle })
          return true
        }
        if (method === 'PUT' && action === undefined) {
          const input = saveSchema.parse(await jsonBody(req, PLUGIN_PACKAGE_BYTES + 65536))
          actor.authorize()
          if (
            typeof input.bundle !== 'object'
            || !input.bundle
            || !('manifest' in input.bundle)
            || typeof input.bundle.manifest !== 'object'
            || !input.bundle.manifest
            || !('id' in input.bundle.manifest)
            || input.bundle.manifest.id !== id
          )
            throw new AppError(400, 'plugin-package-id', '插件标识与编辑目标不一致。')
          await options.serial(actor, async () => reply(await assets.save(input.bundle, input.requestId, actor, input.baseRevision)))
          return true
        }
        if (method === 'POST' && action === 'apply') {
          const input = applySchema.parse(await jsonBody(req))
          actor.authorize()
          const replay = assets.replay(id, 'apply', input.requestId, { revision: input.revision }, actor)
          if (replay) {
            reply(replay)
            return true
          }
          namespace(id)
          const candidate = assets.candidate(id, input.revision, input.requestId, actor)
          const trust = await trustFor(req, caller, id, input.revision, candidate.bundle, candidate, candidate.executionHash, 'apply')
          actor.authorize()
          await options.serial(actor, async () => {
            const fresh = assets.candidate(id, input.revision, input.requestId, actor)
            if (fresh.executionHash !== candidate.executionHash)
              throw new AppError(409, 'plugin-package-changed', '插件可执行内容已变化，请重新检查。')
            if (fresh.executionHash) await assets.trust(id, fresh.executionHash, pluginTrustRequestId(input.requestId), actor)
            const result = await assets.apply(id, input.revision, input.requestId, actor, activate(id, actor), trust.approve)
            await trust.adopt()
            reply(result)
          })
          return true
        }
        if (method === 'POST' && action === 'rollback') {
          const input = applySchema.parse(await jsonBody(req))
          actor.authorize()
          const replay = assets.replay(id, 'rollback', input.requestId, { revision: input.revision }, actor)
          if (replay) {
            reply(replay)
            return true
          }
          namespace(id)
          const { bundle, record } = assets.rollbackCandidate(id, input.revision, input.requestId, actor)
          // Earlier snapshots were trusted when they were applied; only their pages' capabilities are compared again.
          const trust = await trustFor(req, caller, id, input.revision, bundle, record, undefined, 'rollback')
          actor.authorize()
          await options.serial(actor, async () =>
            reply(await assets.rollback(id, input.revision, input.requestId, actor, activate(id, actor), trust.approve)),
          )
          return true
        }
        if (method === 'POST' && action === 'enabled') {
          const input = enabledSchema.parse(await jsonBody(req))
          actor.authorize()
          await options.serial(actor, async () =>
            reply(
              await assets.setEnabled(id, input.enabled, input.requestId, actor, async (state, commit) => {
                if (input.enabled) namespace(id)
                if (installedIds.has(id)) await options.unmount(id)
                actor.authorize()
                if (input.enabled) {
                  try {
                    await registry.replace(
                      installedAssetPlugin(
                        assets,
                        state.packages.find(record => record.id === id)!,
                      ),
                      async () => {
                        actor.authorize()
                        await commit()
                      },
                      { revision: state.packages.find(record => record.id === id)!.appliedRevision },
                    )
                    installedIds.add(id)
                  } catch (cause) {
                    await options.mount(id)
                    throw cause
                  }
                  await options.mount(id)
                } else {
                  if (installedIds.has(id) && registry.list().some(plugin => plugin.id === id)) registry.retire(id)
                  await commit()
                }
              }),
            ),
          )
          await options.held?.release(id).catch(() => undefined)
          return true
        }
        if (method === 'DELETE' && action === undefined) {
          const input = deleteSchema.parse(await jsonBody(req))
          actor.authorize()
          await options.serial(actor, async () => {
            const result = await assets.remove(id, input.baseRevision, input.requestId, actor, async (_state, commit) => {
              if (installedIds.has(id)) await options.unmount(id)
              actor.authorize()
              if (installedIds.has(id) && registry.list().some(plugin => plugin.id === id)) registry.retire(id, true)
              installedIds.delete(id)
              await commit()
            })
            // Kept by default: a plugin installed again under the same ID finds its data.
            if (options.removeData && !(await options.removeData(caller, id, input.deleteData === true)).audited)
              res.setHeader('x-latch-audit', 'failed')
            reply(result)
          })
          await options.held?.release(id).catch(() => undefined)
          return true
        }
        throw new AppError(404, 'not-found', '接口不存在。')
      } finally {
        active--
        const remaining = activeDevices.get(deviceId)! - 1
        if (remaining === 0) activeDevices.delete(deviceId)
        else activeDevices.set(deviceId, remaining)
      }
    },
  }
}
