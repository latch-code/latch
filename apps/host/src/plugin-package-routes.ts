import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type {
  AppManifestEntry,
  PluginBuild,
  PluginCatalogPreview,
  PluginMarketplaceInstallation,
  PluginNpmPreview,
  PluginNpmRegistrySettings,
  PluginNpmRegistryUpdate,
  PluginPackageBundle,
  PluginPackageDetail,
  PluginPackageReview,
  PluginPackageReviewSource,
  PluginPackageSummary,
} from '@latch/protocol'
import { AppError, type HarnessPlugin } from '@latch/sdk'
import type { PluginRegistry } from '@latch/core'
import { json, jsonBody, safeDecode } from './http-util.ts'
import {
  PluginAssets,
  pluginTrustRequestId,
  pluginApplyPayload,
  pluginEnablePayload,
  type PluginReviewBinding,
  type PluginAssetActor,
  type PluginAssetRecord,
  type PluginAssetMutation,
  type PluginAssetDescriptor,
  type PluginAssetEffect,
  describePluginAsset,
  installIdOf,
  matchesNpmOrigin,
  npmUpdateIsNewer,
  requireNpmOrigin,
} from './plugin-assets.ts'
import { PLUGIN_PACKAGE_BYTES, checkedPluginBundle } from './plugin-package-bundle.ts'
import { loadPluginPackage } from './plugin-packages.ts'
import { capabilitySet, capabilitySetHash, withinApproved } from './app-capabilities.ts'
import { buildPages, type BuildOutcome } from './app-build.ts'
import type { AppBuilds } from './app-builds.ts'
import type { DraftKind, ImportedDraft } from './app-import.ts'
import { readNpmPlugin } from './plugin-npm.ts'
import { npmPreviewSchema, npmRegistryChanged, npmRegistryUpdateSchema, npmRegistryUrl, npmStageSchema } from './npm-source.ts'
import type { FetchLike } from './egress.ts'
import { bundledPlugin, catalogUpdate, requireBundledPlugin } from './plugin-catalog.ts'
import { pluginReviewSource, reviewPluginPackage } from './plugin-package-review.ts'
import { externalPluginRoutes } from './plugin-external-routes.ts'

const requestId = z.string().min(8).max(128),
  hash = z.string().regex(/^[a-f0-9]{64}$/u)
const createSchema = z.strictObject({ requestId, bundle: z.unknown() }),
  saveSchema = createSchema.extend({ baseRevision: hash })
const importSchema = z.strictObject({ requestId, sessionId: z.string().min(1).max(256), kind: z.enum(['app', 'plugin']).default('app') }),
  devSchema = z.strictObject({ requestId, dev: z.boolean() })
const reviewFields = {
  baseAppliedRevision: hash.nullable().optional(),
  reviewedInstallId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{22}$/u)
    .optional(),
}
const revisionSchema = z.strictObject({ requestId, revision: hash })
const applySchema = revisionSchema.extend(reviewFields),
  deleteSchema = z.strictObject({ requestId, baseRevision: hash, deleteData: z.boolean().optional() }),
  enabledSchema = z.strictObject({ requestId, enabled: z.boolean(), ...reviewFields })
const catalogPreviewSchema = z.strictObject({ pluginId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u) })
const catalogStageSchema = catalogPreviewSchema.extend({
  requestId,
  revision: hash,
  update: z.strictObject({ installId: z.string().regex(/^[A-Za-z0-9_-]{22}$/u), baseRevision: hash }).optional(),
})
const reviewQuerySchema = z.strictObject({ operation: z.enum(['apply', 'rollback', 'enable']), revision: hash })
export interface PluginApplyConfirmation extends PluginReviewBinding {
  id: string
  name: string
  revision: string
  /** Present when the package's Host or React code is not yet trusted. */
  executionHash?: string
  installId: string
  version: string
  hostModules: number
  clientPanels: number
  contextPanels?: number
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
/** What a build records in the audit: the result and the bundles' hashes, never the source. */
export interface PluginBuildAudit {
  revision: string
  result: BuildOutcome['status']
  bundleHashes: string[]
  bytes: number
  diagnostics: number
  typeChecked: boolean
}

/** Whether a package's pages are built by the Host: an entry in `.ts` or `.tsx`, not a prebuilt `.js` module. */
export const pagesNeedBuild = (bundle: PluginPackageBundle) => (bundle.manifest.apps ?? []).some(app => /\.tsx?$/iu.test(app.entry))

interface Options<Caller> {
  assets: PluginAssets
  external: { fetch: FetchLike; dataDir: string; home: string; protectedPaths: readonly string[] }
  npm: {
    fetch: FetchLike
    settings(): PluginNpmRegistrySettings
    configure(req: IncomingMessage, caller: Caller, actor: PluginAssetActor, input: PluginNpmRegistryUpdate): Promise<{ audited: boolean }>
  }
  /** Page drafts' builds; without it the build routes answer 404. */
  builds?: AppBuilds
  /** Runs one build; tests give their own tools. */
  build?: (bundle: PluginPackageBundle) => Promise<BuildOutcome>
  /** Page and plugin drafts live in distinct directories. Only human-initiated imports select 'plugin'. */
  readDraft?(sessionId: string, kind: DraftKind): Promise<ImportedDraft>
  draftKinds?(sessionId: string): Promise<DraftKind[]>
  /** Records a build; a failure only marks the response. */
  auditBuild?(actor: PluginAssetActor, id: string, detail: PluginBuildAudit): Promise<boolean>
  /** A build that failed, in each page's diagnostics. */
  buildFailed?(id: string, appIds: string[], message: string): void
  /** The actor of an automatic (开发中) import and build: the device that turned it on, while it still may. */
  automatedActor?(deviceId: string): PluginAssetActor | undefined
  /** A plugin's applied pages changed: SSE `app.updated`. */
  pagesChanged?(id: string): void
  log?(text: string): void
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

const marketplaceInstalled = (
  record: PluginAssetDescriptor,
  origin: { version: string; revision: string } | undefined,
): PluginMarketplaceInstallation => ({
  id: record.id,
  installId: installIdOf(record),
  revision: record.revision,
  ...(origin ? { version: origin.version } : {}),
  modified: !origin || origin.revision !== record.revision,
})

export function createPluginPackageRoutes<Caller>(options: Options<Caller>) {
  const { assets, registry } = options
  const installedIds = options.installedIds ?? new Set<string>()
  const namespace = (id: string) => {
    if (!installedIds.has(id) && registry.list().some(plugin => plugin.id === id))
      throw new AppError(409, 'plugin-package-id-in-use', '这个标识已由启动参数或内置插件占用，请换一个插件标识。')
  }
  function summary(record: PluginAssetDescriptor): PluginPackageSummary {
    const catalog = bundledPlugin(record.id)
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
      ...(record.appliedVersion ? { appliedVersion: record.appliedVersion } : {}),
      ...(record.executionHash ? { executionHash: record.executionHash } : {}),
      enabled: record.enabled && info?.enabled === true,
      trusted: record.executionHash === undefined || record.trusted.includes(record.executionHash),
      capabilities: info?.capabilities ?? [],
      ...(unavailableReason ? { unavailableReason } : {}),
      state: !record.appliedRevision ? 'draft' : record.revision === record.appliedRevision ? 'applied' : 'update-available',
      ...(record.rollbackRevisions.length ? { rollbackRevisions: record.rollbackRevisions } : {}),
      ...(record.source
        ? {
            source: {
              sessionId: record.source.sessionId,
              dev: record.source.dev,
              ...(record.source.kind ? { kind: record.source.kind } : {}),
            },
          }
        : {}),
      ...(record.npm ? { npm: record.npm } : {}),
      ...(record.catalog ? { catalog: record.catalog } : {}),
      ...(record.external ? { external: record.external } : {}),
      ...(catalog ? { catalogUpdate: { version: catalog.bundle.manifest.version, status: catalogUpdate(catalog, record) } } : {}),
    }
  }
  /** The summary with the draft's pages and its latest build, and the newest build a preview can show. */
  async function described(record: PluginAssetDescriptor, bundle: PluginPackageBundle): Promise<PluginPackageSummary> {
    const base = summary(record)
    const pages = bundle.manifest.apps?.length ?? 0
    if (!pages) return base
    const build = options.builds && pagesNeedBuild(bundle) ? await options.builds.latest(record.id, record.revision) : undefined
    const preview = options.builds && pagesNeedBuild(bundle) ? await options.builds.latestOk(record.id) : undefined
    return {
      ...base,
      pages,
      ...(build ? { build: { ...build, diagnostics: build.diagnostics.length } } : {}),
      ...(preview ? { preview: { revision: preview.revision, modules: preview.modules } } : {}),
    }
  }
  const dataTakeover = async (bundle: PluginPackageBundle, owner: { id: string; owner: string }) =>
    bundle.manifest.apps?.some(app => app.capabilities.storage) && (await options.dataClaim?.(owner)) === 'other'
      ? (true as const)
      : undefined

  async function review(
    checked: ReturnType<typeof checkedPluginBundle>,
    source: PluginPackageReviewSource,
    record?: PluginAssetRecord,
    enable = false,
  ): Promise<PluginPackageReview> {
    const owner = { id: checked.bundle.manifest.id, owner: record ? installIdOf(record) : 'preview' }
    return {
      ...reviewPluginPackage(checked, source, record, enable ? undefined : await dataTakeover(checked.bundle, owner)),
      ...(record ? { installId: owner.owner } : {}),
    }
  }
  const handleExternal = externalPluginRoutes({ assets, reader: options.external, serial: options.serial, namespace, review })

  const detail = async (record: PluginAssetRecord): Promise<PluginPackageDetail> => ({
    ...(await described(describePluginAsset(record), record.bundle)),
    bundle: structuredClone(record.bundle),
    review: await review(
      { bundle: record.bundle, revision: record.revision, executionHash: record.executionHash },
      pluginReviewSource(record, record.revision, true),
      record,
    ),
  })
  const keepOf = (record: PluginAssetRecord) =>
    new Set([
      record.revision,
      ...(record.appliedRevision ? [record.appliedRevision] : []),
      ...(record.history ?? []).map(item => item.revision),
    ])
  let buildTail: Promise<unknown> = Promise.resolve()
  const buildRequests = new Map<string, Promise<PluginBuild>>()
  /** Builds the draft's revision once at a time on this Host; a revision already built successfully is not built again. */
  async function buildRevision(actor: PluginAssetActor, id: string, revision: string, audit?: { failed: boolean }): Promise<PluginBuild> {
    const builds = options.builds
    if (!builds) throw new AppError(404, 'not-found', '接口不存在。')
    const record = assets.get(id)
    if (record.revision !== revision) throw new AppError(409, 'plugin-package-changed', '插件草稿已变化，请刷新后再构建。')
    if (!pagesNeedBuild(record.bundle)) throw new AppError(409, 'plugin-package-no-build', '这个插件没有要构建的页面。')
    const existing = await builds.latest(id, revision)
    if (existing?.status === 'ok') return existing
    const run = buildTail
      .catch(() => {})
      .then(async () => {
        actor.authorize()
        const outcome = await (options.build ?? buildPages)(record.bundle)
        const audited = await options.auditBuild?.(actor, id, {
          revision,
          result: outcome.status,
          bundleHashes: outcome.modules.map(module => module.hash),
          bytes: outcome.modules.reduce((sum, module) => sum + Buffer.byteLength(module.code), 0),
          diagnostics: outcome.diagnostics.length,
          typeChecked: outcome.typeChecked,
        })
        if (audited === false && audit) audit.failed = true
        const current = assets.has(id) ? assets.get(id) : record
        const saved = await builds.record(
          id,
          revision,
          outcome,
          keepOf(current),
          new Set([current.revision, ...(current.appliedRevision ? [current.appliedRevision] : [])]),
        )
        if (outcome.status !== 'ok') {
          const first = outcome.diagnostics[0]
          const where = first?.file ? `${first.file}${first.line ? `:${first.line}:${first.column ?? 1}` : ''}  ` : ''
          options.buildFailed?.(
            id,
            (record.bundle.manifest.apps ?? []).map(app => app.id),
            `构建没通过（${outcome.diagnostics.length} 条）${first ? `：${where}${first.message}` : ''}`,
          )
        }
        options.changed()
        return saved
      })
    buildTail = run
    return run
  }
  /** Apply and rollback need a successful build of the revision whose pages the Host builds. */
  async function requireBuild(id: string, revision: string, bundle: PluginPackageBundle): Promise<void> {
    if (!pagesNeedBuild(bundle)) return
    const build = await options.builds?.latest(id, revision)
    if (build?.status !== 'ok') throw new AppError(409, 'plugin-package-not-built', '请先构建这个版本，构建通过后才能应用。')
  }
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
    binding: PluginReviewBinding,
    recoveringAdoption = false,
  ) {
    const apps = bundle.manifest.apps ?? [],
      set = capabilitySet(bundle.manifest),
      capabilitiesHash = capabilitySetHash(set)
    const untrusted = executionHash && !record.trusted.includes(executionHash) ? executionHash : undefined
    // Data a deleted plugin with this ID kept is taken over only with a confirmation that says so.
    const owner = { id, owner: installIdOf(record) }
    const adoptsData = await dataTakeover(bundle, owner)
    const widens = apps.length > 0 && (!withinApproved(set, record.approvedApps) || (adoptsData === true && !recoveringAdoption))
    const contextPanels = bundle.manifest.panels?.filter(panel => panel.context === true).length
    if (untrusted || widens)
      await options.confirm(req, caller, {
        id,
        name: bundle.manifest.name,
        revision,
        installId: owner.owner,
        version: bundle.manifest.version,
        ...(binding.baseAppliedRevision !== undefined ? { baseAppliedRevision: binding.baseAppliedRevision } : {}),
        ...(binding.reviewedInstallId !== undefined ? { reviewedInstallId: binding.reviewedInstallId } : {}),
        ...(untrusted ? { executionHash: untrusted } : {}),
        hostModules: bundle.manifest.host?.length ?? 0,
        clientPanels: bundle.manifest.panels?.length ?? 0,
        ...(contextPanels ? { contextPanels } : {}),
        ...(widens ? { apps, capabilitiesHash } : {}),
        ...(adoptsData ? { adoptsData } : {}),
      })
    if (apps.length)
      await options.appTrust?.(caller, { id, revision, capabilitiesHash, operation, trust: widens ? 'confirmed' : 'capabilities-approved' })
    return {
      approve: widens ? set : undefined,
      capabilitiesHash,
      adoptsData,
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
    /**
     * 开发中: after a turn of a draft's source session, the draft is imported and built again when `latch-app/` changed,
     * as the device that turned it on. A failed build keeps the last good preview; nothing is applied.
     */
    async devTurn(sessionId: string): Promise<void> {
      if (!options.readDraft || !options.builds) return
      let records: PluginAssetRecord[]
      try {
        records = assets.list().filter(record => record.source?.sessionId === sessionId && record.source.dev && record.source.devDevice)
      } catch {
        return
      }
      for (const record of records) {
        const actor = options.automatedActor?.(record.source!.devDevice!)
        if (!actor) {
          // The device that turned it on can no longer act here (expired, removed, no longer this Mac's admin): it stops.
          await assets.stopDev(record.source!.devDevice!).catch(() => undefined)
          options.changed()
          continue
        }
        try {
          const draft = await options.readDraft(sessionId, 'app')
          const checked = checkedPluginBundle(draft.bundle)
          if (checked.bundle.manifest.id !== record.id) {
            options.buildFailed?.(
              record.id,
              (record.bundle.manifest.apps ?? []).map(app => app.id),
              '草稿的 id 变了，开发中的自动构建已跳过。',
            )
            continue
          }
          let revision = record.revision
          if (checked.revision !== record.revision) {
            const result = await options.serial(actor, () => assets.importDraft(draft.bundle, sessionId, randomUUID(), actor))
            revision = result.record?.revision ?? revision
            options.changed()
          } else if (await options.builds.latest(record.id, revision)) continue
          await buildRevision(actor, record.id, revision)
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          if (cause instanceof AppError && cause.status < 500)
            options.buildFailed?.(
              record.id,
              (record.bundle.manifest.apps ?? []).map(app => app.id),
              `草稿没有导入：${message}`,
            )
          options.log?.(`插件 ${record.id} 的开发中自动构建没有完成：${message}`)
        }
      }
    },
    async handle(req: IncomingMessage, res: ServerResponse, caller: Caller, path: string, method: string): Promise<boolean> {
      if (path !== '/link/api/plugin-packages' && !path.startsWith('/link/api/plugin-packages/')) return false
      const actor = options.authorize(caller)
      const deviceId = actor.actor.deviceId,
        count = activeDevices.get(deviceId) ?? 0
      if (active >= 4 || count >= 2) throw new AppError(429, 'plugin-package-busy', '同时处理的插件请求过多，请稍后再试。')
      active++
      activeDevices.set(deviceId, count + 1)
      try {
        /** `pages`: the plugin whose applied pages this changed (SSE `app.updated`). */
        const reply = async (result: PluginAssetMutation, status = 200, pages?: string) => {
          if (result.adoptOwner && result.record) {
            actor.authorize()
            try {
              await options.adoptData?.({ id: result.record.id, owner: result.adoptOwner })
            } catch {
              throw new AppError(503, 'plugin-package-write-unknown', '插件保存的数据尚未接好，请重试同一次修改。')
            }
          }
          const body = result.record
            ? { package: await detail(result.record), ...(result.importedRevision ? { importedRevision: result.importedRevision } : {}) }
            : { removed: true }
          actor.authorize()
          if (!result.audited) res.setHeader('x-latch-audit', 'failed')
          options.changed()
          if (pages !== undefined) options.pagesChanged?.(pages)
          json(res, body, status)
        }
        if (await handleExternal(req, res, actor, path, method, reply)) return true
        if (method === 'POST' && path === '/link/api/plugin-packages/review') {
          const { bundle } = z.strictObject({ bundle: z.unknown() }).parse(await jsonBody(req, PLUGIN_PACKAGE_BYTES + 65536))
          const result = await review(checkedPluginBundle(bundle), { kind: 'local' })
          actor.authorize()
          json(res, { review: result })
          return true
        }
        const catalogRoute = /^\/link\/api\/plugin-packages\/catalog\/(preview|stage)$/u.exec(path)
        if (catalogRoute) {
          if (method !== 'POST') throw new AppError(404, 'not-found', '接口不存在。')
          if (catalogRoute[1] === 'preview') {
            const { pluginId } = catalogPreviewSchema.parse(await jsonBody(req))
            const checked = requireBundledPlugin(pluginId)
            const record = assets.has(pluginId) ? assets.get(pluginId) : undefined
            if (!record) namespace(pluginId)
            const descriptor = record ? describePluginAsset(record) : undefined
            const status = descriptor ? catalogUpdate(checked, descriptor) : undefined
            const version = checked.bundle.manifest.version
            const result = await review(checked, { kind: 'catalog', version }, record)
            actor.authorize()
            json(res, {
              bundle: checked.bundle,
              review: result,
              ...(descriptor
                ? {
                    installed: marketplaceInstalled(descriptor, descriptor.catalog),
                    updateStatus: status,
                    updateAvailable: status === 'available',
                  }
                : {}),
            } satisfies PluginCatalogPreview)
            return true
          }
          const input = catalogStageSchema.parse(await jsonBody(req))
          await options.serial(actor, async () => {
            const previous = await assets.replayCatalog(input, actor)
            if (previous) return reply(previous, 201)
            namespace(input.pluginId)
            await reply(await assets.stageCatalog(input, requireBundledPlugin(input.pluginId), actor), 201)
          })
          return true
        }
        const npmRoute = /^\/link\/api\/plugin-packages\/npm\/(registry|preview|stage)$/u.exec(path)
        if (npmRoute) {
          const { npm } = options
          const suffix = npmRoute[1]
          if (suffix === 'registry') {
            if (method === 'PUT') {
              const input = npmRegistryUpdateSchema.parse(await jsonBody(req))
              actor.authorize()
              const result = await npm.configure(req, caller, actor, {
                ...input,
                registry: input.registry === null ? null : npmRegistryUrl(input.registry),
              })
              if (!result.audited) res.setHeader('x-latch-audit', 'failed')
            } else if (method !== 'GET') throw new AppError(404, 'not-found', '接口不存在。')
            actor.authorize()
            json(res, npm.settings())
            return true
          }
          if (method !== 'POST') throw new AppError(404, 'not-found', '接口不存在。')
          const guard = (address: string) => {
            const revision = npm.settings().revision
            return () => {
              actor.authorize()
              const current = npm.settings()
              if (current.registry !== address || current.revision !== revision) throw npmRegistryChanged()
            }
          }
          if (suffix === 'preview') {
            const input = npmPreviewSchema.parse(await jsonBody(req))
            const { registry: address } = npm.settings()
            if (!address) throw new AppError(409, 'plugin-npm-registry-unconfigured', '请先在这台电脑上配置 npm 仓库。')
            const source = { registry: address, name: input.name }
            if (input.pluginId) requireNpmOrigin(assets.get(input.pluginId), source)
            const check = guard(address)
            const checked = await readNpmPlugin(npm.fetch, { registry: address, ...input }, check)
            const { release, revision, bundle } = checked
            const id = bundle.manifest.id
            const installedId =
              input.pluginId ?? assets.descriptors().find(record => matchesNpmOrigin(record, source) || record.id === id)?.id
            const installed = installedId ? assets.get(installedId) : undefined
            if (input.pluginId && (id !== input.pluginId || !matchesNpmOrigin(installed!, source)))
              throw new AppError(409, 'plugin-npm-source-mismatch', 'npm 新版本的插件标识或仓库与已下载版本不同。')
            if (!installed) namespace(id)
            const same = installed !== undefined && installed.id === id && matchesNpmOrigin(installed, source)
            const viewed = await review(checked, { kind: 'npm', ...release }, installed)
            check()
            json(res, {
              release,
              revision,
              bundle,
              review: viewed,
              ...(installed
                ? {
                    installed: marketplaceInstalled(describePluginAsset(installed), installed.npm),
                    updateAvailable: same && npmUpdateIsNewer(release, installed.npm!, installed.appliedBundle?.manifest.version),
                  }
                : {}),
            } satisfies PluginNpmPreview)
            return true
          }
          const input = npmStageSchema.parse(await jsonBody(req))
          const replay = () => assets.replayNpm(input, actor)
          const previous = await options.serial(actor, replay)
          if (previous) {
            await reply(previous, 201)
            return true
          }
          const check = guard(input.release.registry)
          check()
          assets.checkNpmStage(input)
          const downloaded = await readNpmPlugin(npm.fetch, input.release, check, input.release.integrity)
          const result = await options.serial(actor, async () => {
            const completed = await replay()
            if (completed) return completed
            check()
            namespace(downloaded.bundle.manifest.id)
            return assets.stageNpm(input, downloaded, actor)
          })
          await reply(result, 201)
          return true
        }
        if (path === '/link/api/plugin-packages') {
          if (method === 'GET') {
            const records = assets.list()
            const packages = await Promise.all(records.map(record => described(describePluginAsset(record), record.bundle)))
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
              await reply(result, 201)
            })
            return true
          }
          throw new AppError(404, 'not-found', '接口不存在。')
        }
        if (path === '/link/api/plugin-packages/import') {
          if (method !== 'POST' || !options.readDraft) throw new AppError(404, 'not-found', '接口不存在。')
          const input = importSchema.parse(await jsonBody(req))
          const replay = () => assets.replayImport(input.sessionId, input.kind, input.requestId, actor)
          const previous = await options.serial(actor, replay)
          if (previous) {
            await reply(previous, 201)
            return true
          }
          actor.authorize()
          const draft = await options.readDraft(input.sessionId, input.kind)
          actor.authorize()
          const imported = checkedPluginBundle(draft.bundle).bundle.manifest.id
          await options.serial(actor, async () => {
            // An overlapping retry may have captured the first snapshot while this request was reading.
            const completed = await replay()
            if (completed) return reply(completed, 201)
            namespace(imported)
            await reply(await assets.importDraft(draft.bundle, input.sessionId, input.requestId, actor, input.kind), 201)
          })
          return true
        }
        if (path === '/link/api/plugin-packages/session-draft') {
          if (method !== 'GET' || !options.draftKinds) throw new AppError(404, 'not-found', '接口不存在。')
          const sessionId = new URL(req.url ?? '/', 'http://latch.invalid').searchParams.get('sessionId') ?? ''
          if (!sessionId || sessionId.length > 256) throw new AppError(400, 'invalid-input', '缺少会话。')
          const kinds = await options.draftKinds(sessionId)
          const owners = assets.list().filter(record => record.source?.sessionId === sessionId)
          const kind = kinds[0] ?? 'app'
          const pluginIds: Partial<Record<DraftKind, string>> = {}
          for (const item of kinds) {
            const matching = owners.filter(record => (record.source?.kind ?? 'app') === item)
            if (matching.length === 1) pluginIds[item] = matching[0].id
          }
          actor.authorize()
          json(res, {
            present: kinds.length > 0,
            ...(pluginIds[kind] ? { pluginId: pluginIds[kind] } : {}),
            ...(kinds.includes('plugin') ? { kinds, kind, pluginIds } : {}),
          })
          return true
        }
        const bundleMatch = /^\/link\/api\/plugin-packages\/([^/]+)\/builds\/([a-f0-9]{64})\.js$/u.exec(path)
        if (bundleMatch) {
          if ((method !== 'GET' && method !== 'HEAD') || !options.builds) throw new AppError(404, 'not-found', '接口不存在。')
          // As a page's module: only the shell's own fetch takes the bytes, never a script, frame or navigation.
          const dest = req.headers['sec-fetch-dest']
          if (dest !== undefined && dest !== 'empty') throw new AppError(403, 'app-module-refused', '页面代码只交给页面框。')
          const plugin = safeDecode(bundleMatch[1]!)
          if (!/^[A-Za-z0-9_-]{1,64}$/u.test(plugin) || !assets.has(plugin))
            throw new AppError(404, 'plugin-package-not-found', '找不到这个自定义插件。')
          const bytes = await options.builds.bundle(plugin, bundleMatch[2]!)
          if (!bytes) throw new AppError(404, 'app-module-not-found', '这个构建已不可用，请重新构建。')
          actor.authorize()
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'x-content-type-options': 'nosniff',
            'content-length': String(bytes.length),
            'cache-control': 'no-store',
          })
          res.end(method === 'HEAD' ? undefined : bytes)
          return true
        }
        const match = /^\/link\/api\/plugin-packages\/([^/]+)(?:\/(apply|export|enabled|rollback|build|dev|review))?$/u.exec(path)
        if (!match) throw new AppError(404, 'not-found', '接口不存在。')
        const id = safeDecode(match[1]!),
          action = match[2]
        if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id)) throw new AppError(400, 'plugin-package-id', '插件标识无效。')
        if (method === 'GET' && action === undefined) {
          const record = assets.get(id)
          const body = { package: await detail(record) }
          actor.authorize()
          json(res, body)
          return true
        }
        if (method === 'GET' && action === 'review') {
          const query = new URL(req.url ?? '/', 'http://latch.invalid').searchParams
          const { operation, revision } = reviewQuerySchema.parse({ operation: query.get('operation'), revision: query.get('revision') })
          const record = assets.get(id)
          const bundle =
            operation === 'apply' && record.revision === revision
              ? record.bundle
              : operation === 'enable' && record.appliedRevision === revision
                ? record.appliedBundle
                : operation === 'rollback'
                  ? record.history?.find(item => item.revision === revision)?.bundle
                  : undefined
          if (!bundle) throw new AppError(409, 'plugin-package-changed', '这个待审阅版本已变化，请刷新插件。')
          const result = await review(
            checkedPluginBundle(bundle),
            pluginReviewSource(record, revision, operation === 'apply'),
            record,
            operation === 'enable',
          )
          actor.authorize()
          json(res, { review: result })
          return true
        }
        if (method === 'GET' && action === 'build') {
          if (!options.builds) throw new AppError(404, 'not-found', '接口不存在。')
          const revision = hash.safeParse(new URL(req.url ?? '/', 'http://latch.invalid').searchParams.get('revision'))
          if (!revision.success) throw new AppError(400, 'invalid-input', '缺少版本。')
          if (!assets.has(id)) throw new AppError(404, 'plugin-package-not-found', '找不到这个自定义插件。')
          const build = await options.builds.latest(id, revision.data)
          if (!build) throw new AppError(404, 'plugin-build-not-found', '这个版本还没有构建。')
          actor.authorize()
          json(res, { build })
          return true
        }
        if (method === 'POST' && action === 'build') {
          const input = revisionSchema.parse(await jsonBody(req))
          actor.authorize()
          const key = `${deviceId}\n${input.requestId}`
          const known = buildRequests.get(key)
          const audit = { failed: false }
          const pending = known ?? buildRevision(actor, id, input.revision, audit)
          if (!known) {
            buildRequests.set(key, pending)
            if (buildRequests.size > 256) buildRequests.delete(buildRequests.keys().next().value!)
            pending.catch(() => buildRequests.delete(key))
          }
          const build = await pending
          actor.authorize()
          if (audit.failed) res.setHeader('x-latch-audit', 'failed')
          json(res, { build })
          return true
        }
        if (method === 'POST' && action === 'dev') {
          const input = devSchema.parse(await jsonBody(req))
          actor.authorize()
          await options.serial(actor, async () => reply(await assets.setDev(id, input.dev, input.requestId, actor)))
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
          const handled = await options.serial(actor, async () => {
            const replay = assets.replay(id, 'apply', input.requestId, pluginApplyPayload(input.revision, input), actor)
            if (!replay) return false
            await reply(replay, 200, id)
            return true
          })
          if (handled) return true
          namespace(id)
          const candidate = assets.candidate(id, input.revision, input.requestId, actor)
          assets.checkReview(id, input)
          await requireBuild(id, input.revision, candidate.bundle)
          const trust = await trustFor(
            req,
            caller,
            id,
            input.revision,
            candidate.bundle,
            candidate,
            candidate.executionHash,
            'apply',
            input,
            assets.pendingAdoption(id, input.revision, input.requestId, actor),
          )
          actor.authorize()
          await options.serial(actor, async () => {
            const completed = assets.replay(id, 'apply', input.requestId, pluginApplyPayload(input.revision, input), actor)
            if (completed) return reply(completed, 200, id)
            const fresh = assets.candidate(id, input.revision, input.requestId, actor)
            assets.checkReview(id, input)
            if (fresh.executionHash !== candidate.executionHash || installIdOf(fresh) !== installIdOf(candidate))
              throw new AppError(409, 'plugin-package-changed', '插件可执行内容已变化，请重新检查。')
            if (fresh.executionHash) await assets.trust(id, fresh.executionHash, pluginTrustRequestId(input.requestId), actor)
            const result = await assets.apply(
              id,
              input.revision,
              input.requestId,
              actor,
              activate(id, actor),
              trust.approve,
              input,
              trust.adoptsData,
            )
            await reply(result, 200, id)
          })
          return true
        }
        if (method === 'POST' && action === 'rollback') {
          const input = applySchema.parse(await jsonBody(req))
          actor.authorize()
          const handled = await options.serial(actor, async () => {
            const replay = assets.replay(id, 'rollback', input.requestId, pluginApplyPayload(input.revision, input), actor)
            if (!replay) return false
            await reply(replay, 200, id)
            return true
          })
          if (handled) return true
          namespace(id)
          const { bundle, record } = assets.rollbackCandidate(id, input.revision, input.requestId, actor)
          assets.checkReview(id, input)
          await requireBuild(id, input.revision, bundle)
          // Earlier snapshots were trusted when they were applied; only their pages' capabilities are compared again.
          const trust = await trustFor(
            req,
            caller,
            id,
            input.revision,
            bundle,
            record,
            undefined,
            'rollback',
            input,
            assets.pendingAdoption(id, input.revision, input.requestId, actor),
          )
          actor.authorize()
          await options.serial(actor, async () => {
            const completed = assets.replay(id, 'rollback', input.requestId, pluginApplyPayload(input.revision, input), actor)
            if (completed) return reply(completed, 200, id)
            const fresh = assets.rollbackCandidate(id, input.revision, input.requestId, actor)
            assets.checkReview(id, input)
            if (installIdOf(fresh.record) !== installIdOf(record))
              throw new AppError(409, 'plugin-package-changed', '插件安装记录已变化，请重新审阅。')
            const result = await assets.rollback(
              id,
              input.revision,
              input.requestId,
              actor,
              activate(id, actor),
              trust.approve,
              input,
              trust.adoptsData,
            )
            await reply(result, 200, id)
          })
          return true
        }
        if (method === 'POST' && action === 'enabled') {
          const input = enabledSchema.parse(await jsonBody(req))
          actor.authorize()
          await options.serial(actor, async () => {
            if (input.enabled) {
              const replay = assets.replay(id, 'enable', input.requestId, pluginEnablePayload(true, input), actor)
              if (replay) return reply(replay, 200, id)
              assets.checkReview(id, input)
            }
            await reply(
              await assets.setEnabled(
                id,
                input.enabled,
                input.requestId,
                actor,
                async (state, commit) => {
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
                },
                input,
              ),
              200,
              id,
            )
          })
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
            await options.builds?.remove(id).catch(() => undefined)
            await reply(result, 200, id)
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
