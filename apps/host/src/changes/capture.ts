// Records a session's folders at one moment: each file's metadata, and its content in the project's objects. A file
// whose metadata is unchanged since the previous record keeps that entry without being read again.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileRoot } from '../files/resolve.ts'
import { hasSecretContent, isSecretPath } from '../files/secrets.ts'
import { SNIFF_BYTES } from '../files/sniff.ts'
import type { ObjectStore } from './objects.ts'
import { CHANGE_LIMIT, type Change, type Entry, type FileState, type Manifest } from './records.ts'
import { signature, splitKey, type Walk, type WalkedFile } from './walk.ts'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const PARALLEL = 16
/** Entries a later capture may reuse while the file is unchanged; the others are tried again. */
const SETTLED: ReadonlySet<FileState['kept']> = new Set(['stored', 'secret', 'large'])

export interface CaptureContext {
  objects: ObjectStore
  /** The objects' volume: a file elsewhere cannot be cloned into it. */
  storeDev: bigint
  /** Files up to this size are read and copied; larger ones are cloned. */
  copyLimit: number
  /** Files larger than this are not kept. */
  cloneLimit: number
  /** After this `Date.now()`, files are recorded without their content. */
  deadline: number
  /** Bytes the project may still add; reduced as content is added. */
  room: { bytes: number }
  now: () => number
}

const digestOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function readExactly(handle: FileHandle, size: number): Promise<Uint8Array | undefined> {
  // One byte more than expected shows a file that grew while being read.
  const buffer = Buffer.alloc(size + 1)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (!bytesRead) break
    offset += bytesRead
  }
  return offset === size ? buffer.subarray(0, size) : undefined
}

async function captureFile(root: FileRoot, file: WalkedFile, context: CaptureContext): Promise<Entry> {
  const plain = { sig: file.sig, size: file.size, mode: file.mode }
  if (file.secret) return { ...plain, kept: 'secret' }
  if (file.size > context.cloneLimit) return { ...plain, kept: 'large' }
  const path = join(root.path, ...file.path.split('/'))
  for (let attempt = 0; attempt < 2 && Date.now() <= context.deadline; attempt++) {
    let handle: FileHandle
    try {
      // O_NONBLOCK: a FIFO swapped in after the walk does not wait for a writer.
      handle = await open(path, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK)
    } catch {
      break
    }
    try {
      const info = await handle.stat({ bigint: true })
      // Only the inode the walk found inside the folder; a path that now leads elsewhere opens another one.
      if (!info.isFile() || info.dev !== file.dev || info.ino !== file.ino) break
      const opened = { sig: signature(info), size: Number(info.size), mode: Number(info.mode & 0o777n) }
      if (opened.size > context.cloneLimit) return { ...opened, kept: 'large' }
      if (opened.size > context.copyLimit) {
        const head = Buffer.alloc(Math.min(SNIFF_BYTES, opened.size))
        await handle.read(head, 0, head.length, 0)
        if (isSecretPath(file.path, head) || hasSecretContent(head)) return { ...opened, kept: 'secret' }
        if (info.dev !== context.storeDev) return { ...opened, kept: 'large' }
        if (context.room.bytes < opened.size) return { ...opened, kept: 'cap' }
        const hash = await context.objects.putClone(path, handle, opened.size)
        if (signature(await handle.stat({ bigint: true })) !== opened.sig) continue
        if (!hash) return { ...opened, kept: 'large' }
        context.room.bytes -= opened.size
        return { ...opened, hash, kept: 'stored' }
      }
      const bytes = await readExactly(handle, opened.size)
      if (!bytes || signature(await handle.stat({ bigint: true })) !== opened.sig) continue
      const head = bytes.subarray(0, SNIFF_BYTES)
      if (isSecretPath(file.path, head) || hasSecretContent(head)) return { ...opened, hash: digestOf(bytes), kept: 'secret' }
      if (context.room.bytes < opened.size) return { ...opened, hash: digestOf(bytes), kept: 'cap' }
      const { hash, added } = await context.objects.putBytes(bytes)
      if (added) context.room.bytes -= opened.size
      return { ...opened, hash, kept: 'stored' }
    } catch {
      break
    } finally {
      await handle.close()
    }
  }
  return { ...plain, kept: 'skipped' }
}

/** Records the walked files; `previous` lends its entries to files whose metadata is unchanged. */
export async function capture(
  roots: readonly FileRoot[],
  walk: Walk,
  previous: Manifest | undefined,
  context: CaptureContext,
): Promise<Manifest> {
  const files: Record<string, Entry> = {}
  const pending: Array<[string, WalkedFile]> = []
  for (const [key, file] of walk.files) {
    const known = previous?.files[key]
    if (known && known.sig === file.sig && SETTLED.has(known.kept)) files[key] = known
    else pending.push([key, file])
  }
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, pending.length) }, async () => {
      while (next < pending.length) {
        const [key, file] = pending[next++]!
        files[key] = await captureFile(
          roots.find(root => root.id === file.root)!,
          file,
          context,
        )
      }
    }),
  )
  return {
    capturedAt: new Date(context.now()).toISOString(),
    folders: roots.map(root => ({ id: root.id, path: root.path })),
    complete: roots.filter(root => walk.complete.has(root.id)).map(root => root.id),
    files,
  }
}

/** Two entries of one path hold the same file: same content and mode when both were read, else unchanged metadata. */
export function sameEntry(a: Entry, b: Entry): boolean {
  if (a.mode !== b.mode) return false
  return a.hash && b.hash ? a.hash === b.hash : a.sig === b.sig
}

/** Two states are known to hold the same content; a state never read counts as different. */
export function sameState(a: FileState | undefined, b: FileState | undefined): boolean {
  if (!a || !b) return a === b
  return a.mode === b.mode && a.hash !== undefined && a.hash === b.hash
}

export const stateOf = (entry: Entry): FileState => ({
  size: entry.size,
  mode: entry.mode,
  ...(entry.hash ? { hash: entry.hash } : {}),
  kept: entry.kept,
  sig: entry.sig,
})

/**
 * The changes from one record to the next. A file present on only one side counts as added or deleted only when the
 * other side's folder was walked to the end; otherwise it is left out and the result is partial.
 */
export function compare(before: Manifest, after: Manifest): { changes: Change[]; partial: boolean } {
  const walkedBefore = new Set(before.complete),
    walkedAfter = new Set(after.complete)
  const changes: Change[] = []
  let partial = false
  for (const key of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].toSorted()) {
    const a = before.files[key],
      b = after.files[key]
    const { root, path } = splitKey(key)
    if (a && b && sameEntry(a, b)) continue
    if ((a && !b && !walkedAfter.has(root)) || (!a && b && !walkedBefore.has(root))) {
      partial = true
      continue
    }
    if (changes.length >= CHANGE_LIMIT) {
      partial = true
      break
    }
    changes.push({ root, path, ...(a ? { before: stateOf(a) } : {}), ...(b ? { after: stateOf(b) } : {}) })
  }
  return { changes, partial }
}
