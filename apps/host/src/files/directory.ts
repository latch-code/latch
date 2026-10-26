import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { FileDirectoryEntry } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { latchCodeRoot } from '../paths.ts'

const entrySchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(4096)
    .refine(value => !/[\\/\u0000-\u001f\u007f]/u.test(value) && value !== '.' && value !== '..'),
  kind: z.enum(['file', 'directory', 'symlink', 'other']),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mtime: z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
})
const listingSchema = z.strictObject({ entries: z.array(entrySchema).max(2000), truncated: z.boolean() })
const errorSchema = z.strictObject({ error: z.enum(['invalid-input', 'protected', 'changed', 'unreadable', 'budget']) })
export function validDirectory(value: string): boolean {
  return (
    Buffer.byteLength(value) <= 4096
    && !/[\\\u0000-\u001f\u007f]/u.test(value)
    && (value === '' || (!value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')))
  )
}

/** Slots belong to real child processes until close, including cancelled and timed-out requests. No waiting queue. */
export class FileDirectoryReader {
  private active = 0
  private readonly devices = new Map<string, number>()
  private constructor(
    readonly available: boolean,
    private readonly binary: string,
  ) {}

  static async open(binary = join(latchCodeRoot(), 'dist/native/latch-files')): Promise<FileDirectoryReader> {
    const info = process.platform === 'darwin' ? await lstat(binary).catch(() => undefined) : undefined
    return new FileDirectoryReader(!!info?.isFile() && !!(info.mode & 0o111), binary)
  }

  async list(input: {
    deviceId: string
    root: string
    dir: string
    protectedPaths: readonly string[]
    showHidden: boolean
    check(): void
    signal: AbortSignal
  }): Promise<{ entries: FileDirectoryEntry[]; truncated: boolean }> {
    input.check()
    if (!this.available) throw new AppError(503, 'file-list-unavailable', '此 Host 尚未提供安全目录读取组件')
    if (!validDirectory(input.dir)) throw new AppError(400, 'file-directory-invalid', '文件夹的相对路径无效')
    if (this.active >= 4 || (this.devices.get(input.deviceId) ?? 0) >= 2)
      throw new AppError(429, 'file-list-busy', '同时读取的文件夹过多，请稍后再试')
    if (input.signal.aborted) throw new AppError(408, 'file-list-cancelled', '目录读取已取消')
    this.active++
    this.devices.set(input.deviceId, (this.devices.get(input.deviceId) ?? 0) + 1)
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(this.binary, [], { env: {}, stdio: ['pipe', 'pipe', 'ignore'] })
        const chunks: Buffer[] = []
        let bytes = 0
        let failure: unknown
        const stop = (cause: unknown) => {
          failure ??= cause
          child.kill('SIGKILL')
        }
        const aborted = () => stop(new AppError(408, 'file-list-cancelled', '目录读取已取消'))
        const timer = setTimeout(() => stop(new AppError(503, 'file-list-timeout', '读取目录超时，请重试')), 3000)
        const guard = setInterval(() => {
          try {
            input.check()
          } catch (cause) {
            stop(cause)
          }
        }, 50)
        input.signal.addEventListener('abort', aborted, { once: true })
        child.stdout.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 1_048_576) stop(new AppError(503, 'file-list-invalid', '目录读取组件返回无效结果'))
          else chunks.push(chunk)
        })
        child.stdout.on('error', () => stop(new AppError(503, 'file-list-unavailable', '安全目录读取组件不可用')))
        child.stdin.on('error', () => {})
        child.once('error', () => {
          failure ??= new AppError(503, 'file-list-unavailable', '安全目录读取组件不可用')
        })
        child.once('close', code => {
          clearTimeout(timer)
          clearInterval(guard)
          input.signal.removeEventListener('abort', aborted)
          if (failure) {
            reject(failure)
            return
          }
          try {
            input.check()
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (code !== 0) {
              const parsed = errorSchema.safeParse(value)
              const error = parsed.success ? parsed.data.error : undefined
              if (error === 'invalid-input') throw new AppError(400, 'file-directory-invalid', '文件夹查询无效或超出路径上限')
              if (error === 'budget') throw new AppError(503, 'file-list-timeout', '读取目录超时，请重试')
              if (error === 'protected') throw new AppError(403, 'file-protected', '这是 Latch 的私有数据')
              if (error === 'changed') throw new AppError(409, 'file-directory-changed', '文件夹已变化，请重新打开')
              if (error === 'unreadable') throw new AppError(403, 'file-directory-unreadable', '无法读取此文件夹，符号链接不能展开')
              throw new AppError(503, 'file-list-invalid', '目录读取组件返回无效结果')
            }
            const listing = listingSchema.parse(value)
            const names = new Set(listing.entries.map(entry => entry.name))
            if (names.size !== listing.entries.length) throw new Error('duplicate')
            const entries = listing.entries.map(entry => ({ ...entry, mtime: Math.trunc(entry.mtime) }))
            entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
            resolve({ entries, truncated: listing.truncated })
          } catch (cause) {
            reject(cause instanceof AppError ? cause : new AppError(503, 'file-list-invalid', '目录读取组件返回无效结果'))
          }
        })
        child.stdin.end(
          JSON.stringify({ root: input.root, dir: input.dir, protectedPaths: input.protectedPaths, showHidden: input.showHidden }),
        )
        if (input.signal.aborted) aborted()
      })
    } finally {
      this.active--
      const remaining = this.devices.get(input.deviceId)! - 1
      if (remaining === 0) this.devices.delete(input.deviceId)
      else this.devices.set(input.deviceId, remaining)
    }
  }
}
