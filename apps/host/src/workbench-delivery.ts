import type { GitDeliveryState, GitPrState, WorkbenchDelivery, WorkbenchDeliveryEntry, WorkbenchRepository } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { isOrdinaryWorkbenchFolder } from './workbench-git-eligibility.ts'

interface Source {
  now(): number
  state(folder: string): Promise<GitDeliveryState>
  pr(sessionId: string, folder: string): Promise<GitPrState>
}

interface Observed<T> {
  value: T
  at: string
}

type RepositoryRead = { state: WorkbenchRepository } | { notApplicable: 'not-repository' }

export interface WorkbenchDeliveryTarget {
  sessionId: string
  folder?: string
  boundPr: boolean
  error?: WorkbenchDeliveryEntry['error']
}

function repository(state: GitDeliveryState): WorkbenchRepository {
  const { staged, unstaged, untracked, conflicted, hooks: _hooks, filters: _filters, ...rest } = state
  return {
    ...rest,
    staged: staged.length,
    unstaged: unstaged.length,
    untracked: untracked.length,
    conflicted: conflicted.length,
    files: new Set([...staged.map(file => file.path), ...unstaged.map(file => file.path), ...untracked, ...conflicted]).size,
  }
}

export function workbenchReadFailure(error: unknown): NonNullable<WorkbenchDeliveryEntry['error']> {
  return { code: error instanceof AppError ? error.code : 'git-failed', message: '暂时无法读取交付状态' }
}

/**
 * Bounded reads for visible workbench cards and the board's own reads (`board.ts`). Only reads under way are shared; the
 * board keeps what it concluded. `boundPr: false` never starts `gh` or reaches a remote.
 */
export class WorkbenchDeliveryReader {
  private readonly states = new Map<string, Promise<Observed<RepositoryRead>>>()
  private readonly prs = new Map<string, Promise<Observed<Pick<GitPrState, 'pr' | 'checks'>>>>()

  constructor(private readonly source: Source) {}

  async read(targets: WorkbenchDeliveryTarget[]): Promise<WorkbenchDelivery> {
    const entries: WorkbenchDeliveryEntry[] = new Array(targets.length)
    const batchStates = new Map<string, Promise<Observed<RepositoryRead>>>()
    let next = 0
    const state = (folder: string) => {
      let pending = batchStates.get(folder)
      if (!pending) {
        pending = this.coalesce(this.states, folder, async () => {
          let value: RepositoryRead
          try {
            value = { state: repository(await this.source.state(folder)) }
          } catch (error) {
            if (!(error instanceof AppError) || error.code !== 'git-not-repository' || !(await isOrdinaryWorkbenchFolder(folder)))
              throw error
            value = { notApplicable: 'not-repository' }
          }
          return { value, at: this.stamp() }
        })
        batchStates.set(folder, pending)
      }
      return pending
    }
    const worker = async () => {
      while (next < targets.length) {
        const index = next++
        const target = targets[index]!
        const entry: WorkbenchDeliveryEntry = { sessionId: target.sessionId, observedAt: this.stamp() }
        if (!target.folder) entry.error = target.error ?? { code: 'git-folder-unavailable', message: '找不到这个会话的文件夹' }
        else {
          try {
            const observed = await state(target.folder)
            if ('state' in observed.value) entry.state = observed.value.state
            else entry.notApplicable = observed.value.notApplicable
            entry.observedAt = observed.at
          } catch (error) {
            entry.error = workbenchReadFailure(error)
          }
          // An unbound session must not start gh or query a remote merely because its home page is visible.
          if (target.boundPr && entry.state) {
            try {
              const observed = await this.coalesce(this.prs, `${target.sessionId}\n${target.folder}`, async () => {
                const value = await this.source.pr(target.sessionId, target.folder!)
                return { value: { ...(value.pr ? { pr: value.pr } : {}), checks: value.checks }, at: this.stamp() }
              })
              entry.pr = observed.value
              entry.prObservedAt = observed.at
            } catch (error) {
              entry.prError = workbenchReadFailure(error)
            }
          }
        }
        entries[index] = entry
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker))
    return { observedAt: this.stamp(), entries }
  }

  private stamp(): string {
    return new Date(this.source.now()).toISOString()
  }

  private coalesce<T>(pending: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
    const existing = pending.get(key)
    if (existing) return existing
    const result = read().finally(() => {
      if (pending.get(key) === result) pending.delete(key)
    })
    pending.set(key, result)
    return result
  }
}
