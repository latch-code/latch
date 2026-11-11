// The person's small text edits from the file preview: the shape of the file's text (line endings, final newline,
// byte-order mark), the new bytes in that shape, and a replace through a temporary file and a rename that refuses once
// the file is no longer the version the editor opened. See docs/DOCUMENT-PREVIEWS.md (编辑).
import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { FILE_EDIT_LIMIT } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { syncDirectory } from '@latch/core/node-kit'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0

export interface TextShape {
  /** More than one line-ending style (CRLF, LF, CR): such a file is not edited here. */
  mixed: boolean
  bom: boolean
  /** The file's line ending: CRLF when most of its line breaks are. */
  eol: '\n' | '\r\n'
  finalNewline: boolean
}

export interface CurrentFile {
  bytes: Uint8Array
  hash: string
  /** Permission bits, kept by the replacement. */
  mode: number
  info: BigIntStats
  /** Undefined when the file is not UTF-8 text the editor takes. */
  shape?: TextShape
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export const fileChanged = (hash: string) => new AppError(409, 'file-changed', '文件在你打开之后被改过，没有保存。', { currentHash: hash })
const moved = () => new AppError(409, 'file-changed', '文件的位置或身份变了，没有保存。')

/** The shape of an editable file's text, or undefined when it is not UTF-8 text without NUL within the edit limit. */
export function textShape(bytes: Uint8Array): TextShape | undefined {
  if (bytes.length > FILE_EDIT_LIMIT) return undefined
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
  if (bom) text = text.slice(1)
  if (text.includes('\u0000')) return undefined
  const crlf = text.split('\r\n').length - 1
  const lf = text.split('\n').length - 1 - crlf
  const cr = text.split('\r').length - 1 - crlf
  return {
    mixed: [crlf, lf, cr].filter(count => count > 0).length > 1,
    bom,
    eol: crlf > lf ? '\r\n' : '\n',
    finalNewline: text.endsWith('\n'),
  }
}

/** The bytes use more than one line-ending style; works on a prefix too, since the endings are single bytes. */
export function mixedLineEndings(bytes: Uint8Array): boolean {
  let crlf = 0,
    lf = 0,
    cr = 0
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 0x0d) {
      if (bytes[index + 1] === 0x0a) {
        crlf++
        index++
      } else if (index + 1 < bytes.length) cr++
    } else if (bytes[index] === 0x0a) lf++
  }
  return [crlf, lf, cr].filter(count => count > 0).length > 1
}

/** The text is well-formed (no lone surrogates) and holds no NUL. */
export function validContent(content: string): boolean {
  return !content.includes('\u0000') && Buffer.from(content, 'utf8').toString('utf8') === content
}

/**
 * The bytes for `content` in the file's shape. A text area gives LF line breaks, so they become the file's line ending;
 * the final newline and the byte-order mark stay as the file had them.
 */
export function shapeContent(content: string, shape: TextShape): Buffer {
  let text = content.replace(/^﻿/u, '').replace(/\r\n/gu, '\n')
  if (shape.finalNewline) {
    if (text && !text.endsWith('\n')) text += '\n'
  } else if (text.endsWith('\n')) text = text.slice(0, -1)
  if (shape.eol === '\r\n') text = text.replace(/\n/gu, '\r\n')
  return Buffer.from(`${shape.bom ? '﻿' : ''}${text}`, 'utf8')
}

/** The file at `path` (a real path, no symlink) read whole through its own handle; at most the edit limit plus one byte. */
export async function readCurrent(path: string): Promise<CurrentFile> {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw moved()
  })
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile()) throw moved()
    if (info.size > BigInt(FILE_EDIT_LIMIT))
      throw new AppError(413, 'file-edit-too-large', `超过 ${FILE_EDIT_LIMIT / 1024 / 1024} MiB 的文件不能在这里编辑。`)
    const buffer = Buffer.alloc(FILE_EDIT_LIMIT + 1)
    let length = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
      if (length > FILE_EDIT_LIMIT)
        throw new AppError(413, 'file-edit-too-large', `超过 ${FILE_EDIT_LIMIT / 1024 / 1024} MiB 的文件不能在这里编辑。`)
    }
    const bytes = new Uint8Array(buffer.subarray(0, length))
    const shape = textShape(bytes)
    return { bytes, hash: sha256(bytes), mode: Number(info.mode) & 0o777, info, ...(shape ? { shape } : {}) }
  } finally {
    await handle.close()
  }
}

const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino

/**
 * Replaces the file at `path` with `bytes` through a new temporary file in the same folder and a rename, keeping the
 * permission bits. Right before the rename the path must still name the file `base` read, still holding `baseHash`, in
 * the same folder; otherwise nothing is replaced (409 `file-changed`). Ownership, extended attributes and other hard
 * links do not carry over.
 */
export async function replaceFile(
  path: string,
  bytes: Uint8Array,
  base: CurrentFile,
  test?: { beforeRename?(): Promise<void> },
): Promise<void> {
  const directory = dirname(path)
  const folder = await lstat(directory, { bigint: true })
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw moved()
  const temp = join(directory, `.${basename(path).slice(0, 64)}.latch-edit-${randomUUID()}.tmp`)
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
  try {
    try {
      await handle.writeFile(bytes)
      await handle.chmod(base.mode)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await test?.beforeRename?.()
    // The folder, the path and the content are still the ones the editor's version was checked against.
    const now = await lstat(directory, { bigint: true }).catch(() => undefined)
    if (!now?.isDirectory() || now.isSymbolicLink() || !same(now, folder) || (await realpath(directory).catch(() => '')) !== directory)
      throw moved()
    const target = await lstat(path, { bigint: true }).catch(() => undefined)
    if (!target?.isFile() || !same(target, base.info)) throw moved()
    const again = await readCurrent(path)
    if (!same(again.info, base.info)) throw moved()
    if (again.hash !== base.hash) throw fileChanged(again.hash)
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  await syncDirectory(directory).catch(() => {})
}
