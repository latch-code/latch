import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { TaskDetail } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { sha256Hex, writeFileAtomic } from '@latch/core/node-kit'
import { FOLDER_REFERENCE_LIMIT, OUTSIDE_REFERENCE_LIMIT, isOutsideKey, referenceInput, sessionReferences } from './references.ts'
import type { FileRoot } from './resolve.ts'

const LIMIT = FOLDER_REFERENCE_LIMIT + OUTSIDE_REFERENCE_LIMIT
/**
 * Part of each message's scan hash: a new scan rule (outside paths, 2026-11) makes every message read once more, so a
 * record written by an older Host learns what its rules skipped.
 */
const SCAN = 'outside-1'
const WINDOW = 4 * 1024 * 1024
const seenSchema = z.strictObject({
  id: z.string().min(1).max(256),
  hash: z.string().regex(/^[a-f0-9]{64}$/u),
  offset: z.number().int().nonnegative(),
})
const schema = z.strictObject({
  version: z.literal(1),
  roots: z.string().regex(/^[a-f0-9]{64}$/u),
  references: z.array(z.string().max(8192)).max(LIMIT),
  seen: z.array(seenSchema).max(20_000),
})

/** A bounded, durable set of paths ever mentioned in a session; the original messages remain authoritative for additions. */
export class FileReferenceStore {
  private readonly pending = new Map<string, Promise<unknown>>()
  private constructor(private readonly directory: string) {}

  static async open(dataDir: string): Promise<FileReferenceStore> {
    const directory = join(dataDir, 'file-references')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return new FileReferenceStore(directory)
  }

  references(sessionId: string, detail: TaskDetail, roots: readonly FileRoot[], home: string): Promise<Set<string>> {
    if (!this.pending.has(sessionId) && this.pending.size >= 512)
      return Promise.reject(new AppError(429, 'rate-limited', '文件引用检查繁忙，请稍后再试'))
    const operation = (this.pending.get(sessionId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.update(sessionId, detail, roots, home))
    this.pending.set(sessionId, operation)
    void operation
      .finally(() => {
        if (this.pending.get(sessionId) === operation) this.pending.delete(sessionId)
      })
      .catch(() => {})
    return operation
  }

  async remove(sessionId: string): Promise<void> {
    await this.pending.get(sessionId)?.catch(() => {})
    await rm(join(this.directory, `${sha256Hex(sessionId)}.json`), { force: true })
  }

  private async update(sessionId: string, detail: TaskDetail, roots: readonly FileRoot[], home: string): Promise<Set<string>> {
    const path = join(this.directory, `${sha256Hex(sessionId)}.json`)
    const rootsHash = sha256Hex(JSON.stringify(roots))
    let state: z.infer<typeof schema> = { version: 1, roots: rootsHash, references: [], seen: [] }
    try {
      const fd = await open(path, 'r')
      try {
        if ((await fd.stat()).size > 50 * 1024 * 1024) throw new Error('oversized')
        const loaded = schema.parse(JSON.parse(await fd.readFile('utf8')))
        if (loaded.roots === rootsHash) state = loaded
      } finally {
        await fd.close()
      }
    } catch (cause) {
      if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'))
        throw new AppError(500, 'file-references-invalid', '会话文件引用记录无法读取，请在执行端检查')
    }
    const before = JSON.stringify(state)
    const references = new Set(state.references)
    let outsides = state.references.filter(isOutsideKey).length
    let folders = references.size - outsides
    const keep = (reference: string) => {
      if (references.has(reference)) return
      if (isOutsideKey(reference) ? outsides >= OUTSIDE_REFERENCE_LIMIT : folders >= FOLDER_REFERENCE_LIMIT) return
      references.add(reference)
      if (isOutsideKey(reference)) outsides++
      else folders++
    }
    const seen = new Map(state.seen.map(entry => [entry.id, entry]))
    const ids = new Set(detail.messages.map(message => message.id))
    for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id)
    let remaining = WINDOW
    for (const message of detail.messages.toReversed()) {
      if (remaining <= 0 || references.size >= LIMIT) break
      const source = [message.text, message.tool?.input, message.tool?.output].filter(Boolean).join('\n')
      const hash = sha256Hex(
        JSON.stringify([
          SCAN,
          source,
          message.fileRefs,
          message.outputs,
          message.tool?.locations,
          message.tool?.diffs?.map(diff => diff.path),
        ]),
      )
      const previous = seen.get(message.id)
      if (previous?.hash === hash && previous.offset >= source.length) continue
      const offset = previous?.hash === hash ? previous.offset : 0
      const end = Math.min(source.length, offset + remaining)
      const text = source.slice(Math.max(0, offset - 4096), end)
      const batch = sessionReferences(
        {
          ...detail,
          messages: [
            {
              ...message,
              text,
              tool: message.tool
                ? {
                    ...message.tool,
                    input: referenceInput(message.tool.input),
                    output: undefined,
                  }
                : undefined,
            },
          ],
        },
        roots,
        home,
        WINDOW + 4096,
      )
      for (const reference of batch) keep(reference)
      remaining -= end - offset
      seen.set(message.id, { id: message.id, hash, offset: end })
    }
    if (detail.fileChanges?.runId === detail.summary.runId) {
      const batch = sessionReferences({ ...detail, messages: [] }, roots, home)
      for (const ref of batch) keep(ref)
    }
    state.references = [...references]
    state.seen = [...seen.values()].slice(-20_000)
    if (JSON.stringify(state) !== before) await writeFileAtomic(path, `${JSON.stringify(state)}\n`, { prefix: 'file-references.' })
    return references
  }
}
