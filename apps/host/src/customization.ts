import { renameSync } from 'node:fs'
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  APPEARANCE_RADII,
  APPEARANCE_TEXT_SIZES,
  CUSTOMIZATION_REVISION_LIMIT,
  CUSTOMIZATION_SCHEMA,
  DEFAULT_CUSTOMIZATION,
  customizationIssues,
  customizedFields,
  type AppearanceField,
  type CustomizationDocument,
  type CustomizationReceipt,
  type CustomizationRevision,
  type CustomizationSource,
  type CustomizationState,
  type CustomizationView,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, syncDirectory, writeFileAtomic } from '@latch/core/node-kit'

/*
 * The Host's customisation: one document for every device, with the last revisions. A document is data (two
 * enumerations and one bounded integer); the Host checks it strictly and refuses, never corrects. Nothing here is
 * private, and nothing here is a secret, but it still goes only to devices that may read the snapshot.
 */

const hex64 = z.string().regex(/^[a-f0-9]{64}$/u)
/** The shape alone, as a saved file is read: rules that are computed (contrast, hue distance) are checked on a write. */
const storedDocument = z.strictObject({
  schema: z.literal(CUSTOMIZATION_SCHEMA),
  appearance: z.strictObject({
    accentHue: z.number().int().min(0).max(359).optional(),
    radius: z.enum(APPEARANCE_RADII).optional(),
    textSize: z.enum(APPEARANCE_TEXT_SIZES).optional(),
  }),
})
const revisionSchema = z.strictObject({
  revision: z.number().int().min(1),
  hash: hex64,
  at: z.string().datetime(),
  source: z.enum(['apply', 'restore', 'reset']),
  by: z.enum(['device', 'cli']),
  doc: storedDocument,
})
const receiptSchema = z.strictObject({ key: hex64, body: hex64, applied: z.number().int().min(0) })
const fileSchema = z.strictObject({
  version: z.literal(1),
  revisions: z.array(revisionSchema).max(CUSTOMIZATION_REVISION_LIMIT),
  receipts: z.array(receiptSchema).max(64),
})
type StoredFile = z.infer<typeof fileSchema>
type StoredReceipt = z.infer<typeof receiptSchema>
const RECEIPT_LIMIT = 64
const FILE = 'customization.json'

/** A document a device sent, or the refusal that names each field and the numbers behind it. */
export function checkedDocument(value: unknown): CustomizationDocument {
  const issues = customizationIssues(value)
  if (issues.length > 0)
    throw new AppError(400, 'customization-invalid', issues[0]!.message, { issues: issues.slice(0, 16), field: issues[0]!.field })
  // The strict schema repeats the shape check, so nothing the pure rules missed is ever saved.
  return storedDocument.parse(value)
}

export type CustomizationChange = { kind: 'apply'; doc: CustomizationDocument } | { kind: 'restore'; revision: number } | { kind: 'reset' }

interface CustomizationWriteInput {
  /** The device's ID, or `cli`: a request ID is one device's. */
  actor: string
  by: CustomizationRevision['by']
  requestId: string
  baseRevision: number
  change: CustomizationChange
}

/** What is about to be saved, for the record written before it takes effect. */
export interface PendingRevision {
  revision: number
  previous: number
  hash: string
  source: CustomizationSource
  fields: AppearanceField[]
}

export class CustomizationStore {
  private pending: { state: StoredFile; receipt: StoredReceipt } | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private constructor(
    private readonly path: string,
    private data: StoredFile,
    private readonly now: () => number,
  ) {}

  /**
   * Opens the Host's customisation. A file that cannot be read, or whose document in force no longer passes the rules
   * (the computed ones too: a rule may have tightened since it was saved), is not a reason to stop the Host or to show
   * anything but the default. It is kept: moved aside under a name that says when (0600), and reported, so nothing a
   * person saved is replaced unseen. An older revision that no longer passes stays in the history and is refused when
   * someone tries to go back to it.
   */
  static async open(dataDir: string, options: { now?: () => number; log?: (text: string) => void } = {}): Promise<CustomizationStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const path = join(dataDir, FILE)
    const empty: StoredFile = { version: 1, revisions: [], receipts: [] }
    const now = options.now ?? Date.now
    let data = empty
    try {
      const read = fileSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      const current = read.revisions.at(-1)
      if (current && customizationIssues(current.doc).length > 0) throw new Error('The document in force fails the rules')
      data = read
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        const aside = `${FILE}.unreadable-${new Date(now()).toISOString().replace(/[^0-9TZ]/gu, '')}`
        try {
          await rename(path, join(dataDir, aside))
          await chmod(join(dataDir, aside), 0o600)
          options.log?.(`自定义文件无法使用，已按默认外观启动；原文件保留为 ${aside}。`)
        } catch {
          options.log?.('自定义文件无法使用，已按默认外观启动；原文件没能改名，下一次应用会覆盖它。')
        }
      }
    }
    return new CustomizationStore(path, data, now)
  }

  state(): CustomizationState {
    const last = this.data.revisions.at(-1)
    return last ? { revision: last.revision, doc: structuredClone(last.doc) } : { revision: 0, doc: structuredClone(DEFAULT_CUSTOMIZATION) }
  }

  view(): CustomizationView {
    return { ...this.state(), revisions: structuredClone(this.data.revisions).toReversed() }
  }

  /**
   * One write. A request that was answered before is answered the same way again (and one whose ID was used for
   * something else is refused); a write over a newer revision is refused; `record` runs before anything is saved, so a
   * change whose record cannot be written does not happen unless `record` itself lets it.
   */
  write(
    input: CustomizationWriteInput,
    record: (pending: PendingRevision) => Promise<void>,
    authorize: () => void = () => {},
  ): Promise<CustomizationReceipt> {
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        authorize()
        const key = sha256Hex(canonicalJson(['customization', input.actor, input.requestId]))
        const body = sha256Hex(canonicalJson([input.baseRevision, input.change]))
        const answered = this.data.receipts.find(receipt => receipt.key === key)
        if (answered) {
          if (answered.body !== body) throw new AppError(409, 'request-id-reused', '这个请求编号已用于另一次修改。')
          return { ...this.state(), requestId: input.requestId, applied: answered.applied, replayed: true }
        }
        if (this.pending) {
          const { state, receipt } = this.pending
          if (receipt.key !== key) throw new AppError(503, 'customization-write-pending', '上一次外观修改结果未知，本次没有提交。')
          if (receipt.body !== body) throw new AppError(409, 'request-id-reused', '这个请求编号已用于另一次修改。')
          try {
            await syncDirectory(dirname(this.path))
          } catch {
            throw writeUnknown()
          }
          this.data = state
          this.pending = undefined
          authorize()
          return { ...this.state(), requestId: input.requestId, applied: receipt.applied, replayed: true }
        }
        const current = this.state()
        if (input.baseRevision !== current.revision)
          throw new AppError(409, 'customization-conflict', '外观已在别处修改，请重新读取。', { revision: current.revision })
        const change = input.change
        const kept = change.kind === 'restore' ? this.data.revisions.find(item => item.revision === change.revision)?.doc : undefined
        if (change.kind === 'restore' && !kept) throw new AppError(404, 'customization-revision-not-found', '这个版本已不在历史里。')
        // A kept revision goes through the same rules as a new document: one saved under older rules is refused.
        const doc =
          change.kind === 'apply'
            ? checkedDocument(change.doc)
            : change.kind === 'reset'
              ? structuredClone(DEFAULT_CUSTOMIZATION)
              : checkedDocument(kept)
        const hash = sha256Hex(canonicalJson(doc))
        const changed = hash !== sha256Hex(canonicalJson(current.doc))
        const revision = changed ? current.revision + 1 : current.revision
        let revisions = this.data.revisions
        if (changed) {
          const source: CustomizationSource = change.kind
          await record({ revision, previous: current.revision, hash, source, fields: customizedFields(doc) })
          const saved: CustomizationRevision = { revision, hash, at: new Date(this.now()).toISOString(), source, by: input.by, doc }
          revisions = [...revisions, saved].slice(-CUSTOMIZATION_REVISION_LIMIT)
        }
        const receipt = { key, body, applied: revision }
        await this.save({ version: 1, revisions, receipts: [...this.data.receipts, receipt].slice(-RECEIPT_LIMIT) }, receipt, authorize)
        return { ...this.state(), requestId: input.requestId, applied: revision, replayed: false }
      })
    this.tail = operation
    return operation
  }

  private async save(state: StoredFile, receipt: StoredReceipt, authorize: () => void): Promise<void> {
    let renamed = false
    try {
      await writeFileAtomic(this.path, `${JSON.stringify(state)}\n`, {
        prefix: 'customization.',
        fs: {
          open: (path, flags, mode) => open(path, flags, mode),
          async rename(from, to) {
            // The latest permission check and the file replacement cannot be interleaved with revocation.
            authorize()
            renameSync(from, to)
            renamed = true
          },
        },
      })
    } catch (error) {
      if (error instanceof AppError) throw error
      if (!renamed) throw new AppError(503, 'customization-write-unavailable', '外观文件无法保存，本次没有提交。')
      // The new file is visible but its directory entry is not confirmed durable. No other write may replace it.
      this.pending = { state, receipt }
      throw writeUnknown()
    }
    this.data = state
  }
}

const writeUnknown = () => new AppError(503, 'customization-write-unknown', '外观修改结果尚未确认，请重试同一请求。')
