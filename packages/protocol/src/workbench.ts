import type { GitDeliveryState, GitPrState } from './git-delivery.ts'

/** Repository facts for the workbench; file names and hook configuration stay in the delivery panel. */
export interface WorkbenchRepository extends Pick<
  GitDeliveryState,
  'branch' | 'head' | 'upstream' | 'ahead' | 'behind' | 'more' | 'gitOperation' | 'running' | 'remote'
> {
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  /** Distinct changed paths; a partially staged file counts once. */
  files: number
}

export interface WorkbenchDeliveryEntry {
  sessionId: string
  observedAt: string
  state?: WorkbenchRepository
  /** Only an already bound pull request, without discussion or a suggested PR title. */
  pr?: Pick<GitPrState, 'pr' | 'checks'>
  prObservedAt?: string
  error?: { code: string; message: string }
  prError?: { code: string; message: string }
}

/** POST /link/api/workbench/delivery { ids: string[] }, at most 12 currently visible sessions. Read-only. */
export interface WorkbenchDelivery {
  observedAt: string
  entries: WorkbenchDeliveryEntry[]
}
