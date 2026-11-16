import {
  boardSettleOf,
  waitKindOf,
  type BoardPlace,
  type BoardReason,
  type GitPrStatus,
  type WorkItemPlace,
  type TaskSummary,
  type WorkbenchDeliveryEntry,
} from '@latch/protocol'
import type { WorkbenchDeliveryReader } from './workbench-delivery.ts'

/** The Host's markers on one settlement: a failed run was opened, the results nobody could vouch for were checked. */
export interface BoardAttended {
  settle: string
  opened?: true
  checked?: true
}

/** What the Host knows of a session beyond its summary, read without waiting on anything. */
export interface BoardFacts {
  /** Open questions, as the Host's own question store counts them. */
  questions: number
  /** An approval of this session is pending in the Host's list. */
  approval: boolean
  attended?: BoardAttended
  /** Present when a pull request is bound to the session; `state` as last read by a device or a person's delivery action. */
  pr?: { state?: GitPrStatus }
  /** The Host's last local Git reading says the session's folder holds work not yet delivered, and it is this session's to show. */
  delivery: boolean
}

const live = (task: Pick<TaskSummary, 'status'>) => task.status === 'running' || task.status === 'waiting-approval'

/** A card on the board: not archived, not a legacy assistant's, and from 我的 Agent only a scheduled run. */
function isCard(task: TaskSummary): boolean {
  if (task.archived || task.personal) return false
  if (task.agent || task.generalChat) return task.automationId !== undefined
  return true
}

/** How many results of the latest run nobody can vouch for, in the list's outline or the detail's full form. */
function unknownCount(task: TaskSummary): number {
  return task.runEnd?.unknownResultCount ?? task.runEnd?.unknownResults?.length ?? 0
}

/**
 * The board's rule table, top to bottom, the first that holds wins (docs/ARCHITECTURE.md#看板的组). The only place a
 * session's group is decided; `HarnessHub.present` calls it for every summary that leaves the Host.
 */
export function boardPlace(task: TaskSummary, facts: BoardFacts): BoardPlace {
  const settle = boardSettleOf(task)
  const base = { ...(settle !== undefined ? { settle } : {}), ...(isCard(task) ? { card: true as const } : {}) }
  const wait = waitKindOf(task, { questions: facts.questions, approval: facts.approval })
  if (wait) return { group: 'attention', reason: wait, ...base }
  if (!live(task)) {
    const marked = settle !== undefined && facts.attended?.settle === settle ? facts.attended : undefined
    if (unknownCount(task) > 0 && !marked?.checked) return { group: 'attention', reason: 'unknown', ...base }
    const failed = task.status === 'failed' || (task.status === 'idle' && task.runOutcome === 'failed')
    if (failed && !marked?.opened) return { group: 'attention', reason: 'failed', ...base }
  }
  if (live(task)) return { group: 'running', ...base }
  if (facts.pr?.state === 'merged' || facts.pr?.state === 'closed') return { group: 'done', ...base }
  // A bound pull request not read as merged or closed is open or not read yet.
  if (facts.delivery || facts.pr) return { group: 'deliver', ...base }
  return { group: 'done', ...base }
}

/** Waiting reasons in the rule order: a 待办 waiting on several sessions shows the first. */
const REASON_ORDER: readonly BoardReason[] = ['approval', 'question', 'unrecognized', 'silent', 'unknown', 'failed']

/** One session of a 待办 as the Host read it now: its place, and whether its bound pull request was last read as merged. */
export interface WorkItemMember {
  place: BoardPlace
  prMerged: boolean
}

/**
 * The 待办 rule table, top to bottom, the first that holds wins (docs/ARCHITECTURE.md#待办). `members` are the sessions
 * the Host could read now, archived ones included; `count` is how many the 待办 lists. A session not read (its Harness is
 * not listing) counts for nothing but keeps it out of `todo` and out of rule 6.
 */
export function workItemPlace(item: { closedAt?: string }, count: number, members: readonly WorkItemMember[]): WorkItemPlace {
  if (item.closedAt) return { group: 'done' }
  if (count === 0) return { group: 'todo' }
  const waiting = members.flatMap(member => (member.place.group === 'attention' && member.place.reason ? [member.place.reason] : []))
  if (members.some(member => member.place.group === 'attention'))
    return { group: 'attention', ...(waiting.length ? { reason: REASON_ORDER.find(reason => waiting.includes(reason))! } : {}) }
  if (members.some(member => member.place.group === 'running')) return { group: 'running' }
  if (members.some(member => member.place.group === 'deliver')) return { group: 'deliver' }
  if (members.length === count && members.every(member => member.prMerged)) return { group: 'done' }
  return { group: 'deliver', reason: 'settled' }
}

/** A session the Host may read in the background: its working folder, when it last changed, and whether it is private. */
export interface DeliveryTarget {
  folder: string
  updatedAt: string
  /**
   * It may hold the folder's work: the folder is its own (its worktree or session folder), a pull request is bound to
   * it, or the changes record says one of its own turns changed files there. Others never claim a shared folder's work.
   */
  holds: boolean
  /** Read only by devices with the full data scope: private sessions share a folder's work only among themselves. */
  private?: boolean
}

/**
 * What sessions share a folder's work: private sessions and the rest each among themselves, so a private session never
 * moves a visible one in or out of 可交付.
 */
const shareOf = (target: DeliveryTarget) => `${target.private ? 'private' : 'visible'}\n${target.folder}`

interface Reading {
  /** `shareOf` the target it was read for. */
  share: string
  updatedAt: string
  /** The folder holds uncommitted files or commits not pushed. */
  work: boolean
}

export interface BoardDeliveryOptions {
  log: (text: string) => void
  /** A session's conclusion changed: clients read it again. */
  changed: (sessionId: string) => void
  /**
   * Whether the Host reads this session in the background, and where: a Code session that is not archived and not
   * running, with its folder still in its project. Undefined otherwise.
   */
  target: (sessionId: string) => Promise<DeliveryTarget | undefined>
}

/** Background reads at once; a device's `workbench/delivery` keeps its own two places and is never refused for these. */
const BACKGROUND_READS = 1
/** All reads at once, devices' included: a background read waits while this many run. */
const ALL_READS = 2
const STARTUP_READS = 48
const STARTUP_DAYS = 7

/**
 * The Host's own reading of local Git for 可交付, kept in memory only. A session is read once after a run settles, once
 * after 交付 commits, pushes or opens a pull request, and once at start for recent idle sessions; a device's
 * `workbench/delivery` read refreshes it too. Background reads go through `WorkbenchDeliveryReader` with `boundPr: false`:
 * the restricted Git runner on local refs only, never `gh` and never the network. A pull request's state comes only from
 * reads a device or a person started. Several sessions in one folder: the folder's work shows on the latest of them
 * that changed files there itself (private sessions apart from the rest); when none did, no session shows it.
 */
export class BoardDelivery {
  private reader: WorkbenchDeliveryReader | undefined
  private readonly readings = new Map<string, Reading>()
  /** The session each folder's work shows on (by `shareOf`): the latest to change of those read there. */
  private readonly holders = new Map<string, { sessionId: string; updatedAt: string }>()
  private readonly prs = new Map<string, GitPrStatus>()
  private readonly queue = new Set<string>()
  private background = 0
  private devices = 0
  private closed = false
  private readonly running = new Set<Promise<void>>()

  constructor(private readonly options: BoardDeliveryOptions) {}

  /** The git routes hand over their reader once they exist; until then nothing is read. */
  connect(reader: WorkbenchDeliveryReader): void {
    this.reader = reader
    this.pump()
  }

  /** Whether the session's folder holds work not yet delivered, and it is this session's to show. */
  local(sessionId: string): boolean {
    const reading = this.readings.get(sessionId)
    return !!reading?.work && this.holders.get(reading.share)?.sessionId === sessionId
  }

  /** The bound pull request's state as last read by a device or a delivery action. */
  prState(sessionId: string): GitPrStatus | undefined {
    return this.prs.get(sessionId)
  }

  /** A place for a device's read, or undefined while two run. */
  take(): (() => void) | undefined {
    if (this.devices >= ALL_READS) return undefined
    this.devices++
    let released = false
    return () => {
      if (released) return
      released = true
      this.devices--
      this.pump()
    }
  }

  /** Read the session again: a run settled, or 交付 changed its repository. */
  settled(sessionId: string): void {
    if (this.closed) return
    this.queue.delete(sessionId)
    this.queue.add(sessionId)
    this.pump()
  }

  /** At start: recent idle sessions that may hold their folder's work, newest first, one per folder, at most `STARTUP_READS`. */
  async warm(tasks: readonly TaskSummary[], now: number): Promise<void> {
    const since = now - STARTUP_DAYS * 86_400_000
    const recent = tasks
      .filter(task => !task.archived && !live(task) && Date.parse(task.updatedAt) >= since)
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const folders = new Set<string>()
    let count = 0
    for (const task of recent) {
      if (this.closed || count >= STARTUP_READS) break
      const target = await this.options.target(task.id).catch(() => undefined)
      // One that may not hold its folder's work would show nothing: the newest that may is read.
      if (!target?.holds || folders.has(shareOf(target))) continue
      folders.add(shareOf(target))
      count++
      this.settled(task.id)
    }
  }

  /** What a device's `workbench/delivery` read found: the cache follows it. */
  async observe(entry: WorkbenchDeliveryEntry): Promise<void> {
    const state = entry.pr?.pr?.state
    if (state) this.recordPr(entry.sessionId, state)
    if (!entry.state && !entry.notApplicable) return
    const target = await this.options.target(entry.sessionId).catch(() => undefined)
    if (target) this.record(entry.sessionId, target, entry)
  }

  /** A pull request's state a device or a person's delivery action read. */
  recordPr(sessionId: string, state: GitPrStatus): void {
    if (this.closed || this.prs.get(sessionId) === state) return
    this.prs.set(sessionId, state)
    this.options.changed(sessionId)
  }

  /** The session is gone or archived: nothing of it is kept. */
  forget(sessionId: string): void {
    this.queue.delete(sessionId)
    this.prs.delete(sessionId)
    const reading = this.readings.get(sessionId)
    this.readings.delete(sessionId)
    if (reading && this.holders.get(reading.share)?.sessionId === sessionId) this.holders.delete(reading.share)
  }

  /** Stops taking reads and waits for the ones under way. */
  async close(): Promise<void> {
    this.closed = true
    this.queue.clear()
    await Promise.allSettled([...this.running])
  }

  private pump(): void {
    while (
      !this.closed
      && this.reader
      && this.queue.size
      && this.background < BACKGROUND_READS
      && this.background + this.devices < ALL_READS
    ) {
      const sessionId = this.queue.values().next().value!
      this.queue.delete(sessionId)
      this.background++
      const run = this.read(this.reader, sessionId).finally(() => {
        this.background--
        this.running.delete(run)
        this.pump()
      })
      this.running.add(run)
    }
  }

  private async read(reader: WorkbenchDeliveryReader, sessionId: string): Promise<void> {
    try {
      const target = await this.options.target(sessionId)
      if (!target || this.closed) return
      // Never a pull request: that would start gh and reach the network.
      const [entry] = (await reader.read([{ sessionId, folder: target.folder, boundPr: false }])).entries
      if (entry && !this.closed) this.record(sessionId, target, entry)
    } catch (error) {
      this.options.log(`会话 ${sessionId} 的交付状态未能读取：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private record(sessionId: string, target: DeliveryTarget, entry: WorkbenchDeliveryEntry): void {
    if (this.closed || (!entry.state && !entry.notApplicable)) return
    const work = !!entry.state && (entry.state.files > 0 || entry.state.ahead > 0)
    const share = shareOf(target)
    const previous = this.readings.get(sessionId)?.share
    const shares = new Set([share, ...(previous !== undefined ? [previous] : [])])
    const affected = [sessionId, ...[...this.readings].filter(([, reading]) => shares.has(reading.share)).map(([id]) => id)]
    const before = new Map(affected.map(id => [id, this.local(id)]))
    if (previous !== undefined && previous !== share && this.holders.get(previous)?.sessionId === sessionId) this.holders.delete(previous)
    this.readings.set(sessionId, { share, updatedAt: target.updatedAt, work })
    // A folder's work is the folder's: every session sharing it sees the latest reading.
    for (const reading of this.readings.values()) if (reading.share === share) reading.work = work
    const holder = this.holders.get(share)
    if (!target.holds) {
      if (holder?.sessionId === sessionId) this.holders.delete(share)
    } else if (!holder || holder.sessionId === sessionId || holder.updatedAt <= target.updatedAt)
      this.holders.set(share, { sessionId, updatedAt: target.updatedAt })
    for (const id of new Set(affected)) if (before.get(id) !== this.local(id)) this.options.changed(id)
  }
}
