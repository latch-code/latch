import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { writeFileAtomic, type AtomicWriteFs } from '@latch/core/node-kit'

interface JournalOptions {
  /** Below the data directory, created private; absent: the data directory itself. */
  directory?: string
  atomicFs?: AtomicWriteFs
  maximumBytes?: number
  /** Finish a write whose result is unknown on its own. Only for state with no execution intent to reconcile afterwards. */
  retryMs?: number
  /** Turns an older version of the file into the current one; a file it changed is written back at once. */
  upgrade?: (raw: unknown) => unknown
}
interface Pending<State> {
  key: string
  hash: string
  state: State
  value: unknown
}
export interface JournalChange<Value> {
  value: Value
  changed?: boolean
}

/** Private domain state only. A recovered write publishes the same intent; it never calls an execution callback. */
export class AgentJournal<State> {
  private tail: Promise<unknown> = Promise.resolve()
  private pending?: Pending<State>
  private retry?: ReturnType<typeof setTimeout>
  private closed = false
  private constructor(
    private readonly path: string,
    private state: State,
    private readonly schema: z.ZodType<State>,
    private readonly options: JournalOptions,
  ) {}
  static async open<State>(
    dataDir: string,
    name: string,
    schema: z.ZodType<State>,
    initial: State,
    options: JournalOptions = {},
  ): Promise<AgentJournal<State>> {
    if (!/^[a-z][a-z-]{0,40}\.json$/u.test(name)) throw new AppError(500, 'agent-journal-name', 'Agent 记录类型无效。')
    const directory = options.directory ? join(dataDir, options.directory) : dataDir,
      path = join(directory, name),
      uid = process.getuid?.(),
      maximum = options.maximumBytes ?? 16 * 1024 * 1024
    if (!Number.isSafeInteger(maximum) || maximum < 1024 || maximum > 32 * 1024 * 1024)
      throw new AppError(500, 'agent-journal-budget', 'Agent 记录容量无效。')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const folder = await lstat(directory)
    if (!folder.isDirectory() || folder.isSymbolicLink() || folder.mode & 0o077 || (uid !== undefined && folder.uid !== uid))
      throw new AppError(500, 'agent-private', 'Agent 记录目录必须只有本人可访问。')
    let state: State
    let upgraded = false
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > maximum || (uid !== undefined && stat.uid !== uid))
          throw new Error('Private record')
        const buffer = Buffer.alloc(maximum + 1)
        let count = 0
        while (count < buffer.length) {
          const read = await file.read(buffer, count, buffer.length - count, null)
          if (!read.bytesRead) break
          count += read.bytesRead
        }
        if (count > maximum) throw new Error('Private record budget')
        const raw: unknown = JSON.parse(buffer.subarray(0, count).toString('utf8'))
        const current = options.upgrade ? options.upgrade(raw) : raw
        upgraded = current !== raw
        state = schema.parse(current)
      } finally {
        await file.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new AppError(500, 'agent-journal-invalid', 'Agent 记录无法读取，原文件已保留。')
      state = schema.parse(structuredClone(initial))
      if (Buffer.byteLength(JSON.stringify(state)) > maximum) throw new AppError(500, 'agent-journal-budget', 'Agent 初始记录超过容量。')
      await writeFileAtomic(path, JSON.stringify(state) + '\n')
    }
    // The upgraded file goes back at once; a failed write leaves the original, upgraded again next time or by the next change.
    if (upgraded) await writeFileAtomic(path, JSON.stringify(state) + '\n', { fs: options.atomicFs }).catch(() => {})
    return new AgentJournal(path, state, schema, options)
  }
  read(): State {
    if (this.pending) throw new AppError(503, 'agent-write-unknown', '修改结果尚未确认，请稍后同步。')
    return structuredClone(this.state)
  }
  hasPending(): boolean {
    return this.pending !== undefined
  }
  change<Value>(
    key: string,
    hash: string,
    apply: (draft: State) => JournalChange<Value> | Promise<JournalChange<Value>>,
    authorize: () => void = () => {},
  ): Promise<Value> {
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        authorize()
        if (this.pending) {
          if (this.pending.key !== key) throw new AppError(503, 'agent-write-unknown', '上一项修改尚未确认，请稍后同步。')
          if (this.pending.hash !== hash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
          const value = this.pending.value as Value
          await this.publish(this.pending)
          authorize()
          return structuredClone(value)
        }
        const draft = structuredClone(this.state),
          result = await apply(draft)
        authorize()
        if (result.changed !== false) {
          if (!this.schema.safeParse(draft).success)
            throw new AppError(409, 'agent-storage-limit', 'Agent 记录已达到容量上限，请先整理记录。')
          if (Buffer.byteLength(JSON.stringify(draft)) > (this.options.maximumBytes ?? 16 * 1024 * 1024))
            throw new AppError(409, 'agent-storage-limit', 'Agent 记录已达到存储上限。')
          await this.publish({ key, hash, state: draft, value: structuredClone(result.value) })
        }
        authorize()
        return structuredClone(result.value)
      })
    this.tail = task
    return task
  }
  /** Storage recovery is safe to retry; callers must separately reconcile an unconfirmed execution intent. */
  recover(): Promise<void> {
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        if (this.pending) await this.publish(this.pending)
      })
    this.tail = task
    return task
  }
  private async publish(pending: Pending<State>): Promise<void> {
    try {
      await writeFileAtomic(this.path, JSON.stringify(pending.state) + '\n', { fs: this.options.atomicFs })
    } catch {
      this.pending = pending
      this.retryLater()
      throw new AppError(503, 'agent-write-unknown', '修改结果尚未确认，请稍后同步。')
    }
    this.state = pending.state
    this.pending = undefined
  }
  private retryLater(): void {
    if (!this.options.retryMs || this.retry || this.closed) return
    this.retry = setTimeout(() => {
      this.retry = undefined
      void this.recover().catch(() => {})
    }, this.options.retryMs)
    this.retry.unref()
  }
  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.retry)
    await this.tail.catch(() => {})
  }
}
