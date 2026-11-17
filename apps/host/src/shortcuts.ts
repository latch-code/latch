import { renameSync } from 'node:fs'
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  SHORTCUT_ACTIONS,
  SHORTCUT_CLIENTS,
  SHORTCUTS_SCHEMA,
  shortcutsIssues,
  type ShortcutsDocument,
  type ShortcutsReceipt,
  type ShortcutsState,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, syncDirectory, writeFileAtomic } from '@latch/core/node-kit'

/*
 * 快捷键 (docs/CUSTOMIZATION.md#快捷键): each device's own key bindings, one document per device with a revision and
 * receipts. A document is data (action names and key chords); the Host checks it with the page's rules and refuses,
 * never corrects. A device reads and writes only its own.
 */

const hex64 = z.string().regex(/^[a-f0-9]{64}$/u)
const storedDocument = z.strictObject({
  schema: z.literal(SHORTCUTS_SCHEMA),
  client: z.enum(SHORTCUT_CLIENTS),
  bindings: z.partialRecord(z.enum(SHORTCUT_ACTIONS), z.string().max(32)),
})
const receiptSchema = z.strictObject({ key: hex64, body: hex64, applied: z.number().int().min(0) })
const RECEIPT_LIMIT = 16
/** More devices than a Host keeps registered; the oldest entries go first. */
export const SHORTCUT_DEVICE_LIMIT = 256
const deviceId = z.string().regex(/^dev_[A-Za-z0-9_-]{22}$/u)
const entrySchema = z.strictObject({
  revision: z.number().int().min(1),
  at: z.string().datetime(),
  doc: storedDocument.nullable(),
  receipts: z.array(receiptSchema).max(RECEIPT_LIMIT),
})
const fileSchema = z.strictObject({
  version: z.literal(1),
  devices: z.record(deviceId, entrySchema),
})
type StoredFile = z.infer<typeof fileSchema>
type StoredEntry = z.infer<typeof entrySchema>
const FILE = 'shortcuts.json'

/** A document a device sent, or the refusal that names its first problem. */
export function checkedShortcuts(value: unknown): ShortcutsDocument {
  const issues = shortcutsIssues(value)
  if (issues.length > 0)
    throw new AppError(400, 'shortcuts-invalid', issues[0]!.message, { issues: issues.slice(0, 16), field: issues[0]!.field })
  return storedDocument.parse(value) as ShortcutsDocument
}

export type ShortcutsChange = { kind: 'apply'; doc: unknown } | { kind: 'reset' }

export class ShortcutsStore {
  private pending: { state: StoredFile; deviceId: string; key: string; body: string; applied: number } | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private constructor(
    private readonly path: string,
    private data: StoredFile,
    private readonly now: () => number,
  ) {}

  /**
   * Opens the bindings. Entries of devices the Host no longer lists (`known`) are dropped. A file that cannot be read is
   * moved aside (0600) and every device starts on the defaults; it never stops the Host.
   */
  static async open(
    dataDir: string,
    options: { now?: () => number; log?: (text: string) => void; known?: (deviceId: string) => boolean } = {},
  ): Promise<ShortcutsStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const path = join(dataDir, FILE)
    const now = options.now ?? Date.now
    let data: StoredFile = { version: 1, devices: {} }
    try {
      const read = fileSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      for (const entry of Object.values(read.devices))
        if (entry.doc && shortcutsIssues(entry.doc).length > 0) throw new Error('A document fails the rules')
      data = read
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        const aside = `${FILE}.unreadable-${new Date(now()).toISOString().replace(/[^0-9TZ]/gu, '')}`
        try {
          await rename(path, join(dataDir, aside))
          await chmod(join(dataDir, aside), 0o600)
          options.log?.(`快捷键文件无法使用，各设备按默认快捷键启动；原文件保留为 ${aside}。`)
        } catch {
          options.log?.('快捷键文件无法使用，各设备按默认快捷键启动；原文件没能改名，下一次修改会覆盖它。')
        }
      }
    }
    if (options.known) {
      const known = options.known
      data = { version: 1, devices: Object.fromEntries(Object.entries(data.devices).filter(([id]) => known(id))) }
    }
    return new ShortcutsStore(path, data, now)
  }

  state(deviceId: string): ShortcutsState {
    const entry = this.data.devices[deviceId]
    return entry ? { revision: entry.revision, doc: structuredClone(entry.doc) as ShortcutsDocument | null } : { revision: 0, doc: null }
  }

  /** One device's write: a replayed request gets its first answer, a write over a newer revision is refused. */
  write(
    input: { deviceId: string; requestId: string; baseRevision: number; change: ShortcutsChange },
    authorize: () => void = () => {},
  ): Promise<ShortcutsReceipt> {
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        authorize()
        const key = sha256Hex(canonicalJson(['shortcuts', input.deviceId, input.requestId]))
        const body = sha256Hex(canonicalJson([input.baseRevision, input.change as never]))
        const entry = this.data.devices[input.deviceId]
        const answered = entry?.receipts.find(receipt => receipt.key === key)
        const receiptOf = (applied: number, replayed: boolean): ShortcutsReceipt => ({
          ...this.state(input.deviceId),
          requestId: input.requestId,
          applied,
          replayed,
        })
        if (answered) {
          if (answered.body !== body) throw new AppError(409, 'request-id-reused', '这个请求编号已用于另一次修改。')
          return receiptOf(answered.applied, true)
        }
        // Another device's write left unknown is on disk already (renamed, only the folder's sync unconfirmed): this
        // write builds on it, and its own save makes both durable, so one device's unknown never blocks another's.
        if (this.pending && this.pending.deviceId !== input.deviceId) {
          this.data = this.pending.state
          this.pending = undefined
        }
        if (this.pending) {
          const pending = this.pending
          if (pending.key !== key) throw new AppError(503, 'shortcuts-write-pending', '上一次快捷键修改结果未知，本次没有提交。')
          if (pending.body !== body) throw new AppError(409, 'request-id-reused', '这个请求编号已用于另一次修改。')
          try {
            await syncDirectory(dirname(this.path))
          } catch {
            throw writeUnknown()
          }
          this.data = pending.state
          this.pending = undefined
          authorize()
          return receiptOf(pending.applied, true)
        }
        const current = this.state(input.deviceId)
        if (input.baseRevision !== current.revision)
          throw new AppError(409, 'shortcuts-conflict', '快捷键已在别处修改，请重新读取。', { revision: current.revision })
        const doc = input.change.kind === 'apply' ? checkedShortcuts(input.change.doc) : null
        const empty = (value: ShortcutsDocument | null) => value === null || Object.keys(value.bindings).length === 0
        const changed = empty(doc) && empty(current.doc) ? false : canonicalJson(doc) !== canonicalJson(current.doc)
        const revision = changed ? current.revision + 1 : current.revision
        // Nothing changes: nothing is written, and a replay gets the same answer from the same state.
        if (!changed) return receiptOf(current.revision, false)
        const receipt = { key, body, applied: revision }
        const next: StoredEntry = {
          revision,
          at: changed ? new Date(this.now()).toISOString() : entry!.at,
          doc: changed ? doc : (entry!.doc ?? null),
          receipts: [...(entry?.receipts ?? []), receipt].slice(-RECEIPT_LIMIT),
        }
        // Most recently written last, so the oldest entries are the ones dropped past the limit.
        const devices = { ...this.data.devices }
        delete devices[input.deviceId]
        devices[input.deviceId] = next
        const ids = Object.keys(devices)
        for (const id of ids.slice(0, Math.max(0, ids.length - SHORTCUT_DEVICE_LIMIT))) delete devices[id]
        await this.save({ version: 1, devices }, { deviceId: input.deviceId, key, body, applied: revision }, authorize)
        return receiptOf(revision, false)
      })
    this.tail = operation
    return operation
  }

  private async save(
    state: StoredFile,
    pending: { deviceId: string; key: string; body: string; applied: number } | undefined,
    authorize: () => void,
  ): Promise<void> {
    let renamed = false
    try {
      await writeFileAtomic(this.path, `${JSON.stringify(state)}\n`, {
        prefix: 'shortcuts.',
        fs: {
          open: (path, flags, mode) => open(path, flags, mode),
          async rename(from, to) {
            authorize()
            renameSync(from, to)
            renamed = true
          },
        },
      })
    } catch (error) {
      if (error instanceof AppError) throw error
      if (!renamed || !pending) throw new AppError(503, 'shortcuts-write-unavailable', '快捷键文件无法保存，本次没有提交。')
      this.pending = { state, ...pending }
      throw writeUnknown()
    }
    this.data = state
  }
}

const writeUnknown = () => new AppError(503, 'shortcuts-write-unknown', '快捷键修改结果尚未确认，请重试同一请求。')
