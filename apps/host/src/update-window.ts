import { constants } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { writeFileAtomic } from '@latch/core/node-kit'

/**
 * The version of the Host's API as the desktop app talks to it (`host-info.protocol`). The desktop app compares it with
 * what a release's bundled Host speaks to tell an App-only update from one that changes the Host (docs/UPDATES.md).
 */
export const HOST_PROTOCOL = 1
/** The plugin package `formatVersion`s this Host loads (`plugin-packages.ts`). */
export const PLUGIN_PACKAGE_FORMATS: readonly number[] = [1]
/** An install window lapses unless the desktop app renews it; a desktop app that went away cannot hold starts shut. */
export const UPDATE_WINDOW_TTL_MS = 10 * 60_000
/** A committed window (the Host about to be stopped) holds this long at most: a desktop app that quit in between does not shut starts until a restart. */
export const UPDATE_COMMIT_TTL_MS = 2 * 60_000

const pluginFormats = z.array(z.number().int().min(1).max(1000)).min(1).max(16)

/** `POST /link/api/host/update-window` (the desktop app over host.sock): enter or renew, or leave and why. */
const version = z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/u)
export const updateWindowInputSchema = z.discriminatedUnion('open', [
  z.strictObject({ open: z.literal(true), pluginFormats: pluginFormats.optional(), version: version.optional() }),
  z.strictObject({ open: z.literal(false), reason: z.enum(['cancelled', 'installing', 'failed']) }),
])
export type UpdateWindowInput = z.infer<typeof updateWindowInputSchema>

/**
 * The install window: while it is open the Host refuses new session starts and new turns with 409 `host-updating`, and
 * everything already under way settles as usual. It lives in memory only, so a restarted Host starts outside it.
 */
export class UpdateWindow {
  private until: number | undefined
  private committedUntil: number | undefined
  /** The device that entered the window: only it renews, commits or leaves it. */
  private holder: string | undefined

  constructor(private readonly now: () => number) {}

  private get committed(): boolean {
    return this.committedUntil !== undefined && this.committedUntil > this.now()
  }

  isOpen(): boolean {
    return this.committed || (this.committedUntil === undefined && this.until !== undefined && this.until > this.now())
  }

  /** The window ran out without being renewed or left (the desktop app went away), committed or not. */
  lapsed(): boolean {
    if (this.committedUntil !== undefined) return !this.committed
    return this.until !== undefined && this.until <= this.now()
  }

  /**
   * The desktop app is about to stop this Host for the install: for the next two minutes nothing new starts and the
   * window cannot be renewed away. Leaving it (an install that failed before the Host stopped) undoes this; so does the
   * two minutes running out, when the desktop app quit or crashed in between.
   */
  commit(): void {
    this.committedUntil = this.now() + UPDATE_COMMIT_TTL_MS
  }

  /** When the window ends unless renewed (or, committed, when the commit runs out); undefined when it is not open. */
  get endsAt(): number | undefined {
    return this.committedUntil ?? this.until
  }

  get isCommitted(): boolean {
    return this.committed
  }

  /** Opens or renews; `entered` only when it was not open, so a renewal is not a new audit entry. */
  /**
   * Refuses another device while the window is open: a second desktop process on this Mac (a development run beside the
   * packaged app) cannot renew, commit or close a window the first one holds. An expiry or a Host restart still ends it.
   */
  assertHolder(deviceId: string): void {
    if (this.isOpen() && this.holder !== deviceId) throw new AppError(409, 'update-window-held', '另一个 Latch 应用正在安装更新。')
  }

  open(deviceId: string): 'entered' | 'renewed' {
    this.assertHolder(deviceId)
    const was = this.isOpen()
    this.holder = deviceId
    if (this.committedUntil !== undefined && !this.committed) this.committedUntil = undefined
    this.until = this.now() + UPDATE_WINDOW_TTL_MS
    return was ? 'renewed' : 'entered'
  }

  /** Whether it was open. */
  close(): boolean {
    const was = this.isOpen()
    this.until = undefined
    this.committedUntil = undefined
    this.holder = undefined
    return was
  }

  view(): { open: boolean; until?: string; committed?: true } {
    if (this.committed) return { open: true, committed: true }
    return this.isOpen() ? { open: true, until: new Date(this.until!).toISOString() } : { open: false }
  }
}

/**
 * Write requests (session starts, turns) by device and request ID, while in flight and once accepted, so that a retry
 * gets its original answer even inside the install window. A request that failed is forgotten: its retry is new.
 * In memory only, the newest 4096.
 */
export class RequestRecords {
  private readonly records = new Map<string, 'in-flight' | 'accepted'>()

  constructor(private readonly limit = 4096) {}

  has(key: string): boolean {
    return this.records.has(key)
  }

  begin(key: string): void {
    this.records.delete(key)
    this.records.set(key, 'in-flight')
    if (this.records.size > this.limit) this.records.delete(this.records.keys().next().value!)
  }

  /** Accepted, or failed and forgotten. Only an in-flight record changes, so a retry that rode along changes nothing. */
  settle(key: string, accepted: boolean): void {
    if (this.records.get(key) !== 'in-flight') return
    if (accepted) this.records.set(key, 'accepted')
    else this.records.delete(key)
  }

  /** Whether any record's key passes `test`: a request on its way or accepted. */
  some(test: (key: string) => boolean): boolean {
    for (const key of this.records.keys()) if (test(key)) return true
    return false
  }

  /** Whether a request whose key passes `test` is on its way (not yet accepted or forgotten). */
  someInFlight(test: (key: string) => boolean): boolean {
    for (const [key, state] of this.records) if (state === 'in-flight' && test(key)) return true
    return false
  }

  inFlight(): number {
    let count = 0
    for (const state of this.records.values()) if (state === 'in-flight') count++
    return count
  }
}

/**
 * Turns this Host accepted, by session, device and request ID, with the hash of what was sent: a retry from the same
 * device with the same body is answered as accepted before checks that may have changed since; another body under the
 * same ID is a conflict. Recorded only once the session holds the turn durably (the driver's prompt resolved). In memory
 * only, the newest 4096: after a restart a retry goes through the ordinary checks.
 */
export class TurnReceipts {
  private readonly receipts = new Map<string, string>()

  constructor(private readonly limit = 4096) {}

  get(key: string): string | undefined {
    return this.receipts.get(key)
  }

  set(key: string, hash: string): void {
    this.receipts.delete(key)
    this.receipts.set(key, hash)
    if (this.receipts.size > this.limit) this.receipts.delete(this.receipts.keys().next().value!)
  }
}

const heldSchema = z.strictObject({
  version: z.literal(1),
  /**
   * The plugin formats the coming version loads, recorded when the desktop app entered the window for it: only a Host of
   * that version holds plugins for it, and only before `until` (the window's own end).
   */
  planned: pluginFormats.optional(),
  target: version.optional(),
  until: z.number().int().positive().optional(),
  /** Plugin packages held off since an update made them incompatible; their assets stay. */
  held: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)).max(64),
})
type HeldState = z.infer<typeof heldSchema>

/**
 * `plugin-packages/update-held.json`: which plugin packages a new version holds off on its first start. The desktop app
 * names the coming version's plugin formats when it enters the install window; the next start compares them with each
 * applied package's `formatVersion` and keeps the incompatible ones off (not enabled, assets kept) until someone turns
 * one on again.
 */
export class HeldPlugins {
  private constructor(
    private readonly path: string,
    private state: HeldState,
  ) {}

  static async open(pluginDirectory: string): Promise<HeldPlugins> {
    const path = join(pluginDirectory, 'update-held.json')
    let state: HeldState = { version: 1, held: [] }
    let handle
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch {
      return new HeldPlugins(path, state)
    }
    try {
      const info = await handle.stat()
      if (info.isFile() && info.size <= 64 * 1024 && (info.mode & 0o077) === 0)
        state = heldSchema.parse(JSON.parse(await handle.readFile('utf8')))
    } catch {
      // An unreadable record holds nothing: every plugin starts as its own record says.
    } finally {
      await handle.close()
    }
    return new HeldPlugins(path, state)
  }

  /** Held plugin IDs, in the order they were held. */
  list(): string[] {
    return [...this.state.held]
  }

  isHeld(id: string): boolean {
    return this.state.held.includes(id)
  }

  /** The desktop app is about to install `version`, which loads these formats; the plan ends with the window at `until`. */
  async plan(formats: readonly number[], target: string, until: number): Promise<void> {
    await this.write({ version: 1, held: this.state.held, planned: [...new Set(formats)], target, until })
  }

  get planned(): boolean {
    return this.state.planned !== undefined
  }

  /** The install did not happen: nothing is held for it. */
  async unplan(): Promise<void> {
    if (!this.state.planned) return
    await this.write({ version: 1, held: this.state.held })
  }

  /**
   * At startup, before plugins are enabled: with a plan, every applied package whose format the plan does not list is
   * held, and the plan is used up. Held IDs that no longer name a package are dropped. Returns the IDs newly held.
   */
  async settle(
    applied: ReadonlyArray<{ id: string; formatVersion: number }>,
    current: { version: string; now: number },
  ): Promise<string[]> {
    const known = new Set(applied.map(item => item.id))
    // A plan for another version (the old Host started again after a failed install) or past its window is dropped.
    const valid = this.state.target === current.version && this.state.until !== undefined && this.state.until > current.now
    const planned = valid ? this.state.planned : undefined
    const added = planned ? applied.filter(item => !planned.includes(item.formatVersion) && !this.isHeld(item.id)).map(item => item.id) : []
    const held = [...this.state.held.filter(id => known.has(id)), ...added]
    if (!this.state.planned && held.length === this.state.held.length) return []
    await this.write({ version: 1, held })
    return added
  }

  /** Someone turned the plugin on again (or removed it): it is no longer held. */
  async release(id: string): Promise<void> {
    if (!this.isHeld(id)) return
    await this.write({ ...this.state, held: this.state.held.filter(item => item !== id) })
  }

  private async write(next: HeldState): Promise<void> {
    const parsed = heldSchema.parse(next)
    if (!parsed.planned && parsed.held.length === 0) await unlink(this.path).catch(() => {})
    else await writeFileAtomic(this.path, `${JSON.stringify(parsed)}\n`)
    this.state = parsed
  }
}
