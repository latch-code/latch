// Opaque, short-lived names for files the Host resolved. A handle stands for (device, session, folder, relative
// path), never for an inode (a named file outside the folders is the exception, see `outside`): every use resolves the path again, so a file an agent replaced is the new file and a file
// moved out of the folder is gone. Handles live in memory only; a restarted Host knows none.
import { randomBytes } from 'node:crypto'
import type { OutsideBinding } from './outside.ts'

export const HANDLE = /^[A-Za-z0-9_-]{22}$/u
/** A handle lapses this long after it was last used. */
export const HANDLE_IDLE_MS = 15 * 60 * 1000
export const HANDLE_LIMIT = 4096

export interface HandleEntry {
  deviceId: string
  sessionId?: string
  workspaceId?: string
  harnessId?: string
  /** Freeze the authorized root identities and selected configuration, rather than retargeting a live handle. */
  rootsHash?: string
  revision?: string
  rootId: string
  relativePath: string
  /** A desktop reader explicitly chose to display a secret file. Never sufficient on a remote listener. */
  allowSecret?: true
  /**
   * A file outside the session's folders that its messages named: unlike a folder's file, the handle is bound to the
   * file it named when issued (real path, device and inode), and a replaced file is a new handle.
   */
  outside?: OutsideBinding
}

export type HandleLookup = { ok: true; entry: HandleEntry } | { ok: false; reason: 'expired' | 'foreign' }

export class FileHandles {
  /** Insertion order is recency: a use moves the handle to the end, and the oldest goes first when full. */
  private readonly entries = new Map<string, HandleEntry & { until: number }>()

  constructor(private readonly now: () => number) {}

  /** 128 random bits; the same file for the same device and session keeps one handle while it is in use. */
  issue(entry: HandleEntry): string {
    const time = this.now()
    for (const [handle, value] of this.entries) {
      if (value.until <= time) {
        this.entries.delete(handle)
        continue
      }
      if (
        value.deviceId === entry.deviceId
        && value.sessionId === entry.sessionId
        && value.workspaceId === entry.workspaceId
        && value.harnessId === entry.harnessId
        && value.rootsHash === entry.rootsHash
        && value.revision === entry.revision
        && value.rootId === entry.rootId
        && value.relativePath === entry.relativePath
        && JSON.stringify(value.outside) === JSON.stringify(entry.outside)
      ) {
        if (entry.allowSecret) value.allowSecret = true
        this.touch(handle, value, time)
        return handle
      }
    }
    const handle = randomBytes(16).toString('base64url')
    while (this.entries.size >= HANDLE_LIMIT) this.entries.delete(this.entries.keys().next().value!)
    this.entries.set(handle, { ...entry, until: time + HANDLE_IDLE_MS })
    return handle
  }

  /** The entry for a device's own live handle. Another device's handle answers `foreign` and stays as it was. */
  use(handle: string, deviceId: string): HandleLookup {
    const time = this.now()
    const value = this.entries.get(handle)
    if (!value || value.until <= time) {
      this.entries.delete(handle)
      return { ok: false, reason: 'expired' }
    }
    if (value.deviceId !== deviceId) return { ok: false, reason: 'foreign' }
    this.touch(handle, value, time)
    const { until: _until, ...entry } = value
    return { ok: true, entry }
  }

  /** A session that was deleted takes its handles with it. */
  forgetSession(sessionId: string): void {
    for (const [handle, value] of this.entries) if (value.sessionId === sessionId) this.entries.delete(handle)
  }

  get size(): number {
    return this.entries.size
  }

  private touch(handle: string, value: HandleEntry & { until: number }, time: number): void {
    this.entries.delete(handle)
    this.entries.set(handle, { ...value, until: time + HANDLE_IDLE_MS })
  }
}
