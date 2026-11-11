import type { GitOperation } from './changes.ts'

/** The writes a session's 交付 makes in its repository; each takes a `requestId`. */
export type GitDeliveryKind = 'stage' | 'unstage' | 'commit' | 'push'

/** A file's state on one side: added, modified, deleted or type changed (a file became a link, or back). */
export type GitFileStatus = 'A' | 'M' | 'D' | 'T'

export interface GitDeliveryFile {
  /** Relative to the repository's top level, `/`-separated. */
  path: string
  status: GitFileStatus
}

/** A delivery write under way in the repository, from any device or session that shares it. */
export interface GitDeliveryRunning {
  kind: GitDeliveryKind
  requestId: string
  startedAt: string
  /** The hook Git is running now, when it runs one. */
  hook?: string
}

/** `GET /link/api/tasks/:id/git`: the session's repository as the 交付 tab shows it. */
export interface GitDeliveryState {
  /** The branch HEAD names; absent when HEAD is detached. */
  branch?: string
  /** HEAD's commit; absent before the first commit. */
  head?: string
  /** `<remote>/<branch>` of the branch's upstream, from the repository's configuration. */
  upstream?: string
  /** Commits ahead of and behind the upstream, from local refs only (nothing is fetched); 0 without one. */
  ahead: number
  behind: number
  /** Index against HEAD. */
  staged: GitDeliveryFile[]
  /** Work tree against the index. */
  unstaged: GitDeliveryFile[]
  untracked: string[]
  conflicted: string[]
  /** Entries left out past 2,000 in all. */
  more?: number
  /** Merge, rebase, cherry-pick or revert under way: every write is refused until it is finished in the terminal. */
  gitOperation?: GitOperation
  running?: GitDeliveryRunning
  /** Executable hooks Git would run here, by name (from `core.hooksPath` or the Git directory's `hooks/`). */
  hooks: string[]
  /** The repository's configuration names a filter driver (Git LFS, for one): staging runs it, as your Git does. */
  filters: boolean
  /** The remote a push goes to: the upstream's, else `origin`; absent when there is neither. */
  remote?: string
}

export interface GitStageResult {
  files: number
  /** Staged by your Git with the repository's filters, rather than by the Host's restricted Git. */
  filtered?: true
}

export interface GitCommitResult {
  commit: string
  /** What the hooks printed, redacted and capped; absent when they printed nothing or were skipped. */
  hookOutput?: string
  /** Answered from the receipt of an earlier attempt with the same `requestId`. */
  replay?: true
}

export interface GitPushResult {
  remote: string
  /** `refs/heads/<branch>` on the remote. */
  ref: string
  sha: string
  /** The branch had no upstream; this push set it. */
  setUpstream?: true
  replay?: true
}

/**
 * Error codes the delivery routes answer with (body `{ error, message, ...details }`). Failures of a write that ran carry
 * `hook`, `exitCode`, `tail` (redacted, at most 256 KiB) or `remoteLines` (redacted `remote:` lines of a refused push).
 */
export type GitDeliveryError =
  | 'git-not-repository'
  | 'git-no-git'
  | 'git-folder-unavailable'
  | 'git-operation-in-progress'
  | 'git-turn-running'
  | 'git-busy'
  | 'git-paths-invalid'
  | 'git-nothing-staged'
  | 'git-conflicted'
  | 'git-identity-missing'
  | 'git-hook-failed'
  | 'git-commit-failed'
  | 'git-commit-not-made'
  | 'git-detached'
  | 'git-no-commit'
  | 'git-no-remote'
  | 'git-remote-invalid'
  | 'git-upstream-other-branch'
  | 'git-push-auth'
  | 'git-push-non-fast-forward'
  | 'git-push-remote-rejected'
  | 'git-push-unreachable'
  | 'git-push-host-key'
  | 'git-push-failed'
  | 'git-stage-failed'
  | 'git-result-unknown'
  | 'git-receipt-unsaved'
  | 'git-failed'
