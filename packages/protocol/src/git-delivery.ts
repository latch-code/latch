import type { ChangeHunk, GitOperation } from './changes.ts'

/**
 * The writes a session's 交付 makes in its repository (`pr` creates or binds its pull request; `fetch` updates its
 * remote-tracking branches; `pull` fetches and fast-forwards; `abort` ends a merge, rebase, cherry-pick or revert under
 * way); each takes a `requestId`.
 */
export type GitDeliveryKind = 'stage' | 'unstage' | 'commit' | 'push' | 'pr' | 'fetch' | 'pull' | 'abort'

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
  /** When this repository last fetched (FETCH_HEAD's time): `behind` is as of then, and says nothing without it. */
  fetchedAt?: string
  /** The branch a pull request goes into (main or master) and HEAD's commits it lacks, from local refs; 0 on it. */
  base?: { name: string; ahead: number }
  /** Index against HEAD. */
  staged: GitDeliveryFile[]
  /** Work tree against the index. */
  unstaged: GitDeliveryFile[]
  untracked: string[]
  conflicted: string[]
  /** Entries left out past 2,000 in all. */
  more?: number
  /**
   * Merge, rebase, cherry-pick or revert under way: every write but a fetch, a pull request and `abort` is refused until it
   * is finished (in the terminal) or aborted.
   */
  gitOperation?: GitOperation
  running?: GitDeliveryRunning
  /** Executable hooks Git would run here, by name (from `core.hooksPath` or the Git directory's `hooks/`). */
  hooks: string[]
  /** The repository's configuration names a filter driver (Git LFS, for one): staging runs it, as your Git does. */
  filters: boolean
  /** The remote a push goes to: the upstream's, else `origin`; absent when there is neither. */
  remote?: string
  /**
   * The repository's own configuration sets something a fetch would run or send credentials through (this kind of
   * setting, never its value): 获取 and 拉取 are refused (409 `git-repo-config`) until it is removed.
   */
  repoConfig?: GitRepoConfigKind
}

/** A kind of setting in a repository's own configuration that makes 获取 and 拉取 refuse it. */
export type GitRepoConfigKind = 'program' | 'credential' | 'proxy' | 'tls' | 'header' | 'rewrite'

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

/** `POST …/git/fetch`: the remote fetched (by its name in the repository's configuration) and when. */
export interface GitFetchResult {
  remote: string
  fetchedAt: string
}

/**
 * `POST …/git/pull`: fetched, then fast-forwarded to the upstream (`updated`), or already there. A branch that has
 * diverged is refused (409 `git-pull-diverged` with `ahead` and `behind`); nothing is merged or rebased.
 */
export interface GitPullResult {
  remote: string
  fetchedAt: string
  updated: boolean
  /** HEAD after the pull. */
  head: string
  /** Commits the fast-forward took in. */
  commits: number
}

/** `POST …/git/abort`: the operation that was under way, ended; HEAD is back where it was before it began. */
export interface GitAbortResult {
  operation: Exclude<GitOperation, 'unmerged'>
  head?: string
}

/** The pull request bound to a session (`sessions-meta.json`): where it is and which branches it joins. */
export interface GitPrBinding {
  number: number
  /** `https://<host>/<owner>/<repo>/pull/<number>`. */
  url: string
  base: string
  head: string
}

export type GitPrStatus = 'open' | 'closed' | 'merged'
export type GitReviewDecision = 'approved' | 'changes-requested' | 'review-required'

/** The bound pull request as GitHub reports it now, through your `gh`. */
export interface GitPullRequest extends GitPrBinding {
  title: string
  state: GitPrStatus
  draft: boolean
  reviewDecision?: GitReviewDecision
  /** The commit the pull request's head is at on GitHub; its checks are for this commit. */
  headSha?: string
}

export type GitCheckState = 'pass' | 'fail' | 'pending' | 'skipped'

/** One check of the pull request's head commit: a GitHub Actions job (or another check run), or a commit status. */
export interface GitCheck {
  name: string
  /** The workflow a GitHub Actions job belongs to. */
  workflow?: string
  state: GitCheckState
  startedAt?: string
  completedAt?: string
  /** A failed GitHub Actions job whose failed steps' log the Host can read (`GET …/git/pr/checks/:job/log`). */
  job?: string
}

export type GitReviewState = 'approved' | 'changes-requested' | 'commented' | 'dismissed'

/** A review, a conversation comment or a line comment of the pull request; read-only. */
export interface GitPrComment {
  kind: 'review' | 'comment' | 'line'
  author: string
  review?: GitReviewState
  /** Line comments: the file and line they are on. */
  path?: string
  line?: number
  /** Redacted, control characters removed, at most 8 KiB. */
  body: string
  at?: string
}

/** `GET /link/api/tasks/:id/git/pr`. */
export interface GitPrState {
  /** The pull request bound to the session; absent before one is created or found. */
  pr?: GitPullRequest
  /** Checks of `pr.headSha`. */
  checks: GitCheck[]
  /** Reviews and comments, oldest first, for devices whose data scope covers the session's files. */
  discussion?: GitPrComment[]
  /** Older reviews or comments were left out: only the newest are listed. */
  discussionCapped?: true
  /** Without a pull request: what 创建 PR starts from (the last commit's subject, the repository's default branch). */
  draft?: { title?: string; base?: string }
}

/** `POST …/git/pr`: the bound pull request, made now or found open for the branch (`linked`). */
export interface GitPrResult {
  pr: GitPrBinding
  /** An open pull request for the branch already existed; it was bound, nothing was created. */
  linked?: true
  replay?: true
}

/** `GET …/git/pr/checks/:job/log`: the end of a failed job's failed steps, redacted, at most 200 lines and 32 KiB. */
export interface GitCheckLog {
  name: string
  text: string
  /** Earlier lines were left out. */
  truncated?: true
}

/** Error codes of the pull request routes, besides `host-updating` for a write while an update installs. */
export type GitPrError =
  | 'gh-missing'
  | 'gh-logged-out'
  | 'gh-no-remote'
  | 'gh-unreachable'
  | 'gh-failed'
  | 'pr-exists-elsewhere'
  | 'pr-not-pushed'
  | 'pr-nothing-ahead'
  | 'pr-create-failed'
  | 'pr-input-invalid'
  | 'pr-check-not-found'

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
  | 'git-file-changed'
  | 'git-file-whole'
  | 'git-selection-invalid'
  | 'git-commit-not-found'
  | 'git-no-base'
  | 'git-result-unknown'
  | 'git-receipt-unsaved'
  | 'git-failed'
  | 'git-no-upstream'
  | 'git-repo-config'
  | 'git-remote-form'
  | 'git-fetch-auth'
  | 'git-fetch-host-key'
  | 'git-fetch-unreachable'
  | 'git-fetch-timeout'
  | 'git-fetch-failed'
  | 'git-pull-diverged'
  | 'git-pull-local-changes'
  | 'git-pull-failed'
  | 'git-drivers'
  | 'git-no-operation'
  | 'git-operation-changed'
  | 'git-abort-failed'

/** `POST /link/api/workspaces/clone`'s refusals and a clone's fixed failure reasons (`GitCloneState.code`). */
export type GitCloneError =
  | 'clone-url-invalid'
  | 'clone-url-credentials'
  | 'clone-name-invalid'
  | 'clone-folder-exists'
  | 'clone-busy'
  | 'clone-not-found'
  | 'clone-auth'
  | 'clone-host-key'
  | 'clone-unreachable'
  | 'clone-not-found-remote'
  | 'clone-timeout'
  | 'clone-failed'
  | 'clone-cancelled'

/**
 * A clone into a new project folder (`POST /link/api/workspaces/clone`, then `GET …/clone/:id`). `running` until Git
 * ends; `done` with the project it became; `failed` or `cancelled` with the folder it made removed.
 */
export interface GitCloneState {
  id: string
  state: 'running' | 'done' | 'failed' | 'cancelled'
  /** The folder's name, from the address. */
  name: string
  startedAt: string
  /** Git's progress: the phase it is in and how far it is, when it said. */
  progress?: { phase: 'connecting' | 'receiving' | 'resolving' | 'checkout'; percent?: number }
  /** `done`: the project it was added as. */
  workspaceId?: string
  /** `failed`: why, as a fixed reason. */
  code?: GitCloneError | string
  /** `done`, but the new folder could not be added as a project (its reason as `code`); the folder stays. */
  notAdded?: true
}

/** Which two versions of a file a staging diff compares: the work tree against the index, or the index against HEAD. */
export type GitStagingView = 'unstaged' | 'staged'

/**
 * Why a file is staged whole or not at all: its lines cannot be picked. `new`/`deleted`: one side has no file (a rename
 * is a deletion and a new file here). `converted`: Git rewrites its line endings or encoding on the way into the index.
 * `filtered`: a filter driver (Git LFS, for one) applies to it. `unchanged`: the two versions hold the same text.
 */
export type GitWholeReason =
  | 'binary'
  | 'large'
  | 'new'
  | 'deleted'
  | 'mode'
  | 'link'
  | 'submodule'
  | 'conflicted'
  | 'filtered'
  | 'converted'
  | 'secret'
  | 'unchanged'

/**
 * What the lines were read against: a write that picks lines sends it back, and is refused (409 `git-file-changed`) once
 * the file or its index entry is no longer this. `worktree`: SHA-256 of the file's bytes; `index` and `head`: Git's
 * object IDs; absent where that side has no file.
 */
export interface GitHunkBase {
  worktree?: string
  index?: string
  head?: string
}

/** `GET …/git/diff?view=&path=`: one file's unstaged or staged lines, for picking. */
export interface GitHunkDiff {
  view: GitStagingView
  path: string
  /** With `hunks`; a file that goes whole is not read against anything, so it has none. */
  base?: GitHunkBase
  /** The file's lines cannot be picked: it is staged or unstaged whole. No `hunks` then. */
  whole?: GitWholeReason
  /** Three lines of context; a changed line is named by its `oldLine` (removed) or `newLine` (added). */
  hunks?: ChangeHunk[]
  add?: number
  del?: number
}

/** Line numbers, both ends included. */
export type GitLineRange = [from: number, to: number]

/**
 * `POST …/git/stage-lines` and `unstage-lines`: the changed lines picked from a `GitHunkDiff`, by their numbers there.
 * `old`: removed lines (`oldLine`); `new`: added lines (`newLine`). Never patch text: the Host builds the index's new
 * content itself from the file and the index it reads.
 */
export interface GitLineSelection {
  requestId: string
  path: string
  base: GitHunkBase
  old?: GitLineRange[]
  new?: GitLineRange[]
}

/** Which of the versions a line write was read against is no longer the same (409 `git-file-changed`, as `changed`). */
export type GitFileChanged = 'worktree' | 'index' | 'head' | 'both'

export interface GitStageLinesResult {
  /** Changed lines staged or unstaged. */
  lines: number
  /** The index already held exactly this result: an earlier attempt of the same request made it. */
  replay?: true
}

/** A commit in a history list. */
export interface GitCommitEntry {
  sha: string
  /** Committer time. */
  at: string
  subject?: string
  author?: string
  /** A merge: its files are compared with its first parent. */
  merge?: true
}

/**
 * The history reads name commits and files of the session's folder, so every one of them is for devices whose data scope
 * covers its files, like 改动; any other device is refused (403 `file-scope`).
 *
 * `GET …/git/history`: the session's commits, newest first, at most 50. `base`: the commits of this branch since it left
 * `base` (main or master); `upstream`: the ones not on its upstream yet; `recent`: HEAD's latest, when neither applies.
 * With `?path=`: the commits on HEAD's line that changed that file (`range` is `file`).
 */
export interface GitHistory {
  range: 'base' | 'upstream' | 'recent' | 'file'
  base?: string
  head?: string
  commits: GitCommitEntry[]
  /** Older commits were left out. */
  more?: true
}

export interface GitHistoryFile {
  path: string
  status: 'A' | 'M' | 'D' | 'T'
  add?: number
  del?: number
  binary?: true
}

/**
 * `GET …/git/history/:sha` (a commit against its first parent) and `GET …/git/compare` (the branch's HEAD against where
 * it left `base`): the files changed, at most 500. With `?path=`: that one file's `hunks`.
 */
export interface GitCommitDiff {
  /** The newer side. */
  sha: string
  /** The older side; absent for a root commit. */
  parent?: string
  /** Compare: the branch compared with. */
  base?: string
  files: GitHistoryFile[]
  totals: { files: number; add: number; del: number }
  /** Files left out past 500. */
  more?: number
}

/** One file of a commit or of the comparison. */
export interface GitCommitFileDiff {
  sha: string
  parent?: string
  file: GitHistoryFile
  /** Absent when the content is not shown: binary, over 1 MB or 20,000 lines, a link, or a file that may hold a secret (`hidden`). */
  hunks?: ChangeHunk[]
  hidden?: 'binary' | 'large' | 'secret' | 'link'
}
