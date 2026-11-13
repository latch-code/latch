import { looksSecret } from '@latch/protocol'
import { forgetSlashHistory } from './slashHistory.ts'
import { forgetAgentCreations } from './agentCreation.ts'
import { storageDeviceCurrent } from './deviceStorageScope.ts'

interface Draft {
  text: string
  private: boolean
  /** When it was last written, so the oldest goes first when there are too many. */
  at: number
}
const MAX_DRAFTS = 20
const MAX_CHARACTERS = 256_000
const WRITE_DELAY_MS = 300
const KEY_PREFIX = 'latch.drafts.'
/** A draft not edited for this long is dropped at the next load. */
export const DRAFT_EXPIRY_MS = 14 * 24 * 60 * 60_000
/** Set on sign-out; a window that saw another value stops writing, so its next `pagehide` cannot bring drafts back. */
const forgottenKey = (origin: string): string => `latch.drafts-forgotten.${origin}`

/**
 * Text that carries a project file's excerpt (引用) needs the data scope `all`: it is kept as private, so a device with
 * less drops it as it does a private session's draft.
 */
export function holdsExcerpt(text: string): boolean {
  return /^\[引用 [^\]\n]+\]\n> /mu.test(text) && text.includes('（引用时文件：')
}

/**
 * The sessions a listing proves still exist, or undefined when it proves nothing: the Host could not list every Harness,
 * or this device does not see every session (scope or privacy hides some). Archived sessions are listed, so they keep
 * their drafts; a failed or partial listing never drops one.
 */
export function listedSessions(
  snapshot: { tasks: ReadonlyArray<{ id: string }>; tasksComplete?: true },
  seesAll: boolean,
): ReadonlySet<string> | undefined {
  if (snapshot.tasksComplete !== true || !seesAll) return undefined
  return new Set(snapshot.tasks.map(task => task.id))
}

/** Where one device's drafts are kept between page loads. Every call may throw (private mode, full or blocked storage). */
export interface DraftStorage {
  read(): string | null
  write(value: string | null): void
  /** The sign-out marker shared by every window of this origin; null when none was ever set. */
  marker?(): string | null
}

/** This origin's browser storage key for a device's drafts; the desktop shell's pages use the same storage. */
export const draftsKey = (origin: string, deviceId: string): string => `${KEY_PREFIX}${origin}.${deviceId}`

export function browserDraftStorage(origin: string, deviceId: string): DraftStorage {
  const key = draftsKey(origin, deviceId)
  return {
    marker: () => localStorage.getItem(forgottenKey(origin)),
    read: () => (storageDeviceCurrent(origin, deviceId) ? localStorage.getItem(key) : null),
    write: value => {
      if (!storageDeviceCurrent(origin, deviceId)) throw new Error('Draft storage belongs to another device')
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    },
  }
}

/** Bumped when every device's drafts are forgotten, so that a write already scheduled cannot bring them back. */
let forgotten = 0

/**
 * Removes the stored drafts of every device on this origin except `keep`: a device that was removed, signed out or
 * replaced leaves nothing another one could open. Without `keep` (signed out), no draft bound before writes again.
 * Storage that throws has nothing to remove.
 */
export function forgetStoredDrafts(origin: string, keep?: string): void {
  forgetSlashHistory(origin, keep)
  forgetAgentCreations(origin, keep)
  if (keep === undefined) forgotten++
  try {
    if (keep === undefined) localStorage.setItem(forgottenKey(origin), `${Date.now()}.${Math.random().toString(36).slice(2)}`)
  } catch {
    /* A window that cannot write the marker cannot write drafts either. */
  }
  try {
    const prefix = `${KEY_PREFIX}${origin}.`
    const stale: string[] = []
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key?.startsWith(prefix) && (keep === undefined || key !== draftsKey(origin, keep))) stale.push(key)
    }
    for (const key of stale) localStorage.removeItem(key)
  } catch {
    /* Nothing was stored. */
  }
}

function parse(value: string | null): Map<string, Draft> {
  const drafts = new Map<string, Draft>()
  if (value === null) return drafts
  try {
    const stored: unknown = JSON.parse(value)
    if (typeof stored !== 'object' || stored === null || (stored as { version?: unknown }).version !== 1) return drafts
    const entries = (stored as { drafts?: unknown }).drafts
    if (!Array.isArray(entries)) return drafts
    for (const entry of entries.slice(0, MAX_DRAFTS)) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || entry[0].length > 256) continue
      const draft = entry[1] as Record<string, unknown> | null
      if (
        typeof draft !== 'object'
        || draft === null
        || typeof draft.text !== 'string'
        || !draft.text
        || draft.text.length > MAX_CHARACTERS
        || typeof draft.private !== 'boolean'
        || typeof draft.at !== 'number'
        || draft.at < Date.now() - DRAFT_EXPIRY_MS
      )
        continue
      drafts.set(entry[0], { text: draft.text, private: draft.private, at: draft.at })
    }
  } catch {
    /* Unreadable: nothing was kept. */
  }
  return drafts
}

/** Oldest first, within the limits; what does not fit is dropped from the oldest. */
function bounded(drafts: Map<string, Draft>): Array<[string, Draft]> {
  const sorted = [...drafts].sort((a, b) => a[1].at - b[1].at)
  let characters = sorted.reduce((sum, [, draft]) => sum + draft.text.length, 0)
  while (sorted.length > MAX_DRAFTS || characters > MAX_CHARACTERS) characters -= sorted.shift()![1].text.length
  return sorted
}

/**
 * Unsent text, isolated by globally unique session ID (`''` is the new-session draft). Kept in memory and, when storage
 * is given and works, in this device's browser storage, so it survives a reload or restart. Text only: attachments and
 * file references stay in memory with the composer. Several windows share the storage; each writes only the drafts it
 * changed, so one window does not undo another's.
 */
export class SessionDrafts {
  private readonly drafts = new Map<string, Draft>()
  private characters = 0
  /** The open composer's text, kept for the next page load but not offered by `read`: the composer holds it. */
  private live: { id: string; draft: Draft | null } | null = null
  /** Changes since the last write: a draft, or null for one removed. */
  private readonly changed = new Map<string, Draft | null>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private storage: DraftStorage | undefined
  private epoch = forgotten
  /** The sign-out marker when storage was read; another value means a window signed out since. */
  private seenMarker: string | null = null
  /** Whether this device may see every kind of data now; below that, private text (and excerpts) is never stored. */
  private seesAll = true

  constructor(storage?: DraftStorage) {
    this.bind(storage)
  }

  /** Reads `storage` afresh, replacing what is in memory. Storage that throws is left alone: drafts stay in memory. */
  bind(storage: DraftStorage | undefined): void {
    this.cancelWrite()
    this.drafts.clear()
    this.changed.clear()
    this.characters = 0
    this.live = null
    this.storage = storage
    this.epoch = forgotten
    if (!storage) return
    let stored: Map<string, Draft>
    try {
      this.seenMarker = storage.marker?.() ?? null
      stored = parse(storage.read())
    } catch {
      this.storage = undefined
      return
    }
    for (const [id, draft] of bounded(stored)) {
      this.drafts.set(id, draft)
      this.characters += draft.text.length
    }
  }

  save(id: string, text: string, isPrivate: boolean): boolean {
    if (text.length > MAX_CHARACTERS) return false
    isPrivate ||= holdsExcerpt(text)
    this.drop(id)
    if (this.live?.id === id) this.live = null
    if (!text) {
      this.note(id, null)
      return true
    }
    while (this.drafts.size >= MAX_DRAFTS || this.characters + text.length > MAX_CHARACTERS) {
      const oldest = this.drafts.keys().next().value
      if (oldest === undefined) break
      this.drop(oldest)
      this.note(oldest, null)
    }
    const draft = { text, private: isPrivate, at: Date.now() }
    this.drafts.set(id, draft)
    this.characters += text.length
    this.note(id, draft)
    return true
  }

  read(id: string, allowPrivate: boolean): string {
    const draft = this.drafts.get(id)
    if (!draft) return ''
    if (draft.private && !allowPrivate) {
      this.remove(id)
      return ''
    }
    this.drafts.delete(id)
    this.drafts.set(id, draft)
    return draft.text
  }

  /**
   * The open composer's text for `id`, written to storage a moment later. `read` does not offer it: until the composer
   * switches away, it is the composer's.
   */
  keep(id: string, text: string, isPrivate: boolean): void {
    if (text.length > MAX_CHARACTERS) return
    const draft = text ? { text, private: isPrivate || holdsExcerpt(text), at: Date.now() } : null
    if (this.live?.id !== undefined && this.live.id !== id && !this.drafts.has(this.live.id)) this.note(this.live.id, null, false)
    this.live = { id, draft }
    this.note(id, draft, false)
  }

  remove(id: string): void {
    this.drop(id)
    if (this.live?.id === id) this.live = null
    this.note(id, null)
  }

  /** Removes every draft not for one of `ids` (or the new-session draft): sessions that are gone. */
  retain(ids: ReadonlySet<string>): void {
    for (const id of [...this.drafts.keys()]) if (id !== '' && !ids.has(id)) this.remove(id)
    if (this.live && this.live.id !== '' && !ids.has(this.live.id)) this.remove(this.live.id)
  }

  clearPrivate(): void {
    for (const [id, draft] of this.drafts) if (draft.private) this.remove(id)
    if (this.live?.draft?.private) this.remove(this.live.id)
  }

  /** Forgets every draft of this device, here and in storage, at once. */
  clear(): void {
    this.drafts.clear()
    this.characters = 0
    this.live = null
    this.changed.clear()
    this.cancelWrite()
    this.write(() => null)
  }

  /** The device's scope now: checked at every write, so a draft written after the scope narrowed is not stored. */
  allowPrivate(seesAll: boolean): void {
    this.seesAll = seesAll
  }

  /** Stops writing: what is not written yet stays in memory only. */
  detach(): void {
    this.cancelWrite()
    this.changed.clear()
    this.storage = undefined
  }

  /** Writes what changed now, for a page that is going away. */
  flush(): void {
    this.cancelWrite()
    if (!this.changed.size) return
    const changes = new Map(this.changed)
    this.changed.clear()
    this.write(current => {
      const next = parse(current)
      for (const [id, draft] of changes) {
        if (draft) next.set(id, draft)
        else next.delete(id)
      }
      const kept = bounded(next)
      return kept.length ? JSON.stringify({ version: 1, drafts: kept }) : null
    })
  }

  private drop(id: string): void {
    const previous = this.drafts.get(id)
    if (previous) this.characters -= previous.text.length
    this.drafts.delete(id)
  }

  private note(id: string, draft: Draft | null, now = true): void {
    if (!this.storage) return
    // Text holding a credential stays in memory only, as does private text (an excerpt) below the data scope `all`:
    // storage gets its removal instead.
    this.changed.set(id, draft && (looksSecret(draft.text) || (draft.private && !this.seesAll)) ? null : draft)
    if (now) this.flush()
    else if (this.timer === undefined)
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.flush()
      }, WRITE_DELAY_MS)
  }

  private cancelWrite(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Storage that throws leaves the drafts in memory only, and tries to leave nothing stale behind. */
  private write(next: (current: string | null) => string | null): void {
    const storage = this.storage
    if (!storage) return
    try {
      if (this.epoch !== forgotten || (storage.marker?.() ?? null) !== this.seenMarker) {
        this.detach()
        return
      }
      storage.write(next(storage.read()))
    } catch {
      this.storage = undefined
      try {
        storage.write(null)
      } catch {
        /* Nothing more can be done; what memory holds still works. */
      }
    }
  }
}
