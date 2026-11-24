import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type {
  PluginCatalogStage,
  PluginExternalRelease,
  PluginExternalStage,
  PluginNpmRelease,
  PluginNpmStage,
  PluginPackageBundle,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, syncDirectory, writeFileAtomic, type AtomicWriteFs } from '@latch/core/node-kit'
import type { AuditActor, AuditLog } from './audit.ts'
import { checkedPluginBundle } from './plugin-package-bundle.ts'
import { appCapabilitiesSchema, capabilitySet, withinApproved, type AppSet } from './app-capabilities.ts'
import { newerNpmVersion, npmOriginSchema, npmReleaseSchema, releaseVersionSchema } from './npm-source.ts'
import { catalogUpdate, catalogUpdateError } from './plugin-catalog.ts'
import {
  externalOriginSchema,
  externalReviewSourceSchema,
  externalSourceIdentity,
  externalStagePayload,
  externalUpdate,
  externalUpdateError,
} from './plugin-external-source.ts'
import { pluginReviewSource } from './plugin-package-review.ts'

const LIMIT = 64 * 1024 * 1024,
  MAX_RECEIPTS = 10000
/** Earlier applied revisions a rollback can return to; the oldest go first when the asset budget is short. */
export const ROLLBACK_REVISIONS = 5
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  hash = z.string().regex(/^[a-f0-9]{64}$/u),
  rid = z.string().min(8).max(128),
  installIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/u)
const bundleSchema = z.custom<PluginPackageBundle>(value => {
  try {
    checkedPluginBundle(value)
    return true
  } catch {
    return false
  }
})
const catalogOriginSchema = z.strictObject({ revision: hash, version: releaseVersionSchema })
const originSchema = z.union([
  z.strictObject({ kind: z.enum(['local', 'creator']) }),
  z.strictObject({ kind: z.literal('catalog'), version: releaseVersionSchema, modified: z.literal(true).optional() }),
  npmReleaseSchema.extend({ kind: z.literal('npm'), modified: z.literal(true).optional() }),
  externalReviewSourceSchema,
])
const recordSchema = z.strictObject({
  id: idSchema,
  bundle: bundleSchema,
  revision: hash,
  executionHash: hash.optional(),
  appliedBundle: bundleSchema.optional(),
  appliedRevision: hash.optional(),
  enabled: z.boolean(),
  trusted: z.array(hash).max(128),
  /** This record's own identity: a plugin created again under a deleted one's ID gets a new one (its pages' data and sessions). */
  installId: installIdSchema.optional(),
  /** The page capabilities this computer confirmed, by page ID: code that asks for no more applies without a confirmation. */
  approvedApps: z.record(idSchema, appCapabilitiesSchema).optional(),
  /**
   * The session a page draft was imported from. `dev`: after each of its turns that changed `latch-app/`, the draft is
   * imported and built again, as `devDevice` (the device that turned it on) would.
   */
  source: z
    .strictObject({
      sessionId: z.string().min(1).max(256),
      dev: z.boolean(),
      kind: z.literal('plugin').optional(),
      devDevice: z
        .string()
        .regex(/^dev_[A-Za-z0-9_-]{22}$/u)
        .optional(),
    })
    .optional(),
  npm: npmOriginSchema.optional(),
  catalog: catalogOriginSchema.optional(),
  external: externalOriginSchema.optional(),
  appliedOrigin: originSchema.optional(),
  /** Earlier applied snapshots, newest first. */
  history: z
    .array(z.strictObject({ revision: hash, bundle: bundleSchema, origin: originSchema.optional() }))
    .max(ROLLBACK_REVISIONS)
    .optional(),
})
const receiptSchema = z.strictObject({
  hash,
  id: idSchema,
  /** The first snapshot read for this import. Older records can still be matched by their original intent hash. */
  imported: z.strictObject({ revision: hash, installId: installIdSchema }).optional(),
  downloaded: installIdSchema.optional(),
  reviewedInstallId: installIdSchema.optional(),
  adopt: z.strictObject({ revision: hash, installId: installIdSchema }).optional(),
})
const stateSchema = z.strictObject({
  version: z.literal(1),
  packages: z.array(recordSchema).max(64),
  receipts: z.record(hash, receiptSchema),
})
export type PluginAssetRecord = z.infer<typeof recordSchema>
export type PluginAssetDescriptor = Omit<PluginAssetRecord, 'bundle' | 'appliedBundle' | 'history' | 'appliedOrigin'> & {
  name: string
  version: string
  appliedVersion?: string
  description: string
  rollbackRevisions: Array<{ revision: string; version: string }>
}
/** A record's identity; records saved before identities existed get a fixed one derived from their ID. */
export function installIdOf(record: Pick<PluginAssetRecord, 'id' | 'installId'>): string {
  return record.installId ?? sha256Hex(canonicalJson(['plugin-install', record.id])).slice(0, 22)
}
export function describePluginAsset(record: PluginAssetRecord): PluginAssetDescriptor {
  const { bundle, appliedBundle, appliedOrigin: _, history, ...rest } = record
  return {
    ...rest,
    trusted: [...rest.trusted],
    rollbackRevisions: (history ?? []).map(entry => ({ revision: entry.revision, version: entry.bundle.manifest.version })),
    name: bundle.manifest.name,
    version: bundle.manifest.version,
    ...(appliedBundle ? { appliedVersion: appliedBundle.manifest.version } : {}),
    description: bundle.manifest.description,
  }
}
type State = z.infer<typeof stateSchema>
type DownloadOperation = 'npm-stage' | 'catalog-stage' | 'external-stage'
type Operation = 'create' | 'save' | 'import' | DownloadOperation | 'dev' | 'trust' | 'apply' | 'rollback' | 'enable' | 'disable' | 'delete'
export interface PluginAssetActor {
  actor: AuditActor & { deviceId: string }
  authorize(): void
}
interface Pending {
  state: State
  key: string
  hash: string
  id: string
  audited: boolean
}
export interface PluginAssetOptions {
  audit: Pick<AuditLog, 'append'>
  atomicFs?: AtomicWriteFs
}
export interface PluginAssetMutation {
  record?: PluginAssetRecord
  audited: boolean
  replay?: true
  importedRevision?: string
  adoptOwner?: string
}
export type PluginAssetEffect = (next: { packages: PluginAssetRecord[] }, commit: () => Promise<void>) => Promise<void>
type Effect = PluginAssetEffect
export const pluginTrustRequestId = (requestId: string): string => sha256Hex(canonicalJson(['plugin-execution-trust', requestId]))

const importPayload = (revision: string, sessionId: string, kind: 'app' | 'plugin') => ({
  revision,
  sessionId,
  ...(kind === 'plugin' ? { kind } : {}),
})
const catalogPayload = ({ pluginId, revision, update }: PluginCatalogStage) => ({ pluginId, revision, update: update ?? null })

export interface PluginReviewBinding {
  baseAppliedRevision?: string | null
  reviewedInstallId?: string
}

function reviewPayload(binding: PluginReviewBinding = {}): PluginReviewBinding {
  return {
    ...(binding.baseAppliedRevision !== undefined ? { baseAppliedRevision: binding.baseAppliedRevision } : {}),
    ...(binding.reviewedInstallId !== undefined ? { reviewedInstallId: binding.reviewedInstallId } : {}),
  }
}

export function pluginApplyPayload(revision: string, binding?: PluginReviewBinding) {
  return { revision, ...reviewPayload(binding) }
}

export function pluginEnablePayload(enabled: boolean, binding?: PluginReviewBinding) {
  return { enabled, ...(enabled ? reviewPayload(binding) : {}) }
}

function assertReviewBinding(record: PluginAssetRecord, binding: PluginReviewBinding | undefined): void {
  if (binding?.reviewedInstallId !== undefined && installIdOf(record) !== binding.reviewedInstallId)
    throw new AppError(409, 'plugin-package-changed', '插件安装记录已变化，请重新审阅。')
  if (binding?.baseAppliedRevision !== undefined && (record.appliedRevision ?? null) !== binding.baseAppliedRevision)
    throw new AppError(409, 'plugin-package-changed', '已应用的版本发生变化，请重新审阅。')
}

const npmPayload = ({ release, revision, update }: PluginNpmStage) => ({ release, revision, update: update ?? null })

export function matchesNpmOrigin(record: Pick<PluginAssetRecord, 'npm'>, source: Pick<PluginNpmRelease, 'registry' | 'name'>): boolean {
  return record.npm?.registry === source.registry && record.npm.name === source.name
}

export function requireNpmOrigin(record: Pick<PluginAssetRecord, 'npm'>, source: Pick<PluginNpmRelease, 'registry' | 'name'>): void {
  if (!matchesNpmOrigin(record, source)) throw new AppError(409, 'plugin-npm-source-mismatch', '请使用此插件原来下载时的 npm 仓库和包名。')
}

function checkNpmUpdate(record: PluginAssetDescriptor | PluginAssetRecord, input: PluginNpmStage): void {
  const update = input.update!
  requireNpmOrigin(record, input.release)
  if (record.revision !== update.baseRevision || installIdOf(record) !== update.installId)
    throw new AppError(409, 'plugin-package-changed', '插件草稿或安装记录已变化，请重新预览再下载。')
  if (record.revision !== record.npm!.revision && update.replaceLocalDraft !== true)
    throw new AppError(409, 'plugin-npm-local-changes', '草稿有本机改动，请保留现有草稿后再更新。')
  const appliedVersion = 'bundle' in record ? record.appliedBundle?.manifest.version : record.appliedVersion
  if (!npmUpdateIsNewer(input.release, record.npm!, appliedVersion))
    throw new AppError(409, 'plugin-npm-not-newer', '这个 npm 版本没有比已下载的版本更新。')
}

/** Any version matching the applied release by precedence is also a no-op, even when metadata differs. */
export function npmUpdateIsNewer(release: PluginNpmRelease, staged: PluginNpmRelease, appliedVersion?: string): boolean {
  return (
    newerNpmVersion(release.version, staged.version) && (appliedVersion === undefined || newerNpmVersion(release.version, appliedVersion))
  )
}

function checkAppliedOrigin(origin: z.infer<typeof originSchema> | undefined, version: string, record: PluginAssetRecord): void {
  if (!origin || !('version' in origin)) return
  if (
    (!origin.modified && origin.version !== version)
    || (origin.kind === 'catalog' && !record.catalog)
    || (origin.kind === 'npm' && !matchesNpmOrigin(record, origin))
    || (origin.kind === 'external' && (!record.external || externalSourceIdentity(record.external) !== externalSourceIdentity(origin)))
  )
    throw new Error('Invalid applied source')
}

/** Editable data and applied snapshots are separate. A failed atomic publication blocks reads until the exact write is retried. */
export class PluginAssets {
  private tail: Promise<unknown> = Promise.resolve()
  private pending?: Pending
  private importedBytes = 0
  private constructor(
    readonly directory: string,
    private state: State,
    private readonly options: PluginAssetOptions,
  ) {}
  static async open(dataDir: string, options: PluginAssetOptions): Promise<PluginAssets> {
    const directory = join(dataDir, 'plugin-packages'),
      path = join(directory, 'assets.json'),
      uid = process.getuid?.()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const folder = await lstat(directory)
    if (!folder.isDirectory() || folder.isSymbolicLink() || folder.mode & 0o077 || (uid !== undefined && folder.uid !== uid))
      throw new AppError(500, 'plugin-package-private', '插件目录必须只有本人可访问。')
    let state: State = { version: 1, packages: [], receipts: {} }
    try {
      const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await fd.stat()
        if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.size > LIMIT || (uid !== undefined && info.uid !== uid))
          throw new Error('Invalid private asset file')
        const buffer = Buffer.alloc(Math.min(LIMIT + 1, Math.max(65536, info.size + 1)))
        let offset = 0
        while (offset < buffer.length) {
          const part = await fd.read(buffer, offset, buffer.length - offset, null)
          if (!part.bytesRead) break
          offset += part.bytesRead
        }
        if (offset > LIMIT || offset === buffer.length) throw new Error('Asset budget')
        state = stateSchema.parse(JSON.parse(buffer.subarray(0, offset).toString('utf8')))
        if (
          new Set(state.packages.map(record => record.id)).size !== state.packages.length
          || Object.keys(state.receipts).length > MAX_RECEIPTS
        )
          throw new Error('Duplicate or oversized records')
        for (const record of state.packages) {
          const draft = checkedPluginBundle(record.bundle)
          if (draft.bundle.manifest.id !== record.id || draft.revision !== record.revision || draft.executionHash !== record.executionHash)
            throw new Error('Draft digest')
          if (
            record.npm
            && (record.source || (record.npm.revision === draft.revision && record.npm.version !== draft.bundle.manifest.version))
          )
            throw new Error('npm origin')
          if (
            record.catalog
            && (record.source
              || record.npm
              || (record.catalog.revision === draft.revision && record.catalog.version !== draft.bundle.manifest.version))
          )
            throw new Error('Bundled source')
          if (
            record.external
            && (record.source
              || record.npm
              || record.catalog
              || record.external.pluginId !== record.id
              || (record.external.revision === draft.revision && record.external.version !== draft.bundle.manifest.version))
          )
            throw new Error('External source')
          if (record.appliedBundle) {
            const applied = checkedPluginBundle(record.appliedBundle)
            if (
              applied.bundle.manifest.id !== record.id
              || applied.revision !== record.appliedRevision
              || (applied.executionHash && !record.trusted.includes(applied.executionHash))
            )
              throw new Error('Untrusted applied snapshot')
            checkAppliedOrigin(record.appliedOrigin, applied.bundle.manifest.version, record)
          } else if (record.appliedRevision || record.appliedOrigin || record.enabled || record.history?.length)
            throw new Error('Missing applied snapshot')
          for (const entry of record.history ?? []) {
            const earlier = checkedPluginBundle(entry.bundle)
            if (
              earlier.bundle.manifest.id !== record.id
              || earlier.revision !== entry.revision
              || (earlier.executionHash && !record.trusted.includes(earlier.executionHash))
            )
              throw new Error('Untrusted earlier snapshot')
            checkAppliedOrigin(entry.origin, earlier.bundle.manifest.version, record)
          }
        }
      } finally {
        await fd.close()
      }
    } catch (cause) {
      if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'))
        throw new AppError(500, 'plugin-package-corrupt', '插件记录无法读取，原文件已保留。')
      await writeFileAtomic(path, JSON.stringify(state) + '\n')
    }
    return new PluginAssets(directory, state, options)
  }
  private certain(): void {
    if (this.pending) throw new AppError(503, 'plugin-package-write-unknown', '插件修改结果尚未确认，请重试原来的修改。')
  }
  list(): PluginAssetRecord[] {
    this.certain()
    return structuredClone(this.state.packages)
  }
  descriptors(): PluginAssetDescriptor[] {
    this.certain()
    return this.state.packages.map(describePluginAsset)
  }
  has(id: string): boolean {
    return this.state.packages.some(record => record.id === id)
  }
  get(id: string): PluginAssetRecord {
    this.certain()
    return structuredClone(this.find(this.state, id))
  }
  replay(id: string, operation: Operation, requestId: string, payload: unknown, actor: PluginAssetActor): PluginAssetMutation | undefined {
    actor.authorize()
    rid.parse(requestId)
    if (this.pending) return undefined
    const receipt = this.state.receipts[sha256Hex(canonicalJson([actor.actor.deviceId, requestId]))]
    if (!receipt) return undefined
    if (receipt.hash !== sha256Hex(canonicalJson([operation, id, payload])))
      throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
    return this.mutationResult(id, receipt, true, true)
  }
  private mutationResult(
    id: string,
    receipt: z.infer<typeof receiptSchema> | undefined,
    audited: boolean,
    replay: boolean,
  ): PluginAssetMutation {
    const record = this.state.packages.find(item => item.id === id)
    if (receipt?.reviewedInstallId && (!record || installIdOf(record) !== receipt.reviewedInstallId))
      throw new AppError(410, 'plugin-package-removed', '这次修改已完成，原插件后来已被删除。')
    const adopt = receipt?.adopt
    const adoptOwner =
      record && adopt && record.appliedRevision === adopt.revision && installIdOf(record) === adopt.installId ? adopt.installId : undefined
    return {
      record: structuredClone(record),
      audited,
      ...(replay ? { replay: true } : {}),
      ...(receipt?.imported ? { importedRevision: receipt.imported.revision } : {}),
      ...(adoptOwner ? { adoptOwner } : {}),
    }
  }
  /** Only the same device/request can recover a candidate whose durable commit was uncertain. */
  candidate(id: string, revision: string, requestId: string, actor: PluginAssetActor): PluginAssetRecord {
    actor.authorize()
    idSchema.parse(id)
    hash.parse(revision)
    rid.parse(requestId)
    const key = sha256Hex(canonicalJson([actor.actor.deviceId, requestId]))
    const trustKey = sha256Hex(canonicalJson([actor.actor.deviceId, pluginTrustRequestId(requestId)]))
    if (this.pending && (![key, trustKey].includes(this.pending.key) || this.pending.id !== id)) this.certain()
    const record = this.find(this.pending?.state ?? this.state, id)
    if (record.revision !== revision) throw new AppError(409, 'plugin-package-changed', '插件草稿已变化，请重新检查后应用。')
    return structuredClone(record)
  }
  pendingAdoption(id: string, revision: string, requestId: string, actor: PluginAssetActor): boolean {
    actor.authorize()
    if (!this.pending || this.pending.id !== id) return false
    const key = sha256Hex(canonicalJson([actor.actor.deviceId, requestId]))
    return this.pending.key === key && this.pending.state.receipts[key]?.adopt?.revision === revision
  }
  checkReview(id: string, binding: PluginReviewBinding): void {
    if (binding.reviewedInstallId !== undefined || binding.baseAppliedRevision !== undefined)
      assertReviewBinding(this.find(this.state, id), binding)
  }
  private find(state: State, id: string): PluginAssetRecord {
    const record = state.packages.find(record => record.id === id)
    if (!record) throw new AppError(404, 'plugin-package-not-found', '找不到这个自定义插件。')
    return record
  }
  private async publish(pending: Pending): Promise<void> {
    try {
      await writeFileAtomic(join(this.directory, 'assets.json'), JSON.stringify(pending.state) + '\n', { fs: this.options.atomicFs })
    } catch {
      this.pending = pending
      throw new AppError(503, 'plugin-package-write-unknown', '插件修改结果尚未确认，请重试同一次修改。')
    }
    this.state = pending.state
    this.pending = undefined
  }
  private change(
    id: string,
    operation: Operation,
    requestId: string,
    payload: unknown,
    actor: PluginAssetActor,
    mutate: (state: State) => void,
    effect?: Effect,
    reviewed?: { adoptsData?: true; reviewedInstallId?: string },
  ): Promise<PluginAssetMutation> {
    const operationPromise = this.tail
      .catch(() => {})
      .then(async () => {
        actor.authorize()
        idSchema.parse(id)
        rid.parse(requestId)
        const key = sha256Hex(canonicalJson([actor.actor.deviceId, requestId])),
          intentHash = sha256Hex(canonicalJson([operation, id, payload]))
        const result = (audited: boolean, replay = false) => this.mutationResult(id, this.state.receipts[key], audited, replay)
        if (this.pending) {
          const pending = this.pending
          if (pending.key !== key) this.certain()
          if (pending.hash !== intentHash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
          // Retrying an uncertain apply must reactivate its candidate before publishing; a previous candidate was rolled back.
          if (effect) await effect(pending.state, () => this.publish(pending))
          else await this.publish(pending)
          return result(pending.audited, true)
        }
        const receipt = this.state.receipts[key]
        if (receipt) {
          if (receipt.hash !== intentHash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
          return result(true, true)
        }
        if (Object.keys(this.state.receipts).length >= MAX_RECEIPTS)
          throw new AppError(429, 'plugin-package-receipt-limit', '插件修改回执已满，请在电脑上整理记录。')
        const next = structuredClone(this.state)
        mutate(next)
        const imported = operation === 'import' ? this.find(next, id) : undefined
        const downloaded =
          operation === 'npm-stage' || operation === 'catalog-stage' || operation === 'external-stage'
            ? installIdOf(this.find(next, id))
            : undefined
        const adopting = reviewed?.adoptsData ? this.find(next, id) : undefined
        next.receipts[key] = {
          hash: intentHash,
          id,
          ...(imported ? { imported: { revision: imported.revision, installId: installIdOf(imported) } } : {}),
          ...(downloaded ? { downloaded } : {}),
          ...(reviewed?.reviewedInstallId ? { reviewedInstallId: reviewed.reviewedInstallId } : {}),
          ...(adopting?.appliedRevision ? { adopt: { revision: adopting.appliedRevision, installId: installIdOf(adopting) } } : {}),
        }
        stateSchema.parse(next)
        if (Buffer.byteLength(JSON.stringify(next)) > LIMIT)
          throw new AppError(413, 'plugin-package-storage-limit', '插件资产达到 64 MiB 上限。')
        let audited = true
        try {
          await this.options.audit.append({
            action: 'plugin.package.changed',
            actor: actor.actor,
            target: id,
            detail: {
              operation,
              before: sha256Hex(canonicalJson(this.state.packages.find(item => item.id === id) ?? null)),
              after: sha256Hex(canonicalJson(next.packages.find(item => item.id === id) ?? null)),
            },
          })
        } catch (cause) {
          if (operation !== 'delete' && operation !== 'disable') throw cause
          audited = false
        }
        actor.authorize()
        const pending = { state: next, key, hash: intentHash, id, audited }
        if (effect) await effect(next, () => this.publish(pending))
        else await this.publish(pending)
        return result(audited)
      })
    this.tail = operationPromise
    return operationPromise
  }

  /** The exact device/request can finish the original write with the bytes already captured, even if its source is gone. */
  replayNpm(input: PluginNpmStage, actor: PluginAssetActor): Promise<PluginAssetMutation | undefined> {
    return this.replayDownload('npm-stage', input.requestId, npmPayload(input), actor)
  }

  replayCatalog(input: PluginCatalogStage, actor: PluginAssetActor): Promise<PluginAssetMutation | undefined> {
    return this.replayDownload('catalog-stage', input.requestId, catalogPayload(input), actor)
  }

  replayExternal(input: PluginExternalStage, actor: PluginAssetActor): Promise<PluginAssetMutation | undefined> {
    return this.replayDownload('external-stage', input.requestId, externalStagePayload(input), actor)
  }

  private async replayDownload(
    operation: DownloadOperation,
    requestId: string,
    payload: unknown,
    actor: PluginAssetActor,
  ): Promise<PluginAssetMutation | undefined> {
    actor.authorize()
    const key = sha256Hex(canonicalJson([actor.actor.deviceId, requestId]))
    if (this.pending && this.pending.key !== key) this.certain()
    const state = this.pending?.state ?? this.state
    const receipt = state.receipts[key]
    if (!receipt) return undefined
    if (!receipt.downloaded || receipt.hash !== sha256Hex(canonicalJson([operation, receipt.id, payload])))
      throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
    const record = state.packages.find(candidate => candidate.id === receipt.id)
    if (!record || receipt.downloaded !== installIdOf(record))
      throw new AppError(410, 'plugin-package-removed', '这次下载已完成，原插件后来已被删除。')
    if (this.pending) return this.change(record.id, operation, requestId, payload, actor, () => {})
    return { record: structuredClone(record), audited: true, replay: true }
  }

  checkNpmStage(input: PluginNpmStage): void {
    this.certain()
    if (input.update) checkNpmUpdate(this.find(this.state, input.update.pluginId), input)
    else if (this.state.packages.some(record => matchesNpmOrigin(record, input.release)))
      throw new AppError(409, 'plugin-package-exists', '这个 npm 包已下载，请打开现有插件。')
  }

  stageNpm(
    input: PluginNpmStage,
    downloaded: ReturnType<typeof checkedPluginBundle>,
    actor: PluginAssetActor,
  ): Promise<PluginAssetMutation> {
    const { bundle, revision, executionHash } = downloaded,
      id = bundle.manifest.id
    if (input.revision !== revision) throw new AppError(409, 'plugin-package-changed', '仓库插件内容已变化，请重新预览。')
    if (input.update && input.update.pluginId !== id)
      throw new AppError(409, 'plugin-npm-source-mismatch', 'npm 新版本的插件标识与已下载版本不同。')
    return this.change(id, 'npm-stage', input.requestId, npmPayload(input), actor, state => {
      const npm = { ...input.release, revision }
      if (input.update) {
        const existing = this.find(state, id)
        checkNpmUpdate(existing, input)
        if (existing.appliedRevision && !existing.appliedOrigin)
          existing.appliedOrigin = pluginReviewSource(existing, existing.appliedRevision)
        Object.assign(existing, { bundle, revision, npm })
        if (executionHash) existing.executionHash = executionHash
        else delete existing.executionHash
        return
      }
      if (state.packages.some(record => record.id === id || matchesNpmOrigin(record, input.release)))
        throw new AppError(409, 'plugin-package-exists', '这个标识已被现有草稿或插件使用，请打开现有插件。')
      if (state.packages.length >= 64) throw new AppError(409, 'plugin-package-limit', '最多保存 64 个自定义插件。')
      state.packages.push({
        id,
        bundle,
        revision,
        npm,
        ...(executionHash ? { executionHash } : {}),
        enabled: false,
        trusted: [],
        installId: randomBytes(16).toString('base64url'),
      })
    })
  }
  stageCatalog(
    input: PluginCatalogStage,
    candidate: ReturnType<typeof checkedPluginBundle>,
    actor: PluginAssetActor,
  ): Promise<PluginAssetMutation> {
    const { bundle, revision, executionHash } = candidate
    const id = input.pluginId
    if (input.revision !== revision || bundle.manifest.id !== id)
      throw new AppError(409, 'plugin-package-changed', '随附插件内容已变化，请重新预览。')
    return this.change(id, 'catalog-stage', input.requestId, catalogPayload(input), actor, state => {
      const existing = state.packages.find(record => record.id === id)
      const catalog = { revision, version: bundle.manifest.version }
      if (input.update) {
        if (!existing || existing.revision !== input.update.baseRevision || installIdOf(existing) !== input.update.installId)
          throw new AppError(409, 'plugin-package-changed', '插件草稿或安装记录已变化，请重新预览。')
        const status = catalogUpdate(candidate, describePluginAsset(existing))
        if (status !== 'available') throw catalogUpdateError(status)
        if (existing.appliedRevision && !existing.appliedOrigin)
          existing.appliedOrigin = pluginReviewSource(existing, existing.appliedRevision)
        Object.assign(existing, { bundle, revision, catalog })
        if (executionHash) existing.executionHash = executionHash
        else delete existing.executionHash
        return
      }
      if (existing) throw catalogUpdateError('different-source')
      if (state.packages.length >= 64) throw new AppError(409, 'plugin-package-limit', '最多保存 64 个自定义插件。')
      state.packages.push({
        id,
        bundle,
        revision,
        catalog,
        ...(executionHash ? { executionHash } : {}),
        enabled: false,
        trusted: [],
        installId: randomBytes(16).toString('base64url'),
      })
    })
  }

  stageExternal(
    input: PluginExternalStage,
    release: PluginExternalRelease,
    candidate: ReturnType<typeof checkedPluginBundle>,
    actor: PluginAssetActor,
  ): Promise<PluginAssetMutation> {
    const { bundle, revision, executionHash } = candidate
    if (input.revision !== revision || bundle.manifest.id !== release.pluginId || bundle.manifest.version !== release.version)
      throw new AppError(409, 'plugin-package-changed', '插件来源的内容已变化，请重新预览。')
    const id = bundle.manifest.id
    const external = { ...release, revision }
    return this.change(id, 'external-stage', input.requestId, externalStagePayload(input), actor, state => {
      const existing = state.packages.find(record => record.id === id)
      if (input.update) {
        if (!existing || existing.revision !== input.update.baseRevision || installIdOf(existing) !== input.update.installId)
          throw new AppError(409, 'plugin-package-changed', '插件草稿或安装记录已变化，请重新预览。')
        const status = externalUpdate(external, describePluginAsset(existing))
        if (status !== 'available') throw externalUpdateError(status)
        if (existing.appliedRevision && !existing.appliedOrigin)
          existing.appliedOrigin = pluginReviewSource(existing, existing.appliedRevision)
        Object.assign(existing, { bundle, revision, external })
        if (executionHash) existing.executionHash = executionHash
        else delete existing.executionHash
        return
      }
      if (existing) throw externalUpdateError('different-source')
      if (state.packages.length >= 64) throw new AppError(409, 'plugin-package-limit', '最多保存 64 个自定义插件。')
      state.packages.push({
        id,
        bundle,
        revision,
        external,
        ...(executionHash ? { executionHash } : {}),
        enabled: false,
        trusted: [],
        installId: randomBytes(16).toString('base64url'),
      })
    })
  }
  save(bundleInput: unknown, requestId: string, actor: PluginAssetActor, baseRevision?: string): Promise<PluginAssetMutation> {
    const { bundle, revision, executionHash } = checkedPluginBundle(bundleInput),
      id = bundle.manifest.id
    return this.change(
      id,
      baseRevision === undefined ? 'create' : 'save',
      requestId,
      { revision, baseRevision: baseRevision ?? null },
      actor,
      state => {
        const existing = state.packages.find(record => record.id === id)
        if (baseRevision === undefined) {
          if (existing) throw new AppError(409, 'plugin-package-exists', '这个插件标识已存在。')
          if (state.packages.length >= 64) throw new AppError(409, 'plugin-package-limit', '最多保存 64 个自定义插件。')
          state.packages.push({
            id,
            bundle,
            revision,
            ...(executionHash ? { executionHash } : {}),
            enabled: false,
            trusted: [],
            installId: randomBytes(16).toString('base64url'),
          })
        } else {
          if (!existing || existing.revision !== baseRevision)
            throw new AppError(409, 'plugin-package-changed', '插件草稿已变化，请刷新后再保存。')
          Object.assign(existing, { bundle, revision })
          if (executionHash) existing.executionHash = executionHash
          else delete existing.executionHash
        }
      },
    )
  }
  /**
   * Settle a retry from the saved intent before looking at the session's live files. A lost response must not require
   * an Agent to keep the original files on disk. A pending import publishes only its already-audited, captured state.
   */
  async replayImport(
    sessionId: string,
    kind: 'app' | 'plugin',
    requestId: string,
    actor: PluginAssetActor,
  ): Promise<PluginAssetMutation | undefined> {
    actor.authorize()
    rid.parse(requestId)
    const key = sha256Hex(canonicalJson([actor.actor.deviceId, requestId]))
    if (this.pending && this.pending.key !== key) this.certain()
    const state = this.pending?.state ?? this.state
    const receipt = state.receipts[key]
    if (!receipt) return undefined
    const record = state.packages.find(candidate => candidate.id === receipt.id)
    // Before the revision was recorded on the receipt, accept only versions its original digest can prove. When a
    // later edit left none of them here, the old path can still match the draft read from the original source.
    const candidates = receipt.imported
      ? [receipt.imported.revision]
      : [record?.revision, record?.appliedRevision, ...(record?.history?.map(item => item.revision) ?? [])]
    const revision = candidates.find(
      value => value && receipt.hash === sha256Hex(canonicalJson(['import', receipt.id, importPayload(value, sessionId, kind)])),
    )
    if (!revision) {
      if (this.pending || receipt.imported) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同的导入。')
      return undefined
    }
    if (!record || (receipt.imported && receipt.imported.installId !== installIdOf(record)))
      throw new AppError(410, 'plugin-package-removed', '这次导入已完成，原插件后来已被删除。')
    if (this.pending) return this.importDraft(record.bundle, sessionId, requestId, actor, kind)
    return { record: structuredClone(record), importedRevision: revision, audited: true, replay: true }
  }

  /**
   * A page draft read from a session (`app-import.ts`): a new record, or a new draft revision of one that came from a
   * session before. A record made another way keeps its draft; the draft's `id` must change.
   */
  importDraft(
    bundleInput: unknown,
    sessionId: string,
    requestId: string,
    actor: PluginAssetActor,
    kind: 'app' | 'plugin' = 'app',
  ): Promise<PluginAssetMutation> {
    const { bundle, revision, executionHash } = checkedPluginBundle(bundleInput),
      id = bundle.manifest.id
    if (kind === 'app' && executionHash)
      throw new AppError(400, 'app-import-code', '应用草稿只能有页面；Host 模块与面板请用插件的高级导入。')
    const source = { sessionId, dev: false, ...(kind === 'plugin' ? { kind } : {}) }
    return this.change(id, 'import', requestId, importPayload(revision, sessionId, kind), actor, state => {
      const existing = state.packages.find(record => record.id === id)
      if (!existing) {
        if (state.packages.length >= 64) throw new AppError(409, 'plugin-package-limit', '最多保存 64 个自定义插件。')
        state.packages.push({
          id,
          bundle,
          revision,
          enabled: false,
          trusted: [],
          installId: randomBytes(16).toString('base64url'),
          source,
          ...(executionHash ? { executionHash } : {}),
        })
        return
      }
      if (!existing.source || (existing.source.kind ?? 'app') !== kind || (kind === 'plugin' && existing.source.sessionId !== sessionId))
        throw new AppError(409, 'plugin-package-exists', '这个标识已被其他草稿或插件使用，请在声明里换一个 id。')
      Object.assign(existing, { bundle, revision })
      if (executionHash) existing.executionHash = executionHash
      else delete existing.executionHash
      if (existing.source.sessionId !== sessionId) existing.source = source
    })
  }
  /**
   * Turns 开发中 off wherever this device turned it on: it was removed, or can no longer stand behind the work. Recorded
   * as the Host acting for that device.
   */
  async stopDev(deviceId: string): Promise<number> {
    const ids = this.state.packages.filter(record => record.source?.dev && record.source.devDevice === deviceId).map(record => record.id)
    const actor: PluginAssetActor = { actor: { deviceId, listener: 'host' }, authorize: () => {} }
    for (const id of ids)
      await this.change(id, 'dev', randomUUID(), { dev: false, stopped: deviceId }, actor, state => {
        const record = this.find(state, id)
        if (record.source?.devDevice === deviceId) record.source = { sessionId: record.source.sessionId, dev: false }
      })
    return ids.length
  }
  /** Turns 开发中 on or off for a draft imported from a session. */
  setDev(id: string, dev: boolean, requestId: string, actor: PluginAssetActor): Promise<PluginAssetMutation> {
    return this.change(id, 'dev', requestId, { dev }, actor, state => {
      const record = this.find(state, id)
      if (!record.source || record.source.kind === 'plugin')
        throw new AppError(409, 'app-draft-no-source', '自动构建只用于从会话导入的隔离页面。')
      record.source = { sessionId: record.source.sessionId, dev, ...(dev ? { devDevice: actor.actor.deviceId } : {}) }
    })
  }
  trust(id: string, executionHash: string, requestId: string, actor: PluginAssetActor): Promise<PluginAssetMutation> {
    hash.parse(executionHash)
    actor.authorize()
    const known = this.state.packages.find(record => record.id === id)
    if (known?.trusted.includes(executionHash)) return Promise.resolve({ record: structuredClone(known), audited: true, replay: true })
    return this.change(id, 'trust', requestId, { executionHash }, actor, state => {
      const record = this.find(state, id)
      if (record.executionHash !== executionHash) throw new AppError(409, 'plugin-package-changed', '插件的可执行内容已变化，请重新检查。')
      if (record.trusted.includes(executionHash)) return
      if (record.trusted.length >= 128) throw new AppError(429, 'plugin-package-trust-limit', '这个插件的已批准版本达到上限。')
      record.trusted.push(executionHash)
    })
  }
  /**
   * `approve`: the page capabilities a confirmation just covered; without it the draft's pages must ask for no more than
   * what was approved before.
   */
  apply(
    id: string,
    revision: string,
    requestId: string,
    actor: PluginAssetActor,
    effect: Effect,
    approve?: AppSet,
    binding?: PluginReviewBinding,
    adoptsData?: true,
  ): Promise<PluginAssetMutation> {
    return this.change(
      id,
      'apply',
      requestId,
      pluginApplyPayload(revision, binding),
      actor,
      state => {
        const record = this.find(state, id)
        assertReviewBinding(record, binding)
        if (record.revision !== revision) throw new AppError(409, 'plugin-package-changed', '插件草稿已变化，请重新检查后应用。')
        if (record.executionHash && !record.trusted.includes(record.executionHash))
          throw new AppError(403, 'plugin-package-untrusted', '请先在这台电脑上批准插件的可执行内容。')
        this.publishApplied(state, record, revision, structuredClone(record.bundle), pluginReviewSource(record, revision, true), approve)
      },
      effect,
      { adoptsData, reviewedInstallId: binding?.reviewedInstallId },
    )
  }
  /** Applies an earlier applied snapshot again; the draft is left as it is. */
  rollback(
    id: string,
    revision: string,
    requestId: string,
    actor: PluginAssetActor,
    effect: Effect,
    approve?: AppSet,
    binding?: PluginReviewBinding,
    adoptsData?: true,
  ): Promise<PluginAssetMutation> {
    return this.change(
      id,
      'rollback',
      requestId,
      pluginApplyPayload(revision, binding),
      actor,
      state => {
        const record = this.find(state, id)
        assertReviewBinding(record, binding)
        const earlier = record.history?.find(entry => entry.revision === revision)
        if (!earlier) throw new AppError(404, 'plugin-package-revision-not-found', '找不到这个已应用过的版本。')
        const checked = checkedPluginBundle(earlier.bundle)
        if (checked.executionHash && !record.trusted.includes(checked.executionHash))
          throw new AppError(403, 'plugin-package-untrusted', '请先在这台电脑上批准插件的可执行内容。')
        const origin = pluginReviewSource(record, revision)
        record.history = record.history!.filter(entry => entry.revision !== revision)
        this.publishApplied(state, record, revision, structuredClone(earlier.bundle), origin, approve)
      },
      effect,
      { adoptsData, reviewedInstallId: binding?.reviewedInstallId },
    )
  }
  /** A rollback's target snapshot; like `candidate`, only the same device/request recovers an uncertain commit. */
  rollbackCandidate(
    id: string,
    revision: string,
    requestId: string,
    actor: PluginAssetActor,
  ): { bundle: PluginPackageBundle; record: PluginAssetRecord } {
    actor.authorize()
    idSchema.parse(id)
    hash.parse(revision)
    rid.parse(requestId)
    const key = sha256Hex(canonicalJson([actor.actor.deviceId, requestId]))
    if (this.pending && (this.pending.key !== key || this.pending.id !== id)) this.certain()
    const record = this.find(this.pending?.state ?? this.state, id)
    if (this.pending && record.appliedRevision === revision && record.appliedBundle)
      return { bundle: structuredClone(record.appliedBundle), record: structuredClone(record) }
    const entry = record.history?.find(item => item.revision === revision)
    if (!entry) throw new AppError(404, 'plugin-package-revision-not-found', '找不到这个已应用过的版本。')
    return { bundle: structuredClone(entry.bundle), record: structuredClone(record) }
  }
  private publishApplied(
    state: State,
    record: PluginAssetRecord,
    revision: string,
    bundle: PluginPackageBundle,
    origin: z.infer<typeof originSchema>,
    approve?: AppSet,
  ): void {
    if (approve) record.approvedApps = structuredClone(approve)
    if (!withinApproved(capabilitySet(bundle.manifest), record.approvedApps))
      throw new AppError(403, 'plugin-package-capabilities', '页面要求的能力还没有在这台电脑上确认。')
    if (record.appliedBundle && record.appliedRevision && record.appliedRevision !== revision)
      record.history = [
        { revision: record.appliedRevision, bundle: record.appliedBundle, origin: pluginReviewSource(record, record.appliedRevision) },
        ...(record.history ?? []).filter(entry => entry.revision !== record.appliedRevision && entry.revision !== revision),
      ].slice(0, ROLLBACK_REVISIONS)
    record.appliedBundle = bundle
    record.appliedRevision = revision
    record.appliedOrigin = origin
    record.enabled = true
    if (!record.history?.length) delete record.history
    // Earlier snapshots give way to the asset budget before an apply would be refused for it.
    while (record.history?.length && Buffer.byteLength(JSON.stringify(state)) > LIMIT) {
      record.history.pop()
      if (!record.history.length) delete record.history
    }
  }
  setEnabled(
    id: string,
    enabled: boolean,
    requestId: string,
    actor: PluginAssetActor,
    effect: Effect,
    binding?: PluginReviewBinding,
  ): Promise<PluginAssetMutation> {
    return this.change(
      id,
      enabled ? 'enable' : 'disable',
      requestId,
      pluginEnablePayload(enabled, binding),
      actor,
      state => {
        const record = this.find(state, id)
        if (enabled) assertReviewBinding(record, binding)
        if (!record.appliedBundle) throw new AppError(409, 'plugin-package-not-applied', '请先应用这个插件。')
        record.enabled = enabled
      },
      effect,
      enabled ? { reviewedInstallId: binding?.reviewedInstallId } : undefined,
    )
  }
  remove(id: string, revision: string, requestId: string, actor: PluginAssetActor, effect: Effect): Promise<PluginAssetMutation> {
    return this.change(
      id,
      'delete',
      requestId,
      { revision },
      actor,
      state => {
        if (this.find(state, id).revision !== revision)
          throw new AppError(409, 'plugin-package-changed', '插件草稿已变化，请刷新后再删除。')
        state.packages = state.packages.filter(record => record.id !== id)
      },
      effect,
    )
  }
  /** A unique private generation avoids both mutable-source races and Node ESM cache aliases. */
  async materialize(record: PluginAssetRecord): Promise<{ path: string; release: () => Promise<void> }> {
    const bundle = record.appliedBundle ?? record.bundle,
      checked = checkedPluginBundle(bundle)
    if (checked.bundle.manifest.host?.length) {
      const bytes = Buffer.byteLength(JSON.stringify(checked.bundle))
      if (this.importedBytes + bytes > LIMIT)
        throw new AppError(409, 'plugin-package-import-limit', '本次 Host 运行已导入 64 MiB 插件版本，请正常重启 Host 后再应用。')
      this.importedBytes += bytes
    }
    const parent = join(this.directory, 'generations')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const temporary = join(parent, '.' + randomUUID()),
      final = join(parent, record.id + '-' + checked.revision + '-' + randomUUID())
    await mkdir(temporary, { mode: 0o700 })
    try {
      const directories = new Set([temporary])
      for (const file of [{ path: 'latch-plugin.json', content: JSON.stringify(checked.bundle.manifest) }, ...checked.bundle.files]) {
        const path = join(temporary, file.path)
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        for (let current = dirname(path); current.startsWith(temporary); current = dirname(current)) {
          directories.add(current)
          if (current === temporary) break
        }
        const fd = await open(path, 'wx', 0o600)
        try {
          await fd.writeFile(file.content)
          await fd.sync()
        } finally {
          await fd.close()
        }
      }
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) await syncDirectory(directory)
      await rename(temporary, final)
      await syncDirectory(parent)
      return { path: final, release: () => rm(final, { recursive: true, force: true }) }
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true })
      await rm(final, { recursive: true, force: true })
      throw cause
    }
  }
  async close(): Promise<void> {
    await this.tail.catch(() => {})
  }
}
