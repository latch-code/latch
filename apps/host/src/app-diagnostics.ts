import { mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { AppDiagnostic, AppDiagnosticSource } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { redactSecrets, writeFileAtomic } from '@latch/core/node-kit'
import { privateDirectory, readPrivate } from './app-data.ts'

/** Entries kept per page, and the longest message after redaction. */
export const DIAGNOSTICS_KEPT = 200
export const DIAGNOSTIC_BYTES = 2048
const FILE = 'diagnostics.json'

const entrySchema = z.strictObject({
  id: z.string().regex(/^dg_[A-Za-z0-9_-]{16}$/u),
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  appId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  source: z.enum(['build', 'runtime', 'handshake', 'bridge', 'migration']),
  code: z
    .string()
    .regex(/^[a-z0-9.-]{1,64}$/u)
    .optional(),
  message: z.string().max(DIAGNOSTIC_BYTES),
})
const fileSchema = z.strictObject({ version: z.literal(1), entries: z.array(entrySchema).max(DIAGNOSTICS_KEPT * 4) })

/** Cuts at a code point so the UTF-8 length stays within `max`. */
function clip(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text
  let out = ''
  for (const char of text) {
    if (Buffer.byteLength(out + char) > max - 3) break
    out += char
  }
  return out + '…'
}

/**
 * A page's recent diagnostics: build output, uncaught errors a frame reports, handshake timeouts, bridge refusals and
 * migrations. Every message passes through `redactSecrets` before it is kept; a page reads only its plugin's file.
 */
export class AppDiagnostics {
  private readonly cache = new Map<string, AppDiagnostic[]>()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly directoryOf: (pluginId: string) => string,
    private readonly now: () => number = Date.now,
  ) {}

  private async load(pluginId: string): Promise<AppDiagnostic[]> {
    const known = this.cache.get(pluginId)
    if (known) return known
    let entries: AppDiagnostic[] = []
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readPrivate(join(this.directoryOf(pluginId), FILE), 4 * 1024 * 1024)))
      // A damaged file only loses diagnostics; it never stops the page.
      if (parsed.success) entries = parsed.data.entries
    } catch {
      entries = []
    }
    this.cache.set(pluginId, entries)
    return entries
  }

  async list(pluginId: string, appId: string): Promise<AppDiagnostic[]> {
    return (await this.load(pluginId)).filter(entry => entry.appId === appId).toReversed()
  }

  record(pluginId: string, input: { appId: string; source: AppDiagnosticSource; code?: string; message: string }): Promise<AppDiagnostic> {
    const entry = entrySchema.parse({
      id: `dg_${randomBytes(12).toString('base64url')}`,
      at: new Date(this.now()).toISOString(),
      appId: input.appId,
      source: input.source,
      ...(input.code ? { code: input.code } : {}),
      message: clip(redactSecrets(input.message), DIAGNOSTIC_BYTES),
    })
    const run = this.queue.then(async () => {
      const entries = [...(await this.load(pluginId)), entry]
      const mine = entries.filter(item => item.appId === input.appId)
      const drop = new Set(mine.slice(0, Math.max(0, mine.length - DIAGNOSTICS_KEPT)))
      const kept = entries.filter(item => !drop.has(item))
      const directory = this.directoryOf(pluginId)
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await privateDirectory(directory)
        await writeFileAtomic(join(directory, FILE), JSON.stringify({ version: 1, entries: kept }) + '\n')
      } catch {
        throw new AppError(503, 'app-diagnostics-unavailable', '诊断没有记下。')
      }
      this.cache.set(pluginId, kept)
      return entry
    })
    this.queue = run.catch(() => {})
    return run
  }

  forget(pluginId: string): void {
    this.cache.delete(pluginId)
  }
}
