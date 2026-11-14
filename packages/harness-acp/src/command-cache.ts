import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { sha256Hex, writeFileAtomic } from '@latch/core/node-kit'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_ENTRIES = 64
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const command = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[^\s\u0000-\u001f\u007f]+$/u),
  description: z.string().max(1000).optional(),
  inputHint: z.string().max(500).optional(),
  idleOnly: z.literal(true).optional(),
})
const entry = z.strictObject({
  scope: hash,
  launchHash: hash,
  definitionHash: hash,
  sourceSessionId: z.string().min(1).max(256),
  reportedAt: z.string().datetime(),
  order: z.number().int().positive(),
  commands: z.array(command).max(200),
})
const state = z.strictObject({ version: z.literal(1), entries: z.array(entry).max(MAX_ENTRIES) })
export type CommandCacheEntry = z.infer<typeof entry>

/** A private cache scope: project identity and the directory itself, not just a reusable path. */
export async function commandDirectory(cwd: string): Promise<string | undefined> {
  try {
    const path = await realpath(cwd)
    const before = await lstat(path, { bigint: true })
    if (!before.isDirectory()) return undefined
    const current = await realpath(cwd)
    const after = await lstat(path, { bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || current !== path) return undefined
    return sha256Hex(JSON.stringify([path, before.dev.toString(), before.ino.toString()]))
  } catch {
    return undefined
  }
}

export function commandScope(directory: string, workspaceId?: string): string {
  return sha256Hex(JSON.stringify([workspaceId ?? null, directory]))
}

/** Derived suggestions, under the driver's already-held ACP data lock; never a session/CLI authority. */
export class CommandCache {
  private readonly file: string
  private readonly entries = new Map<string, CommandCacheEntry>()
  private order = 0
  private dirty = false
  private writing?: Promise<void>
  private closed = false

  constructor(dataDir: string) {
    this.file = join(dataDir, 'harness-commands.json')
  }

  async load(): Promise<void> {
    try {
      const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = await handle.stat()
        if (!before.isFile() || before.size > MAX_BYTES || (process.platform !== 'win32' && (before.mode & 0o077) !== 0)) return
        const bytes = Buffer.alloc(before.size + 1)
        let used = 0
        while (used < bytes.length) {
          const read = await handle.read(bytes, used, bytes.length - used, used)
          if (!read.bytesRead) break
          used += read.bytesRead
        }
        const after = await handle.stat()
        if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return
        const read = state.parse(JSON.parse(bytes.subarray(0, used).toString('utf8')))
        if (new Set(read.entries.map(item => item.scope)).size !== read.entries.length) return
        for (const item of read.entries) {
          this.entries.set(item.scope, item)
          this.order = Math.max(this.order, item.order)
        }
      } finally {
        await handle.close()
      }
    } catch {
      // A missing, corrupt, oversized or unsafe optional cache is a miss, never a reason to start a program.
    }
  }

  /** Allocated at report receipt, before async checks; wall-clock timestamps are display data only. */
  nextOrder(): number {
    return ++this.order
  }

  remember(value: CommandCacheEntry): void {
    if (this.closed) return
    const read = entry.safeParse(value)
    if (!read.success || (this.entries.get(value.scope)?.order ?? 0) >= value.order) return
    this.entries.set(value.scope, read.data)
    this.trim()
    this.schedule()
  }

  read(scope: string, launchHash: string, definitionHash: string): CommandCacheEntry | undefined {
    const known = this.entries.get(scope)
    return known?.launchHash === launchHash && known.definitionHash === definitionHash ? structuredClone(known) : undefined
  }

  forget(sourceSessionId: string): void {
    let changed = false
    for (const [key, value] of this.entries)
      if (value.sourceSessionId === sourceSessionId) {
        this.entries.delete(key)
        changed = true
      }
    if (changed) this.schedule()
  }

  retainDefinition(definitionHash: string): void {
    let changed = false
    for (const [key, value] of this.entries)
      if (value.definitionHash !== definitionHash) {
        this.entries.delete(key)
        changed = true
      }
    if (changed) this.schedule()
  }

  async close(): Promise<void> {
    this.closed = true
    while (this.writing || this.dirty) {
      if (!this.writing) this.schedule()
      await this.writing
    }
  }

  private serialized(): string {
    return JSON.stringify({ version: 1, entries: [...this.entries.values()] }) + '\n'
  }

  private trim(): void {
    const oldest = [...this.entries.values()].sort((a, b) => a.order - b.order)
    while (this.entries.size > MAX_ENTRIES || Buffer.byteLength(this.serialized()) > MAX_BYTES) {
      const item = oldest.shift()
      if (!item) break
      this.entries.delete(item.scope)
    }
  }

  private schedule(): void {
    this.dirty = true
    if (this.writing) return
    this.writing = (async () => {
      while (this.dirty) {
        this.dirty = false
        await writeFileAtomic(this.file, this.serialized())
      }
    })()
      .catch(() => {
        // Cache persistence never fails a real turn; source-session validation protects a stale disk snapshot on restart.
      })
      .finally(() => {
        this.writing = undefined
        if (this.dirty && !this.closed) this.schedule()
      })
  }
}
