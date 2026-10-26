import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { isIP } from 'node:net'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, writeFileAtomic } from '@latch/core/node-kit'

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
  configReceipts: z
    .array(z.strictObject({ requestId: z.uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/u) }))
    .max(32)
    .optional(),
  profiles: z
    .array(profile)
    .max(4)
    .refine(items => new Set(items.map(item => item.relayId)).size === items.length),
})
export type RelayProfile = z.infer<typeof profile>
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
      canonicalJson({ direct: this.state.direct ?? null, profiles: this.state.profiles, revision: this.state.configRevision ?? 0 }),
    )
  }
  configReceipt(requestId: string): string | undefined {
    return this.state.configReceipts?.find(item => item.requestId === requestId)?.requestHash
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
  ): Promise<void> {
    const checked = z
      .array(relayProfileInput)
      .max(4)
      .refine(items => new Set(items.map(item => item.relayId)).size === items.length)
      .parse(input)
    return this.change(draft => {
      if (expectedHash !== undefined && this.configHash() !== expectedHash)
        throw new AppError(409, 'native-config-changed', '手机连接配置已变化，请刷新后重试')
      draft.direct = direct === null ? null : nativeDirectSchema.parse(direct)
      if ((draft.configRevision ?? 0) >= Number.MAX_SAFE_INTEGER)
        throw new AppError(503, 'native-generation-exhausted', '连接配置代次已耗尽')
      draft.configRevision = (draft.configRevision ?? 0) + 1
      if (receipt)
        draft.configReceipts = [...(draft.configReceipts ?? []).filter(item => item.requestId !== receipt.requestId), receipt].slice(-32)
      draft.profiles = checked.map(item => {
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
      if (draft.generation >= Number.MAX_SAFE_INTEGER) throw new AppError(503, 'native-generation-exhausted', '连接簿代次已耗尽')
      draft.generation++
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
