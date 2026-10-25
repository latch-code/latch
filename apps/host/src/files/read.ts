import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AppError } from '@latch/sdk'
import { hasSecretContent, isSecretPath } from './secrets.ts'
import { SNIFF_BYTES } from './sniff.ts'
import { fileEtag } from './metadata.ts'
import type { ResolvedFile } from './resolve.ts'

export interface ByteRange {
  start: number
  end: number
}

/** Only one bounded range is supported. Empty files have no satisfiable ranges. */
export function byteRange(header: string | undefined, size: number): ByteRange | undefined {
  if (header === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header)
  const invalid = () => new AppError(416, 'file-range', '请求的文件范围不可用')
  if (!match || (!match[1] && !match[2]) || size === 0) throw invalid()
  const first = match[1] ? Number(match[1]) : undefined
  const last = match[2] ? Number(match[2]) : undefined
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) throw invalid()
  if (first === undefined) {
    if (last === undefined || last <= 0) throw invalid()
    return { start: Math.max(0, size - last), end: size - 1 }
  }
  if (first >= size || (last !== undefined && last < first)) throw invalid()
  return { start: first, end: Math.min(last ?? size - 1, size - 1) }
}

/** Reopens the adjudicated file, then proves that this descriptor still names that same regular file. */
export async function openContent(file: ResolvedFile, allowSecret: boolean) {
  let fd: Awaited<ReturnType<typeof open>>
  try {
    fd = await open(file.realPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK)
  } catch {
    throw new AppError(409, 'file-changed', '文件已变化，请重新打开')
  }
  try {
    const info = await fd.stat({ bigint: true })
    const named = await lstat(file.realPath, { bigint: true }).catch(() => undefined)
    const current = await realpath(file.realPath).catch(() => undefined)
    const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
    if (
      !info.isFile()
      || !named
      || current !== file.realPath
      || named.dev !== info.dev
      || named.ino !== info.ino
      || (file.identity !== undefined && identity !== file.identity)
    )
      throw new AppError(409, 'file-changed', '文件已变化，请重新打开')
    const head = Buffer.alloc(Math.min(SNIFF_BYTES, Number(info.size)))
    const read = head.length ? await fd.read(head, 0, head.length, 0) : { bytesRead: 0 }
    if (
      !allowSecret
      && (isSecretPath(file.relativePath, head.subarray(0, read.bytesRead)) || hasSecretContent(head.subarray(0, read.bytesRead)))
    )
      throw new AppError(403, 'file-secret', '这个文件可能含密钥，只在运行 Latch 的电脑上确认显示')
    return fd
  } catch (cause) {
    await fd.close()
    throw cause
  }
}

/** Content is never a navigable document. Even HTML and SVG cannot obtain Latch's origin by opening this URL. */
export async function sendContent(
  req: IncomingMessage,
  res: ServerResponse,
  file: ResolvedFile,
  options: {
    mime: string
    limit: number
    allowSecret: boolean
    recheck(): void | Promise<void>
    consume(bytes: number): void
  },
): Promise<void> {
  const fd = await openContent(file, options.allowSecret)
  try {
    await options.recheck()
    const size = Math.min(file.size, options.limit)
    const tag = fileEtag(file)
    const version = new URL(req.url ?? '/', 'http://latch.invalid').searchParams.get('v')
    if (version !== null && (!/^[a-f0-9]{32}$/u.test(version) || `"${version}"` !== tag))
      throw new AppError(412, 'file-changed', '文件内容已变化，请更新预览')
    const unchanged = async () => {
      const info = await fd.stat({ bigint: true })
      if (file.identity !== undefined && `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` !== file.identity)
        throw new AppError(409, 'file-changed', '读取时文件已变化，请更新预览')
    }
    res.setHeader('content-type', options.mime)
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('content-security-policy', "sandbox; default-src 'none'")
    res.setHeader(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    )
    res.setHeader('cross-origin-resource-policy', 'same-origin')
    res.setHeader('cache-control', 'private, no-store')
    res.setHeader('accept-ranges', 'bytes')
    res.setHeader('etag', tag)
    if (req.headers['if-match'] && req.headers['if-match'] !== tag) throw new AppError(412, 'file-changed', '文件内容已变化，请更新预览')
    if (req.headers['if-none-match'] === tag && !req.headers.range) {
      res.writeHead(304)
      res.end()
      return
    }
    let range: ByteRange | undefined
    try {
      range = req.headers['if-range'] && req.headers['if-range'] !== tag ? undefined : byteRange(req.headers.range, size)
    } catch (cause) {
      res.setHeader('content-range', `bytes */${size}`)
      throw cause
    }
    const start = range?.start ?? 0
    const end = range?.end ?? size - 1
    const length = Math.max(0, end - start + 1)
    options.consume(req.method === 'HEAD' ? 0 : length)
    if (range) res.setHeader('content-range', `bytes ${start}-${end}/${size}`)
    res.setHeader('content-length', length)
    if (size < file.size) res.setHeader('x-latch-file-truncated', '1')
    res.writeHead(range ? 206 : 200)
    if (req.method === 'HEAD' || length === 0) {
      res.end()
      return
    }
    const buffer = Buffer.alloc(Math.min(256 * 1024, length))
    for (let offset = start; offset <= end && !res.destroyed;) {
      await options.recheck()
      await unchanged()
      const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, end - offset + 1), offset)
      if (bytesRead === 0) throw new AppError(409, 'file-changed', '读取时文件已变化，请重新打开')
      await options.recheck()
      await unchanged()
      const chunk = Buffer.from(buffer.subarray(0, bytesRead))
      if (!res.write(chunk)) {
        const drained = await new Promise<boolean>(done => {
          const close = () => {
            res.off('drain', drain)
            done(false)
          }
          const drain = () => {
            res.off('close', close)
            done(true)
          }
          res.once('close', close)
          res.once('drain', drain)
        })
        if (!drained) return
      }
      offset += bytesRead
    }
    res.end()
  } catch (cause) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    throw cause
  } finally {
    await fd.close()
  }
}
