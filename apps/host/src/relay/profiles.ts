import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { isIP } from 'node:net'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, writeFileAtomic } from '@latch/core/node-kit'
import type { OfficialRelay } from './official.ts'
import {
  directoryConfigSchema,
  directoryConfigHash,
  directoryFloorSchema,
  type DirectoryConfig,
  type DirectoryFloor,
} from './directory-config.ts'

const secret = (prefix: string) => `${prefix}.${randomBytes(32).toString('base64url')}`
const key = (prefix: string) => z.string().regex(new RegExp(`^${prefix}\\.[A-Za-z0-9_-]{43}$`, 'u'))
const endpoint = z
  .string()
  .max(512)
  .refine(value => {
    try {
      const url = new URL(value)
      return (
        url.protocol === 'https:'
        && !url.username
        && !url.password
        && !url.search
        && !url.hash
        && url.pathname === '/'
        && value === url.href
      )
    } catch {
      return false
    }
  })
export const relayProfileInput = z.strictObject({
  relayId: z.string().regex(/^[a-f0-9]{32}$/u),
  url: endpoint,
  spkiHash: z.string().regex(/^[a-f0-9]{64}$/u),
  registrationKey: key('lrt1').nullable().optional(),
})
export type RelayProfileInput = z.infer<typeof relayProfileInput>
export const nativeDirectSchema = z.strictObject({
  host: z
    .string()
    .max(45)
    .refine(value => value === 'auto' || Boolean(isIP(value))),
  port: z.int().min(0).max(65535),
})
export type NativeDirect = z.infer<typeof nativeDirectSchema>
const profile = relayProfileInput.omit({ registrationKey: true }).extend({
  registrationKey: key('lrt1').optional(),
  seeds: z.tuple([key('lrs1'), key('lrs1')]),
  activeSlot: z.union([z.literal(0), z.literal(1)]),
  rotationDay: z.int().nonnegative(),
  rotations: z.int().min(0).max(2),
  /** Compiled in (`official.ts`); no UI edits it, and it runs only while a phone is paired. */
  builtIn: z.literal(true).optional(),
})
const receiptSchema = z.strictObject({
  requestId: z.uuid(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  cancelled: z.literal(true).optional(),
})
const pendingRelaySchema = receiptSchema.omit({ cancelled: true }).extend({
  deviceId: z.string().min(1).max(128),
  profile: profile.omit({ builtIn: true }),
})
const schema = z.strictObject({
  version: z.literal(1),
  generation: z.int().nonnegative(),
  configRevision: z.int().nonnegative().optional(),
  discoveryKey: key('lnd1'),
  discoveryRevocationsHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  direct: nativeDirectSchema.nullable().optional(),
  directory: directoryConfigSchema.nullable().optional(),
  directoryFloor: directoryFloorSchema.optional(),
  configReceipts: z.array(receiptSchema).max(32).optional(),
  pendingRelay: pendingRelaySchema.optional(),
  profiles: z
    .array(profile)
    .max(6)
    .refine(items => new Set(items.map(item => item.relayId)).size === items.length),
})
export type RelayProfile = z.infer<typeof profile>
export type PendingRelay = z.infer<typeof pendingRelaySchema>
type State = z.infer<typeof schema>
export function secretBytes(value: string): Buffer {
  return Buffer.from(value.slice(value.indexOf('.') + 1), 'base64url')
}

/** Secrets stay in a private Host file. Only metadata derived by the caller is suitable for an API response. */
export class RelayProfiles {
  private readonly path: string
  private state: State
  private tail = Promise.resolve()
  private constructor(path: string, state: State) {
    this.path = path
    this.state = state
  }
  static async open(dataDir: string): Promise<RelayProfiles> {
    const directory = join(dataDir, 'native'),
      path = join(directory, 'relays.json')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const folder = await lstat(directory),
      uid = process.getuid?.()
    if (!folder.isDirectory() || folder.isSymbolicLink() || (folder.mode & 0o077) !== 0 || (uid !== undefined && folder.uid !== uid))
      throw new AppError(500, 'native-relay-private', '原生连接配置目录必须由当前用户持有且只有本人可访问')
    let state: State
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size > 32_768 || (info.mode & 0o077) !== 0 || (uid !== undefined && info.uid !== uid))
          throw new Error('Private relay file')
        state = schema.parse(JSON.parse(await handle.readFile('utf8')))
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new AppError(500, 'native-relay-invalid', '原生连接配置无效，原文件已保留')
      state = { version: 1, generation: 0, discoveryKey: secret('lnd1'), profiles: [] }
      await writeFileAtomic(path, `${JSON.stringify(state)}\n`)
    }
    return new RelayProfiles(path, state)
  }
  snapshot(): State {
    return structuredClone(this.state)
  }
  configHash(): string {
    return sha256Hex(
      canonicalJson({
        direct: this.state.direct ?? null,
        directory: this.state.directory ?? null,
        profiles: this.state.profiles,
        revision: this.state.configRevision ?? 0,
      }),
    )
  }
  configReceipt(requestId: string): string | undefined {
    return this.state.configReceipts?.find(item => item.requestId === requestId)?.requestHash
  }
  relayReceipt(requestId: string): z.infer<typeof receiptSchema> | undefined {
    return this.state.configReceipts?.find(item => item.requestId === requestId)
  }
  assertNewRelay(input: Pick<RelayProfileInput, 'relayId' | 'url'>): void {
    if (this.state.profiles.some(profile => profile.relayId === input.relayId || profile.url === input.url))
      throw new AppError(409, 'native-relay-duplicate', '每个中继节点只能添加一次。')
    if (this.state.profiles.filter(profile => !profile.builtIn).length >= 4)
      throw new AppError(409, 'native-relay-limit', '最多添加四个自建中继。')
  }
  /** Save the exact route seed before REGISTER, so replay after a crash uses the same relay resources. */
  reserveRelay(
    input: RelayProfileInput,
    request: Omit<PendingRelay, 'profile'>,
    base: string,
    authorize: () => void,
  ): Promise<PendingRelay> {
    return this.change(draft => {
      authorize()
      this.checkBase(base)
      this.assertNewRelay(input)
      if (draft.configReceipts?.some(receipt => receipt.requestId === request.requestId))
        throw new AppError(409, 'native-config-changed', '手机连接配置已变化，请查询原请求。')
      if (draft.pendingRelay) {
        const current = draft.pendingRelay
        if (current.requestId === request.requestId && current.requestHash === request.requestHash && current.deviceId === request.deviceId)
          return current
        throw new AppError(409, 'native-relay-pending', '请先继续或放弃未确认的中继。')
      }
      const { registrationKey, ...publicFields } = input
      return (draft.pendingRelay = {
        ...request,
        profile: {
          ...publicFields,
          ...(registrationKey ? { registrationKey } : {}),
          seeds: [secret('lrs1'), secret('lrs1')],
          activeSlot: 0,
          rotationDay: 0,
          rotations: 0,
        },
      })
    })
  }
  installRelay(pending: PendingRelay, base: string, authorize: () => void): Promise<void> {
    return this.change(draft => {
      authorize()
      this.checkBase(base)
      this.assertNewRelay(pending.profile)
      if (draft.pendingRelay?.requestId !== pending.requestId || draft.pendingRelay.requestHash !== pending.requestHash)
        throw new AppError(409, 'native-relay-cancelled', '这次中继添加已放弃。')
      draft.profiles.push(draft.pendingRelay.profile)
      delete draft.pendingRelay
      this.advanceConfiguration(draft, { requestId: pending.requestId, requestHash: pending.requestHash })
    })
  }
  cancelRelay(requestId: string, authorize: () => void): Promise<boolean> {
    return this.change(draft => {
      authorize()
      if (draft.pendingRelay?.requestId !== requestId) return false
      this.keepReceipt(draft, { requestId, requestHash: draft.pendingRelay.requestHash, cancelled: true })
      delete draft.pendingRelay
      return true
    })
  }
  private checkBase(expectedHash?: string): void {
    if (expectedHash !== undefined && this.configHash() !== expectedHash)
      throw new AppError(409, 'native-config-changed', '手机连接配置已变化，请刷新后重试')
  }
  private keepReceipt(draft: State, receipt: z.infer<typeof receiptSchema>): void {
    draft.configReceipts = [...(draft.configReceipts ?? []).filter(item => item.requestId !== receipt.requestId), receipt].slice(-32)
  }
  private advanceConfiguration(draft: State, receipt?: z.infer<typeof receiptSchema>): void {
    if ((draft.configRevision ?? 0) >= Number.MAX_SAFE_INTEGER) throw new AppError(503, 'native-generation-exhausted', '连接配置代次已耗尽')
    if (draft.generation >= Number.MAX_SAFE_INTEGER) throw new AppError(503, 'native-generation-exhausted', '连接簿代次已耗尽')
    draft.configRevision = (draft.configRevision ?? 0) + 1
    draft.generation++
    if (receipt) this.keepReceipt(draft, receipt)
  }
  private change<Result>(edit: (draft: State) => Result): Promise<Result> {
    const operation = this.tail.then(async () => {
      const draft = this.snapshot(),
        result = edit(draft)
      schema.parse(draft)
      await writeFileAtomic(this.path, `${JSON.stringify(draft)}\n`)
      this.state = draft
      return result
    })
    this.tail = operation.then(
      () => {},
      () => {},
    )
    return operation
  }
  /** The caller must obtain local OS consent and record its intent before replacing observers or their fixed values. */
  replace(input: RelayProfileInput[]): Promise<void> {
    return this.configure(this.state.direct ?? null, input)
  }
  configure(
    direct: NativeDirect | null,
    input: RelayProfileInput[],
    expectedHash?: string,
    receipt?: { requestId: string; requestHash: string },
    directory?: DirectoryConfig | null,
  ): Promise<void> {
    const checked = z
      .array(relayProfileInput)
      .max(4)
      .refine(items => new Set(items.map(item => item.relayId)).size === items.length)
      .parse(input)
    return this.change(draft => {
      this.checkBase(expectedHash)
      draft.direct = direct === null ? null : nativeDirectSchema.parse(direct)
      if (directory !== undefined) draft.directory = directory === null ? null : directoryConfigSchema.parse(directory)
      this.advanceConfiguration(draft, receipt)
      const builtIn = draft.profiles.filter(item => item.builtIn)
      const custom = checked.map(item => {
        const previous = draft.profiles.find(old => old.relayId === item.relayId)
        return {
          relayId: item.relayId,
          url: item.url,
          spkiHash: item.spkiHash,
          ...(item.registrationKey === null
            ? {}
            : item.registrationKey !== undefined
              ? { registrationKey: item.registrationKey }
              : previous?.registrationKey
                ? { registrationKey: previous.registrationKey }
                : {}),
          seeds: previous?.seeds ?? [secret('lrs1'), secret('lrs1')],
          activeSlot: previous?.activeSlot ?? 0,
          rotationDay: previous?.rotationDay ?? 0,
          rotations: previous?.rotations ?? 0,
        }
      })
      draft.profiles = [...builtIn, ...custom]
    })
  }
  /** Brings the persisted built-in relays in line with the compiled list. Their seeds survive, and only they change. */
  syncOfficial(official: readonly OfficialRelay[]): Promise<void> {
    const current = this.state.profiles.filter(item => item.builtIn)
    if (canonicalJson(current.map(({ relayId, url, spkiHash }) => ({ relayId, url, spkiHash }))) === canonicalJson(official))
      return Promise.resolve()
    return this.change(draft => {
      const builtIn = official.map(item => {
        const previous = draft.profiles.find(old => old.relayId === item.relayId && old.builtIn)
        return {
          ...item,
          seeds: previous?.seeds ?? ([secret('lrs1'), secret('lrs1')] as [string, string]),
          activeSlot: previous?.activeSlot ?? (0 as const),
          rotationDay: previous?.rotationDay ?? 0,
          rotations: previous?.rotations ?? 0,
          builtIn: true as const,
        }
      })
      draft.profiles = [
        ...builtIn,
        ...draft.profiles.filter(item => !item.builtIn && !official.some(next => next.relayId === item.relayId)),
      ]
      if (draft.generation >= Number.MAX_SAFE_INTEGER) throw new AppError(503, 'native-generation-exhausted', '连接簿代次已耗尽')
      draft.generation++
    })
  }
  /** Floors come only from verified cache evidence, never from the settings request. Keep them through source removal. */
  saveDirectoryFloor(expectedSourceHash: string, floor: DirectoryFloor): Promise<void> {
    floor = directoryFloorSchema.parse(floor)
    return this.change(draft => {
      if (expectedSourceHash !== directoryConfigHash(draft.directory))
        throw new AppError(409, 'native-directory-changed', '连接地址设置已变化，请重试')
      const previous = draft.directoryFloor
      if (previous) {
        if (floor.minimum.generation < previous.minimum.generation) throw new Error('Directory Root rollback')
        if (floor.minimum.generation === previous.minimum.generation) {
          if (floor.minimum.hash !== previous.minimum.hash) throw new Error('Directory Root conflict')
          if (previous.minimumOnline) {
            if (!floor.minimumOnline || floor.minimumOnline.generation < previous.minimumOnline.generation)
              throw new Error('Directory online rollback')
            if (
              floor.minimumOnline.generation === previous.minimumOnline.generation
              && floor.minimumOnline.hash !== previous.minimumOnline.hash
            )
              throw new Error('Directory online conflict')
          }
        }
      }
      draft.directoryFloor = floor
    })
  }
  nextGeneration(): Promise<number> {
    return this.change(draft => {
      if (draft.generation >= Number.MAX_SAFE_INTEGER) throw new AppError(503, 'native-generation-exhausted', '连接簿代次已耗尽')
      return ++draft.generation
    })
  }
  rotateDiscovery(revocationsHash: string): Promise<void> {
    return this.change(draft => {
      if (draft.discoveryRevocationsHash === revocationsHash) return
      draft.discoveryKey = secret('lnd1')
      draft.discoveryRevocationsHash = revocationsHash
    })
  }
  rotate(relayId: string, day: number): Promise<void> {
    return this.change(draft => {
      const node = draft.profiles.find(item => item.relayId === relayId)
      if (!node) throw new AppError(404, 'native-relay-missing', '中继配置已移除')
      if (node.rotationDay !== day) {
        node.rotationDay = day
        node.rotations = 0
      }
      if (node.rotations >= 2) throw new AppError(429, 'native-relay-rotation-limit', '这个中继今日已两次报告路由冲突，请在 Mac 检查')
      if (node.rotations === 0) node.activeSlot = node.activeSlot === 0 ? 1 : 0
      else {
        node.seeds = [secret('lrs1'), secret('lrs1')]
        node.activeSlot = 0
      }
      node.rotations++
      if (draft.generation >= Number.MAX_SAFE_INTEGER) throw new AppError(503, 'native-generation-exhausted', '连接簿代次已耗尽')
      draft.generation++
    })
  }
}
