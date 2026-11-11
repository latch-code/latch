import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { AppDataDocument, AppDataStatus, AppMigrationLease } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, syncDirectory, writeFileAtomic, type AtomicWriteFs } from '@latch/core/node-kit'

export const APP_DATA_DIR = 'plugin-data'
export const DOCUMENT_BYTES = 256 * 1024
export const PLUGIN_BYTES = 16 * 1024 * 1024
export const PLUGIN_DOCUMENTS = 2000
/** Generations kept per plugin: a rollback returns to the newest one of its data version. */
export const GENERATIONS_KEPT = 3
export const LEASE_MS = 60_000
const RECEIPTS = 2000
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** The file holds the documents, their receipts and some JSON around them. */
const FILE_LIMIT = PLUGIN_BYTES * 2 + 4 * 1024 * 1024

const pluginId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)
const plainText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(value => !/[\u0000-\u001f\u007f]/u.test(value), '不能包含控制字符')
export const scopeSchema = z.union([
  z.literal('plugin'),
  z.string().regex(/^project:[A-Za-z0-9_-]{1,64}$/u),
  z
    .string()
    .startsWith('session:')
    .max(8 + 256)
    .refine(value => value.length > 8 && !/[\u0000-\u001f\u007f]/u.test(value), '会话标识无效'),
])
export const keySchema = plainText(256)
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
const hex = z.string().regex(/^[a-f0-9]{64}$/u)
const documentSchema = z.strictObject({
  scope: scopeSchema,
  key: keySchema,
  version: z.number().int().min(1),
  value: z.unknown(),
  updatedAt: isoTime,
})
const ownerSchema = z.strictObject({ version: z.literal(1), owner: z.string().regex(/^[A-Za-z0-9_-]{22}$/u) })
const receiptSchema = z.strictObject({ key: hex, hash: hex, version: z.number().int().min(0), at: isoTime })
const fileSchema = z.strictObject({
  version: z.literal(1),
  generation: z.number().int().min(1),
  dataVersion: z.number().int().min(1),
  documents: z.array(documentSchema).max(PLUGIN_DOCUMENTS),
  receipts: z.array(receiptSchema).max(RECEIPTS),
})

export type ScopeKind = 'plugin' | 'project' | 'session'
export function scopeKind(scope: string): ScopeKind {
  return scope === 'plugin' ? 'plugin' : scope.startsWith('project:') ? 'project' : 'session'
}

interface Document {
  scope: string
  key: string
  version: number
  value: unknown
  updatedAt: string
  bytes: number
}
interface Generation {
  n: number
  dataVersion: number
  documents: Map<string, Document>
  receipts: Map<string, { hash: string; version: number; at: string }>
}
interface Lease {
  id: string
  deviceId: string
  fromGeneration: number
  toVersion: number
  expiresAt: number
  /** The documents handed out; every other one is carried into the new generation as it is. */
  handed: Set<string>
}
interface PluginData {
  /** The plugin record whose data this is (`owner.json`); absent before anything was written. */
  owner?: string
  generations: Generation[]
}
/** Which plugin record a call is for: its ID and its identity. */
export interface DataOwner {
  id: string
  owner: string
}

/** A write's outcome: `version` 0 for a removal; `replay` when an earlier request with this ID already did it. */
export interface DataWrite {
  version: number
  replay?: true
}

export interface AppDataOptions {
  now?: () => number
  atomicFs?: AtomicWriteFs
  /** Reads one private file; tests slow a read down to interleave it with a write. */
  readFile?: (path: string, limit?: number) => Promise<string>
}

const docKey = (scope: string, key: string) => `${scope}\u0000${key}`
function valueBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '')
}
function finiteJson(value: unknown): void {
  const stack = [{ value, depth: 0 }]
  let visited = 0
  while (stack.length) {
    const item = stack.pop()!
    if (++visited > 200_000 || item.depth > 64) throw new AppError(400, 'invalid-input', '数据过于复杂。')
    if (item.value === null || typeof item.value === 'string' || typeof item.value === 'boolean') continue
    if (typeof item.value === 'number' && Number.isFinite(item.value)) continue
    if (typeof item.value !== 'object') throw new AppError(400, 'invalid-input', '只能保存有限的 JSON 数据。')
    for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 })
  }
}

/** Plugins whose documents stay in memory between calls; the least recently used beyond this are dropped. */
export const CACHED_PLUGINS = 8

/**
 * Plugin pages' documents, `plugin-data/<pluginId>/gen-<n>/data.json` (directories 0700, files 0600, atomic writes). A
 * generation belongs to one data version; which one is in use follows the applied code's version, so a rollback finds
 * its older generation again and a newer one waits for the code to move forward. `owner.json` names the plugin record
 * the data belongs to: a plugin created again under a deleted one's ID starts without it unless it adopts it.
 */
export class AppDataStore {
  private readonly plugins = new Map<string, PluginData>()
  private readonly leases = new Map<string, Lease>()
  private readonly queues = new Map<string, Promise<unknown>>()
  /** Sessions deleted while their documents could not be removed; retried on the next removal. */
  private readonly unremoved = new Set<string>()
  private readonly now: () => number
  private constructor(
    readonly directory: string,
    private readonly options: AppDataOptions,
  ) {
    this.now = options.now ?? Date.now
  }

  static async open(dataDir: string, options: AppDataOptions = {}): Promise<AppDataStore> {
    const directory = join(dataDir, APP_DATA_DIR)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await privateDirectory(directory)
    return new AppDataStore(directory, options)
  }

  /** One operation at a time per plugin; a failure does not block the next. */
  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation)
    const settled = run.then(
      () => {},
      () => {},
    )
    this.queues.set(id, settled)
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id)
    })
    return run
  }

  /** Plugins in memory, at most `CACHED_PLUGINS`; the disk stays the record, so a dropped one is read again. */
  cached(): string[] {
    return [...this.plugins.keys()]
  }

  private remember(id: string, data: PluginData): void {
    this.plugins.delete(id)
    this.plugins.set(id, data)
    for (const name of this.plugins.keys()) {
      if (this.plugins.size <= CACHED_PLUGINS) break
      if (name !== id && !this.queues.has(name)) this.plugins.delete(name)
    }
  }

  /** Bumped by every change to a plugin's data and every drop from memory: a read that started before is stale. */
  private readonly epochs = new Map<string, number>()
  private bump(id: string): void {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1)
  }

  private async load(id: string): Promise<PluginData> {
    pluginId.parse(id)
    for (;;) {
      const known = this.plugins.get(id)
      if (known) {
        this.remember(id, known)
        return known
      }
      const epoch = this.epochs.get(id) ?? 0
      const data = await this.read(id)
      // A copy cached or a change made while this read was on its way is newer than what it read.
      const cached = this.plugins.get(id)
      if (cached) {
        this.remember(id, cached)
        return cached
      }
      if ((this.epochs.get(id) ?? 0) !== epoch) continue
      this.remember(id, data)
      return data
    }
  }

  private async read(id: string): Promise<PluginData> {
    const readFile = this.options.readFile ?? readPrivate
    const root = join(this.directory, id)
    let names: string[] = []
    try {
      await privateDirectory(root)
      names = await readdir(root)
    } catch (cause) {
      if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw corrupt()
    }
    let owner: string | undefined
    if (names.includes('owner.json')) {
      try {
        owner = ownerSchema.parse(JSON.parse(await readFile(join(root, 'owner.json'), 4096))).owner
      } catch {
        throw corrupt()
      }
    }
    const generations: Generation[] = []
    for (const name of names) {
      const match = /^gen-([1-9]\d{0,8})$/u.exec(name)
      if (!match) continue
      const n = Number(match[1])
      await privateDirectory(join(root, name))
      let text: string
      try {
        text = await readFile(join(root, name, 'data.json'))
      } catch (cause) {
        // A generation whose first write never landed holds nothing.
        if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') continue
        throw corrupt()
      }
      let file: ReturnType<typeof fileSchema.safeParse>
      try {
        file = fileSchema.safeParse(JSON.parse(text))
      } catch {
        throw corrupt()
      }
      if (!file.success || file.data.generation !== n) throw corrupt()
      generations.push({
        n,
        dataVersion: file.data.dataVersion,
        documents: new Map(
          file.data.documents.map(document => [docKey(document.scope, document.key), { ...document, bytes: valueBytes(document.value) }]),
        ),
        receipts: new Map(file.data.receipts.map(({ key, ...receipt }) => [key, receipt])),
      })
    }
    generations.sort((a, b) => a.n - b.n)
    // Data written before owners existed belongs to nobody, so it is never handed to a record by its ID alone.
    return { ...(owner ? { owner } : generations.length ? { owner: '' } : {}), generations }
  }

  /** The plugin's data for this record; another record's kept data is refused until this one adopts it. */
  private async own(plugin: DataOwner): Promise<PluginData> {
    const data = await this.load(plugin.id)
    if (data.owner !== undefined && data.owner !== plugin.owner)
      throw new AppError(409, 'app-data-unclaimed', '这些数据属于之前删除的同名插件。')
    return data
  }

  /** `none`: nothing stored; `own`: this record's; `other`: kept from a deleted plugin with the same ID. */
  async claim(plugin: DataOwner): Promise<'none' | 'own' | 'other'> {
    const data = await this.load(plugin.id)
    if (data.owner === undefined) return 'none'
    return data.owner === plugin.owner ? 'own' : 'other'
  }

  /** Hands kept data to a new record, after a confirmation that said so. */
  adopt(plugin: DataOwner): Promise<void> {
    return this.serial(plugin.id, async () => {
      const data = await this.load(plugin.id)
      if (data.owner === plugin.owner || data.owner === undefined) return
      await this.writeOwner(plugin)
      data.owner = plugin.owner
      this.bump(plugin.id)
      this.leases.delete(plugin.id)
    })
  }

  private async writeOwner(plugin: DataOwner): Promise<void> {
    const root = join(this.directory, plugin.id)
    await mkdir(root, { recursive: true, mode: 0o700 })
    await privateDirectory(root)
    await writeFileAtomic(join(root, 'owner.json'), JSON.stringify({ version: 1, owner: plugin.owner }) + '\n', {
      fs: this.options.atomicFs,
    })
  }

  private activeLease(id: string): Lease | undefined {
    const lease = this.leases.get(id)
    if (lease && lease.expiresAt <= this.now()) this.leases.delete(id)
    return this.leases.get(id)
  }

  /** The generation the applied code uses, and what the page may do with it. */
  private select(id: string, data: PluginData, codeVersion: number): { generation?: Generation; status: AppDataStatus['status'] } {
    const { generations } = data
    // A lease is for the code it migrates to; code rolled back meanwhile keeps its own generation writable.
    const leased = this.activeLease(id)?.toVersion === codeVersion
    const same = generations.filter(item => item.dataVersion === codeVersion).at(-1)
    if (same) return { generation: same, status: leased ? 'migrating' : 'ready' }
    if (!generations.length) return { status: 'ready' }
    if (generations.every(item => item.dataVersion < codeVersion))
      return { generation: generations.at(-1), status: leased ? 'migrating' : 'needs-migration' }
    return { status: 'data-newer' }
  }

  async status(plugin: DataOwner, codeVersion: number): Promise<AppDataStatus> {
    const data = await this.own(plugin)
    const { generation, status } = this.select(plugin.id, data, codeVersion)
    return {
      generation: generation?.n ?? 0,
      ...(generation ? { dataVersion: generation.dataVersion } : {}),
      codeVersion,
      status,
      documents: generation?.documents.size ?? 0,
      bytes: generation ? [...generation.documents.values()].reduce((sum, item) => sum + item.bytes, 0) : 0,
    }
  }

  private readable(id: string, data: PluginData, codeVersion: number): Generation | undefined {
    const { generation, status } = this.select(id, data, codeVersion)
    if (status === 'needs-migration') throw new AppError(409, 'app-data-migration-required', '数据需要先更新到这个版本。')
    if (status === 'data-newer') throw new AppError(409, 'app-data-newer', '数据比这个版本新。')
    return generation
  }

  /** The sessions whose documents the generation in use holds: a migration hands out only what a device may read. */
  async sessionScopes(plugin: DataOwner, codeVersion: number): Promise<string[]> {
    const { generation } = this.select(plugin.id, await this.own(plugin), codeVersion)
    const sessions = new Set<string>()
    for (const item of generation?.documents.values() ?? []) if (scopeKind(item.scope) === 'session') sessions.add(item.scope.slice(8))
    return [...sessions]
  }

  async list(plugin: DataOwner, codeVersion: number, scope: string): Promise<AppDataDocument[]> {
    scopeSchema.parse(scope)
    const generation = this.readable(plugin.id, await this.own(plugin), codeVersion)
    return [...(generation?.documents.values() ?? [])].filter(item => item.scope === scope).map(publicDocument)
  }

  async get(plugin: DataOwner, codeVersion: number, scope: string, key: string): Promise<AppDataDocument | undefined> {
    scopeSchema.parse(scope)
    keySchema.parse(key)
    const document = this.readable(plugin.id, await this.own(plugin), codeVersion)?.documents.get(docKey(scope, key))
    return document ? publicDocument(document) : undefined
  }

  /** `ifVersion` 0: the document must not exist yet. A retry with the same request ID answers the first result. */
  put(
    plugin: DataOwner,
    codeVersion: number,
    deviceId: string,
    input: { scope: string; key: string; requestId: string; ifVersion: number; value: unknown },
  ): Promise<DataWrite> {
    return this.write(plugin, codeVersion, deviceId, input, 'put')
  }

  remove(
    plugin: DataOwner,
    codeVersion: number,
    deviceId: string,
    input: { scope: string; key: string; requestId: string; ifVersion: number },
  ): Promise<DataWrite> {
    return this.write(plugin, codeVersion, deviceId, { ...input, value: undefined }, 'delete')
  }

  private async write(
    plugin: DataOwner,
    codeVersion: number,
    deviceId: string,
    input: { scope: string; key: string; requestId: string; ifVersion: number; value: unknown },
    operation: 'put' | 'delete',
  ): Promise<DataWrite> {
    scopeSchema.parse(input.scope)
    keySchema.parse(input.key)
    if (operation === 'put') {
      finiteJson(input.value)
      if (input.value === undefined || valueBytes(input.value) > DOCUMENT_BYTES)
        throw new AppError(413, 'app-data-too-large', '一个文档最多 256 KiB。')
    }
    const id = plugin.id
    const receiptKey = sha256Hex(canonicalJson([deviceId, input.requestId]))
    const intent = sha256Hex(
      canonicalJson([
        operation,
        input.scope,
        input.key,
        input.ifVersion,
        operation === 'put' ? sha256Hex(canonicalJson(input.value)) : null,
      ]),
    )
    return this.serial(id, async () => {
      const data = await this.own(plugin)
      const selected = this.select(id, data, codeVersion)
      const receipt = selected.generation?.receipts.get(receiptKey)
      if (receipt) {
        if (receipt.hash !== intent) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
        return { version: receipt.version, replay: true }
      }
      if (selected.status === 'migrating') throw new AppError(409, 'app-data-migrating', '数据正在更新，暂时只能查看。')
      const generation = this.readable(id, data, codeVersion) ?? {
        n: 1,
        dataVersion: codeVersion,
        documents: new Map(),
        receipts: new Map(),
      }
      const key = docKey(input.scope, input.key)
      const current = generation.documents.get(key)
      if ((current?.version ?? 0) !== input.ifVersion)
        throw new AppError(409, 'app-data-conflict', '数据已被修改，请重新读取。', { version: current?.version ?? 0 })
      if (operation === 'delete' && !current) throw new AppError(404, 'not-found', '找不到这个文档。')
      const documents = new Map(generation.documents)
      let version = 0
      if (operation === 'put') {
        version = (current?.version ?? 0) + 1
        documents.set(key, {
          scope: input.scope,
          key: input.key,
          version,
          value: structuredClone(input.value),
          updatedAt: new Date(this.now()).toISOString(),
          bytes: valueBytes(input.value),
        })
        if (documents.size > PLUGIN_DOCUMENTS) throw new AppError(409, 'app-data-limit', '这个插件最多保存 2,000 个文档。')
        if ([...documents.values()].reduce((sum, item) => sum + item.bytes, 0) > PLUGIN_BYTES)
          throw new AppError(409, 'app-data-limit', '这个插件最多保存 16 MiB 数据。')
      } else documents.delete(key)
      const receipts = this.receiptsWith(generation.receipts, receiptKey, { hash: intent, version, at: new Date(this.now()).toISOString() })
      if (data.owner === undefined) {
        try {
          await this.writeOwner(plugin)
        } catch {
          this.plugins.delete(id)
          this.bump(id)
          throw new AppError(503, 'app-data-write-unknown', '数据保存结果未知，请用同一个请求重试。')
        }
        data.owner = plugin.owner
      }
      await this.publish(id, data, { ...generation, documents, receipts })
      return { version }
    })
  }

  private receiptsWith(
    receipts: Generation['receipts'],
    key: string,
    receipt: { hash: string; version: number; at: string },
  ): Generation['receipts'] {
    const oldest = this.now() - RECEIPT_TTL_MS
    const next = new Map([...receipts].filter(([, item]) => Date.parse(item.at) >= oldest))
    next.set(key, receipt)
    while (next.size > RECEIPTS) next.delete(next.keys().next().value!)
    return next
  }

  /** In memory only after the file is in place; a failed write drops the cache, so the next read sees the disk. */
  private async publish(id: string, data: PluginData, generation: Generation): Promise<void> {
    const root = join(this.directory, id),
      folder = join(root, `gen-${generation.n}`)
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 })
      await privateDirectory(root)
      await privateDirectory(folder)
      await writeFileAtomic(join(folder, 'data.json'), serialize(generation) + '\n', { fs: this.options.atomicFs })
      await syncDirectory(root)
    } catch {
      this.plugins.delete(id)
      this.bump(id)
      throw new AppError(503, 'app-data-write-unknown', '数据保存结果未知，请用同一个请求重试。')
    }
    this.bump(id)
    const index = data.generations.findIndex(item => item.n === generation.n)
    if (index === -1) data.generations.push(generation)
    else data.generations[index] = generation
    data.generations.sort((a, b) => a.n - b.n)
  }

  /**
   * One migration per plugin at a time. The holder's device gets the documents `handOut` allows (its page's scopes, and
   * sessions it may read); the rest stay on the Host and go into the new generation unchanged.
   */
  async lease(plugin: DataOwner, codeVersion: number, deviceId: string, handOut: (scope: string) => boolean): Promise<AppMigrationLease> {
    return this.serial(plugin.id, async () => {
      const data = await this.own(plugin)
      const held = this.activeLease(plugin.id)
      if (held && held.deviceId !== deviceId) throw new AppError(409, 'app-data-migrating', '另一台设备正在更新数据。')
      const { generation, status } = this.select(plugin.id, data, codeVersion)
      if (!generation || (status !== 'needs-migration' && status !== 'migrating'))
        throw new AppError(409, 'app-data-current', '数据不需要更新。')
      const documents = [...generation.documents.values()].filter(item => handOut(item.scope))
      const lease: Lease = {
        id: randomBytes(16).toString('base64url'),
        deviceId,
        fromGeneration: generation.n,
        toVersion: codeVersion,
        expiresAt: this.now() + LEASE_MS,
        handed: new Set(documents.map(item => docKey(item.scope, item.key))),
      }
      this.leases.set(plugin.id, lease)
      return {
        lease: lease.id,
        fromGeneration: generation.n,
        fromVersion: generation.dataVersion,
        toVersion: codeVersion,
        expiresAt: new Date(lease.expiresAt).toISOString(),
        documents: documents.map(publicDocument),
      }
    })
  }

  /**
   * Commits a migration as a new generation in one write: the page's documents, and every document the lease did not
   * hand out, carried as it is. `before` runs once everything is checked (the audit); the oldest generations beyond the
   * last three are then removed.
   */
  migrate(
    plugin: DataOwner,
    codeVersion: number,
    deviceId: string,
    input: {
      requestId: string
      lease: string
      fromGeneration: number
      toVersion: number
      documents: Array<{ scope: string; key: string; value: unknown }>
    },
    before: (change: { fromGeneration: number; toGeneration: number; fromVersion: number; documents: number }) => Promise<void>,
  ): Promise<{ generation: number; replay?: true }> {
    const id = plugin.id
    const receiptKey = sha256Hex(canonicalJson([deviceId, input.requestId]))
    const intent = sha256Hex(canonicalJson(['migrate', input.fromGeneration, input.toVersion, sha256Hex(canonicalJson(input.documents))]))
    return this.serial(id, async () => {
      const data = await this.own(plugin)
      const done = data.generations.find(item => item.receipts.get(receiptKey))
      if (done) {
        if (done.receipts.get(receiptKey)!.hash !== intent) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
        return { generation: done.n, replay: true }
      }
      const lease = this.activeLease(id)
      if (!lease || lease.id !== input.lease || lease.deviceId !== deviceId)
        throw new AppError(409, 'app-data-lease-lost', '数据更新的租约已失效，请重新打开页面。')
      const from = data.generations.find(item => item.n === input.fromGeneration)
      if (!from || lease.fromGeneration !== from.n || input.toVersion !== codeVersion || lease.toVersion !== codeVersion)
        throw new AppError(409, 'app-data-lease-lost', '数据或页面版本已变化，请重新打开页面。')
      const at = new Date(this.now()).toISOString()
      const documents = new Map<string, Document>()
      // What the device never saw goes on as it was; the page cannot overwrite it.
      for (const [key, item] of from.documents)
        if (!lease.handed.has(key)) documents.set(key, { ...item, version: 1, value: structuredClone(item.value), updatedAt: at })
      let bytes = [...documents.values()].reduce((sum, item) => sum + item.bytes, 0)
      for (const item of input.documents) {
        scopeSchema.parse(item.scope)
        keySchema.parse(item.key)
        finiteJson(item.value)
        const size = valueBytes(item.value)
        if (item.value === undefined || size > DOCUMENT_BYTES) throw new AppError(413, 'app-data-too-large', '一个文档最多 256 KiB。')
        bytes += size
        const key = docKey(item.scope, item.key)
        if (documents.has(key)) throw new AppError(400, 'invalid-input', '文档不能重复，也不能改动没有交给页面的文档。')
        documents.set(key, { scope: item.scope, key: item.key, version: 1, value: structuredClone(item.value), updatedAt: at, bytes: size })
      }
      if (documents.size > PLUGIN_DOCUMENTS) throw new AppError(409, 'app-data-limit', '这个插件最多保存 2,000 个文档。')
      if (bytes > PLUGIN_BYTES) throw new AppError(409, 'app-data-limit', '这个插件最多保存 16 MiB 数据。')
      const n = (data.generations.at(-1)?.n ?? 0) + 1
      await before({ fromGeneration: from.n, toGeneration: n, fromVersion: from.dataVersion, documents: documents.size })
      await this.publish(id, data, {
        n,
        dataVersion: codeVersion,
        documents,
        receipts: new Map([[receiptKey, { hash: intent, version: 0, at }]]),
      })
      this.leases.delete(id)
      for (const old of data.generations.slice(0, Math.max(0, data.generations.length - GENERATIONS_KEPT))) {
        await rm(join(this.directory, id, `gen-${old.n}`), { recursive: true, force: true })
        data.generations = data.generations.filter(item => item !== old)
      }
      return { generation: n }
    })
  }

  /**
   * Removes deleted sessions' documents from every generation of every plugin and returns which plugins changed. A
   * plugin whose write fails does not stop the others; its sessions are tried again with the next removal.
   */
  async removeSession(sessionId: string): Promise<Array<{ pluginId: string; documents: Array<{ scope: string; key: string }> }>> {
    const sessions = [...new Set([sessionId, ...this.unremoved])].filter(id => scopeSchema.safeParse(`session:${id}`).success)
    let ids: string[] = []
    try {
      ids = (await readdir(this.directory)).filter(name => pluginId.safeParse(name).success)
    } catch {
      for (const id of sessions) this.unremoved.add(id)
      return []
    }
    const changed: Array<{ pluginId: string; documents: Array<{ scope: string; key: string }> }> = []
    const failed = new Set<string>()
    for (const id of ids)
      try {
        await this.serial(id, async () => {
          const data = await this.load(id)
          const keys = new Map<string, { scope: string; key: string }>()
          for (const generation of data.generations.slice()) {
            const scopes = new Set(sessions.map(item => `session:${item}`))
            const gone = [...generation.documents.values()].filter(item => scopes.has(item.scope))
            if (!gone.length) continue
            await this.publish(id, data, {
              ...generation,
              documents: new Map([...generation.documents].filter(([, item]) => !scopes.has(item.scope))),
            })
            for (const item of gone) keys.set(docKey(item.scope, item.key), { scope: item.scope, key: item.key })
          }
          if (keys.size) changed.push({ pluginId: id, documents: [...keys.values()] })
        })
      } catch {
        for (const item of sessions) failed.add(item)
      }
    this.unremoved.clear()
    for (const item of failed) this.unremoved.add(item)
    return changed
  }

  /** Every generation of a plugin, when its owner deletes it with its data. Returns how many documents went. */
  async removePlugin(id: string): Promise<number> {
    return this.serial(id, async () => {
      const data = await this.load(id).catch(() => undefined)
      const count = data?.generations.reduce((sum, item) => sum + item.documents.size, 0) ?? 0
      await rm(join(this.directory, id), { recursive: true, force: true })
      this.forget(id)
      return count
    })
  }

  /** Drops a plugin from memory (deleted, its data kept on disk); the disk is read again if it comes back. */
  forget(id: string): void {
    this.plugins.delete(id)
    this.bump(id)
    this.leases.delete(id)
  }

  /** Diagnostics and other per-plugin files live beside the generations. */
  pluginDirectory(id: string): string {
    pluginId.parse(id)
    return join(this.directory, id)
  }

  async close(): Promise<void> {
    await Promise.all(this.queues.values())
  }
}

function publicDocument(document: Document): AppDataDocument {
  return {
    scope: document.scope,
    key: document.key,
    version: document.version,
    value: structuredClone(document.value),
    updatedAt: document.updatedAt,
  }
}

function serialize(generation: Generation): string {
  return JSON.stringify({
    version: 1,
    generation: generation.n,
    dataVersion: generation.dataVersion,
    documents: [...generation.documents.values()].map(({ bytes: _bytes, ...document }) => document),
    receipts: [...generation.receipts].map(([key, receipt]) => ({ key, ...receipt })),
  })
}

function corrupt(): AppError {
  return new AppError(500, 'app-data-corrupt', '插件数据无法读取，原文件已保留。')
}

/** A directory of this user's alone, not a link. */
export async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  const uid = process.getuid?.()
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || (uid !== undefined && info.uid !== uid))
    throw new AppError(500, 'app-data-private', '插件数据目录必须只有本人可访问。')
}

/** Reads a private regular file without following a link. */
export async function readPrivate(path: string, limit = FILE_LIMIT): Promise<string> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await fd.stat()
    const uid = process.getuid?.()
    if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.size > limit || (uid !== undefined && info.uid !== uid))
      throw new Error('Invalid private file')
    return await fd.readFile('utf8')
  } finally {
    await fd.close()
  }
}
