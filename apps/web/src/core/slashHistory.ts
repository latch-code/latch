import { looksSecret } from '@latch/protocol'
import { markStorageDevice, storageDeviceCurrent } from './deviceStorageScope.ts'

interface RecentCommand {
  id: string
  harnessId?: string
}
const PREFIX = 'latch.slash-recent.'
const markerKey = (origin: string) => `latch.slash-forgotten.${origin}`
const contexts = new Map<string, { version: number; keep?: string }>()
const safeId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 256 && !/[\s\p{C}]/u.test(value) && !looksSecret(value)
const harnessScoped = (id: string) => /^(command|skill):/u.test(id)

/** IDs only: no labels, arguments, prompt bodies or paths are persisted. */
export class SlashHistory {
  private readonly key: string
  private readonly marker: string | null
  private readonly version: number
  constructor(
    private readonly origin: string,
    private readonly deviceId: string,
  ) {
    this.version = contexts.get(origin)?.version ?? 0
    this.key = `${PREFIX}${origin}.${deviceId}`
    try {
      this.marker = localStorage.getItem(markerKey(origin))
    } catch {
      this.marker = null
    }
  }
  private current(): boolean {
    const context = contexts.get(this.origin)
    if (context && (context.version !== this.version || (context.keep !== undefined && context.keep !== this.deviceId))) return false
    return storageDeviceCurrent(this.origin, this.deviceId) && localStorage.getItem(markerKey(this.origin)) === this.marker
  }
  private read(): RecentCommand[] {
    try {
      if (!this.current()) return []
      const raw: unknown = JSON.parse(localStorage.getItem(this.key) ?? '[]')
      if (!Array.isArray(raw)) return []
      return raw.slice(0, 8).flatMap((value: unknown) => {
        if (!value || typeof value !== 'object') return []
        const entry = value as Record<string, unknown>
        if (!safeId(entry.id) || !/^(action|template|command|skill):.+/u.test(entry.id)) return []
        if (harnessScoped(entry.id) && !safeId(entry.harnessId)) return []
        return [{ id: entry.id, ...(harnessScoped(entry.id) ? { harnessId: entry.harnessId as string } : {}) }]
      })
    } catch {
      return []
    }
  }
  ids(harnessId: string | undefined): string[] {
    return this.read()
      .filter(entry => entry.harnessId === undefined || entry.harnessId === harnessId)
      .map(entry => entry.id)
  }
  record(id: string, harnessId: string | undefined): void {
    if (!safeId(id) || !/^(action|template|command|skill):.+/u.test(id)) return
    if (harnessScoped(id) && !safeId(harnessId)) return
    const entry = { id, ...(harnessScoped(id) ? { harnessId } : {}) }
    try {
      if (!this.current()) return
      const previous = this.read().filter(item => item.id !== entry.id || item.harnessId !== entry.harnessId)
      localStorage.setItem(this.key, JSON.stringify([entry, ...previous].slice(0, 8)))
    } catch {
      /* Completion remains available when storage is blocked. */
    }
  }
}

/** Called with draft cleanup on sign-out, revocation and device replacement. */
export function forgetSlashHistory(origin: string, keep?: string): void {
  contexts.set(origin, { version: (contexts.get(origin)?.version ?? 0) + (keep === undefined ? 1 : 0), keep })
  const marker = keep === undefined ? crypto.randomUUID() : undefined
  const mark = () => {
    markStorageDevice(origin, keep)
    try {
      if (marker !== undefined) localStorage.setItem(markerKey(origin), marker)
    } catch {
      /* Cleanup may make room before the second attempt. */
    }
  }
  mark()
  try {
    const prefix = `${PREFIX}${origin}.`
    const remove: string[] = []
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key?.startsWith(prefix) && key !== (keep === undefined ? undefined : prefix + keep)) remove.push(key)
    }
    for (const key of remove) localStorage.removeItem(key)
  } catch {
    /* No readable local storage. */
  }
  mark()
}
