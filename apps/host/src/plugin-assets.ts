import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { PluginPackageBundle } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, syncDirectory, writeFileAtomic, type AtomicWriteFs } from '@latch/core/node-kit'
import type { AuditActor, AuditLog } from './audit.ts'
import { checkedPluginBundle } from './plugin-package-bundle.ts'
import { appCapabilitiesSchema, capabilitySet, withinApproved, type AppSet } from './app-capabilities.ts'

const LIMIT = 64 * 1024 * 1024,
  MAX_RECEIPTS = 10000
/** Earlier applied revisions a rollback can return to; the oldest go first when the asset budget is short. */
export const ROLLBACK_REVISIONS = 5
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  hash = z.string().regex(/^[a-f0-9]{64}$/u),
  rid = z.string().min(8).max(128)
const bundleSchema = z.custom<PluginPackageBundle>(value => {
  try {
    checkedPluginBundle(value)
    return true
  } catch {
    return false
  }
})
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
  installId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{22}$/u)
    .optional(),
  /** The page capabilities this computer confirmed, by page ID: code that asks for no more applies without a confirmation. */
  approvedApps: z.record(idSchema, appCapabilitiesSchema).optional(),
  /** Earlier applied snapshots, newest first. */
  history: z
    .array(z.strictObject({ revision: hash, bundle: bundleSchema }))
    .max(ROLLBACK_REVISIONS)
    .optional(),
})
const receiptSchema = z.strictObject({ hash, id: idSchema })
const stateSchema = z.strictObject({
  version: z.literal(1),
  packages: z.array(recordSchema).max(64),
  receipts: z.record(hash, receiptSchema),
})
export type PluginAssetRecord = z.infer<typeof recordSchema>
export type PluginAssetDescriptor = Omit<PluginAssetRecord, 'bundle' | 'appliedBundle' | 'history'> & {
  name: string
  version: string
  description: string
  rollbackRevisions: Array<{ revision: string; version: string }>
}
/** A record's identity; records saved before identities existed get a fixed one derived from their ID. */
export function installIdOf(record: Pick<PluginAssetRecord, 'id' | 'installId'>): string {
  return record.installId ?? sha256Hex(canonicalJson(['plugin-install', record.id])).slice(0, 22)
}
export function describePluginAsset(record: PluginAssetRecord): PluginAssetDescriptor {
  const { bundle, appliedBundle: _, history, ...rest } = record
  return {
    ...rest,
    trusted: [...rest.trusted],
    rollbackRevisions: (history ?? []).map(entry => ({ revision: entry.revision, version: entry.bundle.manifest.version })),
    name: bundle.manifest.name,
    version: bundle.manifest.version,
    description: bundle.manifest.description,
  }
}
type State = z.infer<typeof stateSchema>
type Operation = 'create' | 'save' | 'trust' | 'apply' | 'rollback' | 'enable' | 'disable' | 'delete'
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
}
export type PluginAssetEffect = (next: { packages: PluginAssetRecord[] }, commit: () => Promise<void>) => Promise<void>
type Effect = PluginAssetEffect
export const pluginTrustRequestId = (requestId: string): string => sha256Hex(canonicalJson(['plugin-execution-trust', requestId]))

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
          if (record.appliedBundle) {
            const applied = checkedPluginBundle(record.appliedBundle)
            if (
              applied.bundle.manifest.id !== record.id
              || applied.revision !== record.appliedRevision
              || (applied.executionHash && !record.trusted.includes(applied.executionHash))
            )
              throw new Error('Untrusted applied snapshot')
          } else if (record.appliedRevision || record.enabled || record.history?.length) throw new Error('Missing applied snapshot')
          for (const entry of record.history ?? []) {
            const earlier = checkedPluginBundle(entry.bundle)
            if (
              earlier.bundle.manifest.id !== record.id
              || earlier.revision !== entry.revision
              || (earlier.executionHash && !record.trusted.includes(earlier.executionHash))
            )
              throw new Error('Untrusted earlier snapshot')
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
    return { record: structuredClone(this.state.packages.find(record => record.id === id)), audited: true, replay: true }
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
  ): Promise<PluginAssetMutation> {
    const operationPromise = this.tail
      .catch(() => {})
      .then(async () => {
        actor.authorize()
        idSchema.parse(id)
        rid.parse(requestId)
        const key = sha256Hex(canonicalJson([actor.actor.deviceId, requestId])),
          intentHash = sha256Hex(canonicalJson([operation, id, payload]))
        const result = (audited: boolean, replay = false): PluginAssetMutation => ({
          record: structuredClone(this.state.packages.find(record => record.id === id)),
          audited,
          ...(replay ? { replay: true as const } : {}),
        })
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
        next.receipts[key] = { hash: intentHash, id }
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
  ): Promise<PluginAssetMutation> {
    return this.change(
      id,
      'apply',
      requestId,
      { revision },
      actor,
      state => {
        const record = this.find(state, id)
        if (record.revision !== revision) throw new AppError(409, 'plugin-package-changed', '插件草稿已变化，请重新检查后应用。')
        if (record.executionHash && !record.trusted.includes(record.executionHash))
          throw new AppError(403, 'plugin-package-untrusted', '请先在这台电脑上批准插件的可执行内容。')
        this.publishApplied(state, record, revision, structuredClone(record.bundle), approve)
      },
      effect,
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
  ): Promise<PluginAssetMutation> {
    return this.change(
      id,
      'rollback',
      requestId,
      { revision },
      actor,
      state => {
        const record = this.find(state, id)
        const earlier = record.history?.find(entry => entry.revision === revision)
        if (!earlier) throw new AppError(404, 'plugin-package-revision-not-found', '找不到这个已应用过的版本。')
        const checked = checkedPluginBundle(earlier.bundle)
        if (checked.executionHash && !record.trusted.includes(checked.executionHash))
          throw new AppError(403, 'plugin-package-untrusted', '请先在这台电脑上批准插件的可执行内容。')
        record.history = record.history!.filter(entry => entry.revision !== revision)
        this.publishApplied(state, record, revision, structuredClone(earlier.bundle), approve)
      },
      effect,
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
  private publishApplied(state: State, record: PluginAssetRecord, revision: string, bundle: PluginPackageBundle, approve?: AppSet): void {
    if (approve) record.approvedApps = structuredClone(approve)
    if (!withinApproved(capabilitySet(bundle.manifest), record.approvedApps))
      throw new AppError(403, 'plugin-package-capabilities', '页面要求的能力还没有在这台电脑上确认。')
    if (record.appliedBundle && record.appliedRevision && record.appliedRevision !== revision)
      record.history = [
        { revision: record.appliedRevision, bundle: record.appliedBundle },
        ...(record.history ?? []).filter(entry => entry.revision !== record.appliedRevision && entry.revision !== revision),
      ].slice(0, ROLLBACK_REVISIONS)
    record.appliedBundle = bundle
    record.appliedRevision = revision
    record.enabled = true
    if (!record.history?.length) delete record.history
    // Earlier snapshots give way to the asset budget before an apply would be refused for it.
    while (record.history?.length && Buffer.byteLength(JSON.stringify(state)) > LIMIT) {
      record.history.pop()
      if (!record.history.length) delete record.history
    }
  }
  setEnabled(id: string, enabled: boolean, requestId: string, actor: PluginAssetActor, effect: Effect): Promise<PluginAssetMutation> {
    return this.change(
      id,
      enabled ? 'enable' : 'disable',
      requestId,
      { enabled },
      actor,
      state => {
        const record = this.find(state, id)
        if (!record.appliedBundle) throw new AppError(409, 'plugin-package-not-applied', '请先应用这个插件。')
        record.enabled = enabled
      },
      effect,
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
