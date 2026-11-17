import { randomBytes } from 'node:crypto'
import { constants, renameSync } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isIP } from 'node:net'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, syncDirectory, writeFileAtomic } from '@latch/core/node-kit'
import { OFFICIAL_RELAYS, type OfficialRelay } from './official.ts'
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
const relayId = z.string().regex(/^[a-f0-9]{32}$/u),
  hex64 = z.string().regex(/^[a-f0-9]{64}$/u),
  region = z.string().regex(/^[a-z0-9-]{1,16}$/u)
/** Further origins of an edge node: the relay-key signature, not the name, binds a connection to it. */
const extraUrls = z
  .array(endpoint)
  .min(1)
  .max(3)
  .refine(values => new Set(values).size === values.length)
/** A relay file or settings request. A self-hosted node is pinned by its TLS key; an edge node by its relay key. */
export const relayProfileInput = z
  .union([
    z.strictObject({ relayId, url: endpoint, spkiHash: hex64, registrationKey: key('lrt1').nullable().optional() }),
    z.strictObject({
      relayId,
      url: endpoint,
      kind: z.literal('edge'),
      relayKey: hex64,
      extraUrls: extraUrls.optional(),
      shard: z.int().min(0).max(15).optional(),
      registrationKey: key('lrt1').nullable().optional(),
    }),
  ])
  .refine(value => !('extraUrls' in value) || !value.extraUrls?.includes(value.url))
export type RelayProfileInput = z.infer<typeof relayProfileInput>
export const nativeDirectSchema = z.strictObject({
  host: z
    .string()
    .max(45)
    .refine(value => value === 'auto' || Boolean(isIP(value))),
  port: z.int().min(0).max(65535),
})
export type NativeDirect = z.infer<typeof nativeDirectSchema>
/**
 * A saved node. An absent `kind` is the self-hosted kind, as every profile written before the edge kind existed: those
 * entries are read unchanged and never rewritten, so their fingerprints and the configuration hash stay the same.
 */
const profileFields = z.strictObject({
  relayId,
  url: endpoint,
  spkiHash: hex64.optional(),
  kind: z.literal('edge').optional(),
  relayKey: hex64.optional(),
  extraUrls: extraUrls.optional(),
  shard: z.int().min(0).max(15).optional(),
  region: region.optional(),
  registrationKey: key('lrt1').optional(),
  seeds: z.tuple([key('lrs1'), key('lrs1')]),
  activeSlot: z.union([z.literal(0), z.literal(1)]),
  rotationDay: z.int().nonnegative(),
  rotations: z.int().min(0).max(2),
  /** Compiled in (`official.ts`); no UI edits it, and it runs only while a phone is paired and the official relay is on. */
  builtIn: z.literal(true).optional(),
  /**
   * Added with the Host stopped (`pnpm latch relay add`): kept out of address books until the node has proved its key
   * and accepted a registration at the next start, as a relay added in settings is before it is saved.
   */
  unverified: z.literal(true).optional(),
})
const kindRule = (value: { kind?: 'edge'; spkiHash?: string; relayKey?: string; extraUrls?: string[]; shard?: number; url: string }) =>
  value.kind === 'edge'
    ? value.relayKey !== undefined && value.spkiHash === undefined && !value.extraUrls?.includes(value.url)
    : value.spkiHash !== undefined && value.relayKey === undefined && value.extraUrls === undefined && value.shard === undefined
const profile = profileFields.refine(kindRule)
const receiptSchema = z.strictObject({
  requestId: z.uuid(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  cancelled: z.literal(true).optional(),
  cancelAuditFailed: z.literal(true).optional(),
})
const pendingRelaySchema = receiptSchema.omit({ cancelled: true, cancelAuditFailed: true }).extend({
  deviceId: z.string().min(1).max(128),
  profile: profileFields.omit({ builtIn: true }).refine(kindRule),
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
  /** The person turned the official relay off; absent means on. Their own relays work either way. */
  officialOff: z.literal(true).optional(),
  /** The person's own relays come before the official ones in address books; absent means official first. */
  ownFirst: z.literal(true).optional(),
  profiles: z
    .array(profile)
    .max(6)
    .refine(items => new Set(items.map(item => item.relayId)).size === items.length),
})
export type RelayProfile = z.infer<typeof profile>
/**
 * The short key hash a person compares on the confirmation sheet, in settings and on the terminal: the first 8 hex of
 * SHA-256 over the edge relay key, or of the self-hosted node's pinned SPKI hash itself.
 */
export function relayKeyHash(node: RelayNodeFields): string {
  return 'relayKey' in node ? sha256Hex(Buffer.from(node.relayKey, 'hex')).slice(0, 8) : node.spkiHash.slice(0, 8)
}
/** How link-client reaches a saved node: the pinned TLS key, or the relay key, shard and every origin. */
export function relayEndpointOf(value: RelayProfile): {
  url: URL
  relayId: Buffer
  spki?: Buffer
  edge?: { relayKey: Buffer; shard: number }
  extraUrls?: URL[]
} {
  const base = { url: new URL(value.url), relayId: Buffer.from(value.relayId, 'hex') }
  return value.kind === 'edge'
    ? {
        ...base,
        edge: { relayKey: Buffer.from(value.relayKey!, 'hex'), shard: value.shard ?? 0 },
        ...(value.extraUrls ? { extraUrls: value.extraUrls.map(url => new URL(url)) } : {}),
      }
    : { ...base, spki: Buffer.from(value.spkiHash!, 'hex') }
}
/** The node fields of a profile, without seeds or registration key: what identifies and reaches the node. */
export type RelayNodeFields =
  | { relayId: string; url: string; spkiHash: string }
  | { relayId: string; url: string; kind: 'edge'; relayKey: string; extraUrls?: string[]; shard?: number }
export function relayNodeFields(input: RelayProfileInput | RelayProfile): RelayNodeFields {
  if ('kind' in input && input.kind === 'edge')
    return {
      relayId: input.relayId,
      url: input.url,
      kind: 'edge',
      relayKey: input.relayKey!,
      ...(input.extraUrls ? { extraUrls: [...input.extraUrls] } : {}),
      ...(input.shard === undefined ? {} : { shard: input.shard }),
    }
  return { relayId: input.relayId, url: input.url, spkiHash: (input as { spkiHash: string }).spkiHash }
}
export type PendingRelay = z.infer<typeof pendingRelaySchema>
type State = z.infer<typeof schema>
const writeUnknown = () => new AppError(503, 'native-relay-write-unknown', '中继配置的保存结果尚未确认，请继续原请求。')
export function secretBytes(value: string): Buffer {
  return Buffer.from(value.slice(value.indexOf('.') + 1), 'base64url')
}

/** Secrets stay in a private Host file. Only metadata derived by the caller is suitable for an API response. */
export class RelayProfiles {
  private readonly path: string
  private state: State
  private pendingWrite?: State
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
    return this.hashConfiguration(this.state)
  }
  private hashConfiguration(state: State): string {
    return sha256Hex(
      canonicalJson({
        direct: state.direct ?? null,
        directory: state.directory ?? null,
        profiles: state.profiles,
        revision: state.configRevision ?? 0,
        // Only when set, so that a Host that never touched the switch keeps the hash it had.
        ...(state.officialOff ? { officialOff: true } : {}),
        ...(state.ownFirst ? { ownFirst: true } : {}),
      }),
    )
  }
  configReceipt(requestId: string): string | undefined {
    return this.state.configReceipts?.find(item => item.requestId === requestId)?.requestHash
  }
  relayReceipt(requestId: string): z.infer<typeof receiptSchema> | undefined {
    return this.state.configReceipts?.find(item => item.requestId === requestId)
  }
  assertNewRelay(input: Pick<RelayProfileInput, 'relayId' | 'url'>, official: readonly OfficialRelay[] = OFFICIAL_RELAYS): void {
    if (official.some(item => item.relayId === input.relayId))
      throw new AppError(409, 'native-relay-official', '这个中继标识属于官方中继，不能作为自己的中继添加。')
    const urls = (value: { url: string; extraUrls?: string[] }) => [value.url, ...(value.extraUrls ?? [])]
    const wanted = urls(input as { url: string; extraUrls?: string[] })
    if (this.state.profiles.some(profile => profile.relayId === input.relayId || urls(profile).some(url => wanted.includes(url))))
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
      const { registrationKey } = input
      return (draft.pendingRelay = {
        ...request,
        profile: {
          ...relayNodeFields(input),
          ...(registrationKey ? { registrationKey } : {}),
          seeds: [secret('lrs1'), secret('lrs1')],
          activeSlot: 0,
          rotationDay: 0,
          rotations: 0,
        },
      })
    }, authorize)
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
    }, authorize)
  }
  cancelRelay(
    requestId: string,
    authorize: () => void,
    record: (profileHash: string) => Promise<boolean>,
  ): Promise<{ cancelled: boolean; audited: boolean }> {
    return this.change(async draft => {
      authorize()
      if (draft.pendingRelay?.requestId !== requestId)
        return { cancelled: false, audited: !draft.configReceipts?.find(item => item.requestId === requestId)?.cancelAuditFailed }
      const { requestHash } = draft.pendingRelay
      const audited = await record(requestHash)
      this.keepReceipt(draft, { requestId, requestHash, cancelled: true, ...(!audited ? { cancelAuditFailed: true } : {}) })
      delete draft.pendingRelay
      return { cancelled: true, audited }
    }, authorize)
  }
  removeObserver(
    target: { relayId: string } | { directory: true },
    authorize: () => void,
    record: (detail: { before: string; after: string; relayCount: number }) => Promise<boolean>,
  ): Promise<{ audited: boolean }> {
    return this.change(async draft => {
      authorize()
      const before = this.hashConfiguration(draft)
      if ('relayId' in target) draft.profiles = draft.profiles.filter(profile => profile.builtIn || profile.relayId !== target.relayId)
      else draft.directory = null
      this.advanceConfiguration(draft)
      const audited = await record({
        before,
        after: this.hashConfiguration(draft),
        relayCount: draft.profiles.filter(profile => !profile.builtIn).length,
      })
      return { audited }
    }, authorize)
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
  settleWrite(): Promise<boolean> {
    return this.pendingWrite ? this.serial(() => this.confirmDurability()) : Promise.resolve(false)
  }
  private async confirmDurability(): Promise<boolean> {
    const pending = this.pendingWrite
    if (!pending) return false
    try {
      await syncDirectory(dirname(this.path))
    } catch {
      throw writeUnknown()
    }
    this.state = pending
    this.pendingWrite = undefined
    return true
  }
  private serial<Result>(run: () => Promise<Result>): Promise<Result> {
    const operation = this.tail.then(run)
    this.tail = operation.then(
      () => {},
      () => {},
    )
    return operation
  }
  private change<Result>(edit: (draft: State) => Result | Promise<Result>, authorize?: () => void): Promise<Result> {
    return this.serial(async () => {
      await this.confirmDurability()
      const draft = this.snapshot(),
        result = await edit(draft)
      schema.parse(draft)
      let renamed = false
      try {
        await writeFileAtomic(this.path, `${JSON.stringify(draft)}\n`, {
          fs: {
            open: (path, flags, mode) => open(path, flags, mode),
            async rename(from, to) {
              // A revocation cannot interleave with the last permission check and the irreversible replacement.
              authorize?.()
              renameSync(from, to)
              renamed = true
            },
          },
        })
      } catch (error) {
        if (!renamed) throw error
        this.pendingWrite = draft
        throw writeUnknown()
      }
      this.state = draft
      return result
    })
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
          ...relayNodeFields(item),
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
  /**
   * `pnpm latch relay add`, with the Host stopped: saved with fresh seeds but marked unverified, so no address book carries
   * it until the node has proved its key at the next start (`markVerified`).
   */
  addUnverified(input: RelayProfileInput, expectedHash: string): Promise<void> {
    const item = relayProfileInput.parse(input)
    return this.change(draft => {
      this.checkBase(expectedHash)
      this.assertNewRelay(item)
      this.advanceConfiguration(draft)
      draft.profiles.push({
        ...relayNodeFields(item),
        ...(item.registrationKey ? { registrationKey: item.registrationKey } : {}),
        seeds: [secret('lrs1'), secret('lrs1')],
        activeSlot: 0,
        rotationDay: 0,
        rotations: 0,
        unverified: true,
      })
    })
  }
  /** Brings the persisted built-in relays in line with the compiled list. Their seeds survive, and only they change. */
  syncOfficial(official: readonly OfficialRelay[]): Promise<void> {
    const wanted = official.map(item =>
      item.kind === 'edge'
        ? {
            relayId: item.relayId,
            url: item.urls[0]!,
            kind: item.kind,
            relayKey: item.relayKey,
            ...(item.urls.length > 1 ? { extraUrls: item.urls.slice(1) } : {}),
            region: item.region,
          }
        : { relayId: item.relayId, url: item.url, spkiHash: item.spkiHash },
    )
    const current = this.state.profiles
      .filter(item => item.builtIn)
      .map(({ seeds: _seeds, activeSlot: _slot, rotationDay: _day, rotations: _rotations, builtIn: _builtIn, ...node }) => node)
    if (canonicalJson(current) === canonicalJson(wanted)) return Promise.resolve()
    return this.change(draft => {
      const builtIn = wanted.map(item => {
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
  /**
   * The official relay switch and the order of preference. Off only lowers who can see traffic; on restores the default.
   */
  setOfficial(
    change: { enabled?: boolean; ownFirst?: boolean },
    authorize: () => void,
    record: (detail: { before: string; after: string; relayCount: number }) => Promise<boolean>,
  ): Promise<{ audited: boolean }> {
    return this.change(async draft => {
      authorize()
      const before = this.hashConfiguration(draft)
      if (change.enabled === true) delete draft.officialOff
      if (change.enabled === false) draft.officialOff = true
      if (change.ownFirst === true) draft.ownFirst = true
      if (change.ownFirst === false) delete draft.ownFirst
      this.advanceConfiguration(draft)
      const audited = await record({
        before,
        after: this.hashConfiguration(draft),
        relayCount: draft.profiles.filter(profile => !profile.builtIn).length,
      })
      return { audited }
    }, authorize)
  }
  /** The node proved its key and registered a route: a CLI-added relay may now enter address books. */
  markVerified(relayId: string): Promise<void> {
    if (!this.state.profiles.some(profile => profile.relayId === relayId && profile.unverified)) return Promise.resolve()
    return this.change(draft => {
      const node = draft.profiles.find(profile => profile.relayId === relayId)
      if (!node?.unverified) return
      delete node.unverified
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

/** The relays an address book offers, in the person's order of preference, at most four; never an unverified one. */
export function bookRelays(state: Pick<z.infer<typeof schema>, 'profiles' | 'officialOff' | 'ownFirst'>): RelayProfile[] {
  const official = state.officialOff ? [] : state.profiles.filter(profile => profile.builtIn),
    own = state.profiles.filter(profile => !profile.builtIn && !profile.unverified)
  return (state.ownFirst ? [...own, ...official] : [...official, ...own]).slice(0, 4)
}

/** What identifies a node's connection state: the profile without the verification mark, which only gates books. */
export function profileFingerprint(profile: RelayProfile): string {
  const { unverified: _unverified, ...rest } = profile
  return sha256Hex(canonicalJson(rest))
}
