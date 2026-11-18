import { z } from 'zod'
import type { ZodType } from 'zod'
import { KNOWN_HOOKS } from '../changes/git-status.ts'
import { count, hex64, opaqueId } from './fields.ts'

const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)
const hooks = z.array(z.enum(KNOWN_HOOKS)).max(KNOWN_HOOKS.length)
const request = { sessionId: opaqueId, requestHash: hex64 }
const prNumber = z.number().int().positive().max(999_999_999)
/** A Latch worktree being removed: its project, its session when it has one, and the hash of its path. */
const worktree = { workspaceId: opaqueId, sessionId: opaqueId.optional(), worktreeHash: hex64, requestHash: hex64 }
/** Why a write that ran did not succeed. */
export const RESULT_CODES = [
  'git-stage-failed',
  'git-file-changed',
  'git-file-whole',
  'git-selection-invalid',
  'git-hook-failed',
  'git-identity-missing',
  'git-commit-failed',
  'git-commit-not-made',
  'git-push-auth',
  'git-push-non-fast-forward',
  'git-push-remote-rejected',
  'git-push-unreachable',
  'git-push-host-key',
  'git-push-failed',
  'gh-missing',
  'gh-logged-out',
  'gh-no-remote',
  'gh-unreachable',
  'gh-failed',
  'pr-exists-elsewhere',
  'pr-create-failed',
  'git-fetch-auth',
  'git-fetch-host-key',
  'git-fetch-unreachable',
  'git-fetch-timeout',
  'git-fetch-failed',
  'git-no-upstream',
  'git-pull-diverged',
  'git-pull-local-changes',
  'git-pull-failed',
  'git-abort-failed',
  'git-repo-config',
] as const
/** Why a branch switch that was recorded did not land (docs/BRANCHES.md#切换分支). */
export const SWITCH_CODES = [
  'branch-switch-config',
  'branch-switch-moved',
  'branch-switch-checked-out',
  'branch-switch-local-changes',
  'branch-switch-failed',
  /** A check right before Git started refused it (the device's scope, a turn in the folder). */
  'refused',
] as const
/** Why a clone did not become a project. */
export const CLONE_CODES = [
  'clone-auth',
  'clone-host-key',
  'clone-unreachable',
  'clone-not-found-remote',
  'clone-timeout',
  'clone-failed',
  'clone-cancelled',
  'clone-not-added',
  'clone-folder-exists',
  'clone-folder-refused',
] as const
const remoteVia = z.enum(['upstream', 'push-remote', 'origin'])
/** The one transport your Git was let use. */
const transport = z.enum(['https', 'http', 'ssh', 'file'])
const fetch = { ...request, remote: remoteVia, remoteHash: hex64, transport }

/**
 * 交付 (docs/GIT-DELIVERY.md), its pull request included. The write is recorded before Git runs and does not run when the record fails; its outcome
 * follows in `git.result`. Never a path, a message, a remote's name or URL, or anything Git printed: the remote is the
 * rule that chose it and the hash of its name.
 */
export const GIT_ACTIONS = {
  /** `lines`: staging by line, the number of changed lines picked in the one file. */
  'git.stage': z.strictObject({ ...request, files: count, filtered: z.boolean(), lines: count.optional() }),
  'git.unstage': z.strictObject({ ...request, files: count, lines: count.optional() }),
  'git.commit': z.strictObject({ ...request, preHead: oid.optional(), hooks, skipHooks: z.boolean() }),
  'git.push': z.strictObject({
    ...request,
    localSha: oid,
    remote: z.enum(['upstream', 'push-remote', 'origin']),
    remoteHash: hex64,
    refHash: hex64,
    setUpstream: z.boolean(),
    hooks,
  }),
  /** 创建 PR that made one: the remote and branches by hash, never the title or body. */
  'git.pr.create': z.strictObject({ ...request, remoteHash: hex64, headHash: hex64, baseHash: hex64, draft: z.boolean() }),
  /** 创建 PR that found the branch's pull request open and bound it instead. */
  'git.pr.link': z.strictObject({ ...request, number: prNumber, remoteHash: hex64, headHash: hex64 }),
  /** 获取: which rule chose the remote, its name's hash and the transport it was fetched over; never its address. */
  'git.fetch': z.strictObject(fetch),
  /** 拉取: a fetch, then a fast-forward from `preHead`. */
  'git.pull': z.strictObject({ ...fetch, preHead: oid.optional() }),
  /** 中止 of the operation under way, with HEAD and the number of conflicted files when it was pressed. */
  'git.abort': z.strictObject({
    ...request,
    operation: z.enum(['merge', 'rebase', 'cherry-pick', 'revert']),
    preHead: oid.optional(),
    conflicted: count,
  }),
  /**
   * 克隆 into a new folder that becomes a project, before Git runs: the transport, and hashes of the address (which
   * holds no credentials: one with them is refused), of its host and of the new folder's path.
   */
  'git.clone': z.strictObject({
    cloneHash: hex64,
    transport: z.enum(['https', 'ssh']),
    urlHash: hex64,
    hostHash: hex64,
    pathHash: hex64,
  }),
  /** After: the project it became, or why not; a failed or cancelled clone's folder was removed (`removed`). */
  'git.clone.result': z.strictObject({
    cloneHash: hex64,
    outcome: z.enum(['done', 'failed', 'cancelled']),
    code: z.enum(CLONE_CODES).optional(),
    workspaceId: opaqueId.optional(),
    removed: z.boolean().optional(),
  }),
  'git.result': z.strictObject({
    ...request,
    operation: z.enum(['stage', 'unstage', 'commit', 'push', 'pr', 'fetch', 'pull', 'abort']),
    outcome: z.enum(['done', 'failed', 'unknown']),
    code: z.enum(RESULT_CODES).optional(),
    commit: oid.optional(),
    number: prNumber.optional(),
  }),
  /**
   * 切换分支 of a project's folder (docs/BRANCHES.md#切换分支), before Git runs: the project, the request, and hashes of
   * the branch (or detached commit) it leaves and of the branch it goes to; never a name.
   */
  'git.switch': z.strictObject({ workspaceId: opaqueId, requestHash: hex64, fromHash: hex64, toHash: hex64, preHead: oid.optional() }),
  /** After: the folder is on the branch (`done`), it is not (`failed`, with why), or Git did not answer in time (`unknown`). */
  'git.switch.result': z.strictObject({
    workspaceId: opaqueId,
    requestHash: hex64,
    outcome: z.enum(['done', 'failed', 'unknown']),
    code: z.enum(SWITCH_CODES).optional(),
    head: oid.optional(),
  }),
  /**
   * Removing a Latch worktree (docs/BRANCHES.md), before Git runs: what it loses as counts, whether the removal is
   * forced (uncommitted files discarded) and whether Latch made its branch. Never a path or a file name.
   */
  'worktree.remove': z.strictObject({
    ...worktree,
    staged: count,
    unstaged: count,
    untracked: count,
    ignored: count.optional(),
    forced: z.boolean(),
    ownBranch: z.boolean(),
    /** The dialog said the branch goes; without it the branch is kept. */
    deleteBranch: z.boolean().optional(),
    /** Why the branch may go: on a default branch, no commits past its start, or no evidence (`none`). */
    merged: z.enum(['default', 'start', 'none']).optional(),
    ahead: count.optional(),
    unpushed: count.optional(),
  }),
  /** After: removed, and the branch Latch made deleted (merged and confirmed), kept, or none. */
  'worktree.result': z.strictObject({
    ...worktree,
    outcome: z.enum(['removed', 'failed']),
    branch: z.enum(['deleted', 'kept', 'none']).optional(),
    discarded: count.optional(),
  }),
} as const satisfies Record<string, ZodType>
