// 交付 (docs/GIT-DELIVERY.md): the status, staging, commit and push of a session's repository. Reads, unstaging and
// staging in a repository without filter drivers run in the restricted Git (`changes/git-status.ts`). A commit, a push
// and staging with filters are the one named exception to "the Host runs no program a repository names": the person
// starts each one, it is audited before it runs, and your own Git runs it as you, through your login shell with the
// terminal's environment, so the repository's hooks, filters, credential helper and `core.sshCommand` run as they do in
// a terminal. Nothing Latch holds (model keys, device credentials, `lmg1.`, `LATCH_*`) is in that environment, and no
// prompt can wait for an answer.
import { spawn } from 'node:child_process'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError } from '@latch/sdk'
import type {
  GitCheckLog,
  GitCommitDiff,
  GitCommitFileDiff,
  GitCommitResult,
  GitHistory,
  GitHunkDiff,
  GitLineSelection,
  GitStageLinesResult,
  GitStagingView,
  GitDeliveryKind,
  GitDeliveryRunning,
  GitDeliveryState,
  GitPrBinding,
  GitPrResult,
  GitPrState,
  GitPushResult,
  GitStageResult,
} from '@latch/protocol'
import { canonicalJson, redactKnownSecrets, sha256Hex } from '@latch/core/node-kit'
import type { RESULT_CODES } from './audit-actions/git.ts'
import { readGitLayout, type GitLayout } from './branch-reader.ts'
import { GitError, GitReader, findGit, gitOperation } from './changes/git.ts'
import { baseOfBranch, reachableCommit, readHistory, readTreeDiff, readTreeFile } from './changes/git-history.ts'
import {
  SelectionError,
  baseOf,
  comparable,
  hunkDiff,
  indexEntries,
  readVersions,
  selectionResult,
  validRanges,
} from './changes/git-hunks.ts'
import {
  GitPathError,
  KNOWN_HOOKS,
  OID,
  committedOnTop,
  PATHS_LIMIT,
  REMOTE_NAME,
  checkPaths,
  commonDirOf,
  findCommit,
  hasIdentity,
  indexTree,
  listHooks,
  readRepositoryConfig,
  IndexMovedError,
  readStatus,
  setIndexBlob,
  stageRestricted,
  subjectOf,
  unstageRestricted,
  type HookName,
  type RepositoryConfig,
} from './changes/git-status.ts'
import {
  BODY_LIMIT,
  BRANCH,
  PR_FIELDS,
  PR_LIST_FIELDS,
  createdUrl,
  discussionOf,
  DISCUSSION_JQ,
  knownGitHub,
  LINE_COMMENTS,
  LINE_COMMENTS_JQ,
  sameRepo,
  ghFailure,
  logExcerpt,
  readDefaultBranch,
  readDiscussion,
  readLineComments,
  readPrList,
  readPrView,
  repoOfPr,
  repoOfUrl,
  validTitle,
  type GhRepo,
} from './git-pr.ts'
import { codeOf } from './http-util.ts'
import type { GitRecord, SessionReceipts } from './session-meta.ts'
import { loginShell, terminalEnvironment, type ShellCommand } from './terminal/environment.ts'

export const MESSAGE_LIMIT = 64 * 1024
/** What a failure or a hook's output returns at most, after redaction: the end of it. */
export const TAIL_LIMIT = 256 * 1024
const REMOTE_LINES = 100
const TIMEOUTS = { commit: 10 * 60_000, push: 2 * 60_000, stage: 2 * 60_000, gh: 30_000, prCreate: 60_000, log: 60_000 }
/** After a stop's SIGTERM, how long the process group has before SIGKILL. */
const KILL_GRACE_MS = 5_000
/** After Git exits, how long its output pipes have to drain before they are closed. */
const PIPE_GRACE_MS = 1_000
/**
 * Run by the login shell after its profile: Git's own messages in English (so a push failure can be told apart), and
 * nothing that could wait for an answer, whatever the profile set.
 */
const SHELL_SCRIPT =
  'unset LC_ALL LANGUAGE GIT_ASKPASS SSH_ASKPASS; export LC_MESSAGES=C GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never SSH_ASKPASS_REQUIRE=never GIT_EDITOR=: GIT_PAGER=cat; exec "$0" "$@"'
/** Shells whose `-c` takes `$0` and `"$@"` as above; any other login shell is replaced by /bin/zsh. */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash'])
/**
 * Your `gh`, found on the PATH your profile sets: no prompt, pager, colour, spinner or update check. Its login is its own
 * (its configuration and the system keychain); Latch never asks it for a token and puts none in its environment.
 */
const GH_SCRIPT = SHELL_SCRIPT.replace(
  '; exec',
  ' GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 GH_NO_EXTENSION_UPDATE_NOTIFIER=1 GH_SPINNER_DISABLED=1 GH_PAGER=cat PAGER=cat NO_COLOR=1 CLICOLOR=0; exec',
)
  // A profile's enterprise token would go to whatever host `--repo` names, and these switch the host or print requests.
  .replace('unset ', 'unset GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_HOST GH_REPO GH_DEBUG DEBUG GH_MDWIDTH ')
/** How long a `gh auth status --hostname` that said yes is believed. */
const HOST_LOGIN_MS = 5 * 60_000
const HOOK_NAMES: ReadonlySet<string> = new Set(KNOWN_HOOKS)

/** The environment your Git starts with: the terminal's, without its terminal marks, and nothing that prompts. */
export function deliveryEnvironment(input: { hostEnv: NodeJS.ProcessEnv; shell: string; folder: string }): Record<string, string> {
  const env = terminalEnvironment(input)
  delete env.TERM_PROGRAM
  delete env.LC_TERMINAL
  delete env.COLORTERM
  env.TERM = 'dumb'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GCM_INTERACTIVE = 'never'
  env.SSH_ASKPASS_REQUIRE = 'never'
  return env
}

export interface DeliveryAuditEvent {
  action: 'git.stage' | 'git.unstage' | 'git.commit' | 'git.push' | 'git.pr.create' | 'git.pr.link'
  detail: Record<string, unknown>
}
export interface DeliveryResultEvent {
  operation: GitDeliveryKind
  outcome: 'done' | 'failed' | 'unknown'
  code?: (typeof RESULT_CODES)[number]
  commit?: string
  /** The pull request created or bound. */
  number?: number
}

/** The pull request bound to each session, kept with its metadata. */
export interface PrBindings {
  get(sessionId: string): GitPrBinding | undefined
  /** Settles when the metadata holds it. */
  bind(sessionId: string, pr: GitPrBinding): Promise<void>
  /** The bound pull request was merged or closed and the branch moved on: 创建 PR may make the next one. */
  unbind(sessionId: string): Promise<void>
}

/** One write of one device on one session, with the route's checks. */
export interface DeliveryCaller {
  sessionId: string
  deviceId: string
  /** The session's working folder; must be the top of a Git work tree. */
  folder: string
  /** The caller's scope, the session's access and, for these kinds, no running turn: checked again right before writing. */
  authorize: (kind: GitDeliveryKind) => Promise<void>
  /** Written before Git runs; when it throws, nothing runs. */
  audit: (event: DeliveryAuditEvent) => Promise<void>
  /** Written after; a failure is only logged. */
  result: (event: DeliveryResultEvent) => Promise<void>
}

/**
 * Which Host write holds a repository (its shared Git directory): a delivery write or a worktree removal. One at a time,
 * so a removal never runs while a delivery does, and the other way round. Every Host write that runs the user's Git
 * (delivery, pull request, worktree removal) also enters here: refused once the install window is committed, and
 * counted while it runs, so the install waits for it.
 */
export class RepositoryHolds {
  private readonly held = new Map<string, 'delivery' | 'worktree-remove'>()
  private writes = 0
  private readonly closed: () => boolean

  /** `closed`: the install window is committed (update-window.ts). */
  constructor(options: { closed?: () => boolean } = {}) {
    this.closed = options.closed ?? (() => false)
  }

  /** Git writes running now. */
  get running(): number {
    return this.writes
  }

  /** Starts a Host Git write: refused while the Host is about to stop for an update; the returned call ends it. */
  enter(): () => void {
    this.refuseWhileUpdating()
    this.writes++
    let left = false
    return () => {
      if (left) return
      left = true
      this.writes--
    }
  }

  /** Takes the repository, or undefined when something holds it already. */
  take(common: string, kind: 'delivery' | 'worktree-remove'): (() => void) | undefined {
    this.refuseWhileUpdating()
    if (this.held.has(common)) return undefined
    this.held.set(common, kind)
    return () => {
      if (this.held.get(common) === kind) this.held.delete(common)
    }
  }

  of(common: string): 'delivery' | 'worktree-remove' | undefined {
    return this.held.get(common)
  }

  private refuseWhileUpdating(): void {
    if (this.closed()) throw new AppError(409, 'host-updating', '这台电脑正在安装更新，暂时不能写入 Git。安装完成后再试。')
  }
}

export interface GitDeliveryOptions {
  /** Shared with worktree removal; a delivery of its own otherwise. */
  holds?: RepositoryHolds
  /** Your Git; found where the 改动 reader finds it by default. */
  git?: string
  /** The restricted runner's home (whose global configuration applies); the Host user's by default. */
  home?: string
  /** The environment the terminal's is built from; the Host's own by default. */
  hostEnv?: NodeJS.ProcessEnv
  shell?: () => Promise<ShellCommand>
  receipts: Pick<SessionReceipts, 'git' | 'recordGit'>
  /** The sessions' pull requests; without it the pull request step is refused. */
  prs?: PrBindings
  now?: () => number
  timeouts?: Partial<typeof TIMEOUTS>
  /** A write started or ended in the repository of this session: clients read its state again. */
  changed?: (sessionId: string) => void
  log: (text: string) => void
}

interface Running extends GitDeliveryRunning {
  sessionId: string
  /** The process group of your Git, while it runs. */
  pid?: number
}

interface Outcome {
  code: number | null
  timedOut: boolean
  /** stdout and stderr together, the last `TAIL_LIMIT` bytes. */
  output: Buffer
  stdout: Buffer
  stderr: Buffer
  /** Hooks the top-level Git ran, in order, with their exit codes. */
  hooks: Array<{ name: string; code?: number }>
}

type Program = 'git' | 'gh'

const refuse = (code: string, message: string, details?: Record<string, unknown>) => new AppError(409, code, message, details)
const gitFailed = () => new AppError(500, 'git-failed', 'Git 没有完成读取，请稍后再试。')
const existsElsewhere = () => new AppError(409, 'pr-exists-elsewhere', '这个分支已有打开的 PR，没有再建一个。在 GitHub 上查看它。')
const noRemote = () => new AppError(409, 'gh-no-remote', '推送的远端不是 GitHub 上的仓库。')
const unknown = (details: Record<string, unknown> = {}) =>
  new AppError(504, 'git-result-unknown', '还不知道 Git 是否完成。用同一个请求重试会查看结果，不会再执行一次。', {
    retry: true,
    ...details,
  })

function payloadHash(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

/** Text a person may read: escapes and carriage-return overwrites resolved, other control characters gone, redacted. */
export function readableTail(bytes: Buffer, limit = TAIL_LIMIT): string {
  const text = bytes
    .toString('utf8')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/gu, '')
    .split('\n')
    .map(line => line.slice(line.lastIndexOf('\r', line.length - 2) + 1).replace(/\r$/u, ''))
    .join('\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '')
  const redacted = redactKnownSecrets(text).trim()
  return redacted.length > limit ? redacted.slice(redacted.length - limit) : redacted
}

/** The hook that failed: the last one the top-level Git ran that exited with a status other than 0. */
function failedHook(outcome: Outcome): { name: HookName; code: number } | undefined {
  const failed = outcome.hooks.findLast(hook => hook.code !== undefined && hook.code !== 0)
  return failed && HOOK_NAMES.has(failed.name) ? { name: failed.name as HookName, code: failed.code! } : undefined
}

/** Reads the hooks out of a trace2 event file: only the top-level process's events (a sid without `/`). */
function traceHooks(text: string, hooks: Outcome['hooks'], children: Map<number, number>): void {
  for (const line of text.split('\n')) {
    if (!line.includes('"child_')) continue
    let event: { event?: unknown; sid?: unknown; child_id?: unknown; child_class?: unknown; hook_name?: unknown; code?: unknown }
    try {
      event = JSON.parse(line) as typeof event
    } catch {
      continue
    }
    if (typeof event.sid !== 'string' || event.sid.includes('/') || typeof event.child_id !== 'number') continue
    if (event.event === 'child_start' && event.child_class === 'hook' && typeof event.hook_name === 'string') {
      children.set(event.child_id, hooks.length)
      hooks.push({ name: event.hook_name })
    } else if (event.event === 'child_exit' && typeof event.code === 'number') {
      const index = children.get(event.child_id)
      if (index !== undefined) hooks[index]!.code = event.code
    }
  }
}

/** Why a push did not go through, from Git's porcelain lines and its own (English) messages. */
function pushFailure(outcome: Outcome): AppError {
  const stdout = outcome.stdout.toString('utf8'),
    stderr = outcome.stderr.toString('utf8')
  const hook = failedHook(outcome)
  if (hook?.name === 'pre-push')
    return new AppError(422, 'git-hook-failed', `钩子 ${hook.name} 没有通过，没有推送。`, {
      hook: hook.name,
      exitCode: hook.code,
      tail: readableTail(outcome.output),
    })
  const rejected = stdout.split('\n').filter(line => line.startsWith('!\t'))
  if (rejected.some(line => line.includes('remote rejected'))) {
    const remoteLines = stderr
      .split('\n')
      .filter(line => line.startsWith('remote: '))
      .slice(-REMOTE_LINES)
      .map(line => readableTail(Buffer.from(line.slice('remote: '.length)), 500))
    return new AppError(422, 'git-push-remote-rejected', '远端拒绝了这次推送。', { remoteLines })
  }
  if (rejected.some(line => /non-fast-forward|fetch first|stale info/u.test(line)))
    return new AppError(422, 'git-push-non-fast-forward', '远端有这里没有的提交，没有推送。先在终端拉取并合并，再推送。')
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key .*(?:not known|changed)/iu.test(stderr))
    return new AppError(422, 'git-push-host-key', '远端主机的密钥没有核实，没有推送。先在终端连接一次这个远端。')
  if (
    /Authentication failed|could not read (?:Username|Password)|Permission denied \(|terminal prompts disabled|Invalid username or password|Access denied|returned error: 40[13]|denied to |Repository not found/iu.test(
      stderr,
    )
  )
    return new AppError(422, 'git-push-auth', '远端没有接受这台电脑上的凭据，没有推送。在终端里登录或配置凭据后再试。')
  if (
    /Could not resolve host|Connection refused|Connection timed out|Operation timed out|Network is unreachable|No route to host|Connection reset|unable to access|Could not read from remote repository|does not appear to be a git repository/iu.test(
      stderr,
    )
  )
    return new AppError(422, 'git-push-unreachable', '连不上远端，没有推送。')
  return new AppError(422, 'git-push-failed', `推送没有完成（退出码 ${outcome.code ?? '无'}）。`, { exitCode: outcome.code ?? -1 })
}

type PushVia = 'upstream' | 'push-remote' | 'origin'

/**
 * Where a push of `branch` goes, from the repository's configuration only: always the branch of the same name, on the
 * push remote (`branch.<b>.pushRemote`, else `remote.pushDefault`) when one is set, else on the upstream's remote when
 * the upstream is that same branch, else on `origin`, which then becomes the upstream. Anything else is refused.
 */
export function pushTarget(config: RepositoryConfig, branch: string): { remote: string; ref: string; setUpstream: boolean; via: PushVia } {
  const ref = `refs/heads/${branch}`
  const usable = (name: string) => REMOTE_NAME.test(name) && config.remotes.has(name)
  const upstream = config.configuredUpstream
  if (config.pushRemote !== undefined) {
    if (!usable(config.pushRemote)) throw refuse('git-remote-invalid', '推送远端（pushRemote）不是这个仓库配置的远端，没有推送。')
    return { remote: config.pushRemote, ref, setUpstream: !upstream, via: 'push-remote' }
  }
  if (upstream) {
    if (!upstream.remote || !upstream.ref || !usable(upstream.remote))
      throw refuse('git-remote-invalid', '这个分支的上游不是这个仓库配置的远端，没有推送。')
    if (upstream.ref !== ref)
      throw refuse('git-upstream-other-branch', '这个分支的上游是另一个分支，没有推送。在终端里推送，或把上游改成同名分支。')
    return { remote: upstream.remote, ref, setUpstream: false, via: 'upstream' }
  }
  if (config.remotes.has('origin')) return { remote: 'origin', ref, setUpstream: true, via: 'origin' }
  throw refuse('git-no-remote', '这个仓库没有远端，提交留在本地。')
}

/** Whether the push records its upstream: only on the branch that was pushed; a retry may find HEAD elsewhere by now. */
function upstreamOn(target: { ref: string; setUpstream: boolean }, branch: string | undefined): branch is string {
  return target.setUpstream && branch !== undefined && target.ref === `refs/heads/${branch}`
}

/** A rejection while the remote's branch was locked or had moved under it: another update was under way there. */
const RACING =
  /cannot lock ref|failed to lock|failed to update ref|reference already exists|is at [0-9a-f]+ but expected|incorrect old value|stale info/iu

/**
 * Whether a re-run push that failed settles a retry whose first attempt's result is unknown, once a second `ls-remote`
 * after it showed the remote's branch without the commit (any other answer to that keeps it unknown, `landed` makes it
 * done). `output`: Git's stdout and stderr.
 */
function settlesRetry(code: string, output: string): boolean {
  switch (code) {
    // The remote's hook refused the update: settled, unless the branch was locked or not at the value Git read, which is
    // what another update (the first attempt's, still landing) looks like from here.
    case 'git-push-remote-rejected':
      return !RACING.test(output)
    // The remote has commits this repository lacks: it may have moved on top of the first attempt; never settled.
    case 'git-push-non-fast-forward':
      return false
    // `pre-push`, credentials, host key, connection or anything else: this run learned nothing, but the remote has just
    // answered without the commit, so the first attempt is not there and this one was not taken.
    case 'git-hook-failed':
    case 'git-push-auth':
    case 'git-push-host-key':
    case 'git-push-unreachable':
    case 'git-push-failed':
    default:
      return !RACING.test(output)
  }
}

/** The receipt's answer, for a retry with the same request. */
function storedFailure(receipt: GitRecord): AppError {
  const details = {
    ...(receipt.hook ? { hook: receipt.hook } : {}),
    ...(receipt.exitCode !== undefined ? { exitCode: receipt.exitCode } : {}),
    replay: true,
  }
  const code =
    receipt.code
    ?? (receipt.operation === 'commit' ? 'git-commit-failed' : receipt.operation === 'pr' ? 'pr-create-failed' : 'git-push-failed')
  const status = code === 'git-commit-not-made' || code.startsWith('gh-') || code === 'pr-exists-elsewhere' ? 409 : 422
  return new AppError(status, code, '这个请求之前没有成功，没有再执行一次。', details)
}

/** Refusals of a line write that come from looking at the file and the index: nothing was written. */
const LINE_REFUSALS = ['git-file-changed', 'git-file-whole', 'git-selection-invalid'] as const
type LineRefusal = (typeof LINE_REFUSALS)[number]

/** A line write's receipt says it did not write: the same answer again, marked as the receipt's. */
function linesFailure(code: string | undefined): AppError {
  const known = code ?? 'git-stage-failed'
  return new AppError(LINE_REFUSALS.some(item => item === known) ? 409 : 422, known, '这个请求之前没有写入，没有再执行一次。', {
    replay: true,
  })
}

/** The writes of 交付, one at a time per repository, and its status read. */
export class GitDelivery {
  private readonly binary: string | undefined
  private readonly reader: GitReader | undefined
  private readonly hostEnv: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly timeouts: typeof TIMEOUTS
  private readonly holds: RepositoryHolds
  /** By the repository's shared Git directory. */
  private readonly running = new Map<string, Running>()
  /** Requests under way, by session, device and request: a retry waits for the same answer. */
  private readonly inflight = new Map<string, { payload: string; answer: Promise<unknown> }>()
  /** Stage and unstage answers, for a retry after a lost response; they are safe to repeat, so not kept on disk. */
  private readonly answered = new Map<string, { payload: string; result: GitStageResult }>()
  /** Process groups of your `gh` reading a pull request, stopped with the rest on close. */
  private readonly reading = new Set<Running>()
  /** GitHub Enterprise Server hosts `gh` said it has a login for, until when. */
  private readonly hostLogins = new Map<string, number>()
  private closing = false

  constructor(private readonly options: GitDeliveryOptions) {
    this.binary = findGit(options.git ? [options.git] : undefined)
    this.reader = this.binary
      ? new GitReader({ binary: this.binary, timeoutMs: 30_000, ...(options.home ? { home: options.home } : {}) })
      : undefined
    this.hostEnv = options.hostEnv ?? process.env
    this.now = options.now ?? Date.now
    this.timeouts = { ...TIMEOUTS, ...options.timeouts }
    this.holds = options.holds ?? new RepositoryHolds()
  }

  /** Stops every Git it started (SIGTERM, then SIGKILL): a commit stopped this way is answered by its receipt later. */
  async close(): Promise<void> {
    this.closing = true
    for (const running of [...this.running.values(), ...this.reading]) if (running.pid) signal(running.pid, 'SIGTERM')
  }

  private git(): GitReader {
    if (!this.reader) throw refuse('git-no-git', '这台电脑上找不到 Git。安装 Git（或 Xcode 命令行工具）后再试。')
    return this.reader
  }

  private async layout(folder: string): Promise<GitLayout> {
    this.git()
    const layout = await readGitLayout(folder)
    if (!layout) throw refuse('git-not-repository', '会话的文件夹不是 Git 仓库的顶层文件夹。')
    return layout
  }

  private home(): string {
    return this.options.home ?? this.hostEnv.HOME ?? homedir()
  }

  async state(folder: string): Promise<GitDeliveryState> {
    const git = this.git(),
      layout = await this.layout(folder)
    try {
      const [config, common, operation] = await Promise.all([
        readRepositoryConfig(git, layout),
        commonDirOf(git, layout),
        gitOperation(layout),
      ])
      const [status, hooks] = await Promise.all([readStatus(git, layout, config.drivers), listHooks(config, layout, common, this.home())])
      const running = this.running.get(common)
      let remote: string | undefined
      try {
        remote = 'branch' in layout.head ? pushTarget(config, layout.head.branch).remote : undefined
      } catch {
        remote = undefined
      }
      return {
        ...(status.branch ? { branch: status.branch } : {}),
        ...(status.head ? { head: status.head } : {}),
        ...(status.upstream ? { upstream: status.upstream } : {}),
        ahead: status.ahead,
        behind: status.behind,
        staged: status.staged,
        unstaged: status.unstaged,
        untracked: status.untracked,
        conflicted: status.conflicted,
        ...(status.more ? { more: status.more } : {}),
        ...(operation ? { gitOperation: operation } : {}),
        ...(running
          ? {
              running: {
                kind: running.kind,
                requestId: running.requestId,
                startedAt: running.startedAt,
                ...(running.hook ? { hook: running.hook } : {}),
              },
            }
          : {}),
        hooks,
        filters: config.drivers.length > 0,
        ...(remote && REMOTE_NAME.test(remote) ? { remote } : {}),
      }
    } catch (error) {
      if (error instanceof GitError) throw gitFailed()
      throw error
    }
  }

  /** One write: the same request gets the same answer; the repository takes one write at a time. */
  private once<T>(caller: DeliveryCaller, requestId: string, payload: string, work: () => Promise<T>): Promise<T> {
    const key = `${caller.sessionId}\n${caller.deviceId}\n${requestId}`
    const current = this.inflight.get(key)
    if (current) {
      if (current.payload !== payload) throw refuse('request-conflict', '同一个请求标识不能用于不同的操作。')
      return current.answer as Promise<T>
    }
    const answer = work().finally(() => {
      if (this.inflight.get(key)?.answer === answer) this.inflight.delete(key)
    })
    this.inflight.set(key, { payload, answer })
    return answer
  }

  /** Takes the repository for one write, or refuses with what is under way there. */
  private async hold<T>(
    caller: DeliveryCaller,
    layout: GitLayout,
    kind: GitDeliveryKind,
    requestId: string,
    work: (running: Running, common: string) => Promise<T>,
  ): Promise<T> {
    if (this.closing) throw new AppError(503, 'host-closing', '运行节点正在关闭')
    let common: string
    try {
      common = await commonDirOf(this.git(), layout)
    } catch {
      throw gitFailed()
    }
    const busy = this.running.get(common)
    if (busy)
      throw refuse('git-busy', '这个仓库正在进行另一个交付操作，等它结束后再试。', {
        running: { kind: busy.kind, requestId: busy.requestId, startedAt: busy.startedAt, ...(busy.hook ? { hook: busy.hook } : {}) },
      })
    const release = this.holds.take(common, 'delivery')
    if (!release) throw refuse('git-busy', '这个仓库正在移除一个工作树，等它结束后再试。')
    const running: Running = { kind, requestId, startedAt: new Date(this.now()).toISOString(), sessionId: caller.sessionId }
    this.running.set(common, running)
    this.options.changed?.(caller.sessionId)
    try {
      // A pull request is made on GitHub and leaves the work tree alone.
      if (kind !== 'pr' && (await gitOperation(layout).catch(() => 'unmerged' as const)))
        throw refuse('git-operation-in-progress', '仓库正在合并、变基、拣选或还原，在终端里完成后再试。')
      return await work(running, common)
    } finally {
      release()
      if (this.running.get(common) === running) this.running.delete(common)
      this.options.changed?.(caller.sessionId)
    }
  }

  private async config(layout: GitLayout): Promise<RepositoryConfig> {
    try {
      return await readRepositoryConfig(this.git(), layout)
    } catch {
      throw gitFailed()
    }
  }

  private async reportResult(caller: DeliveryCaller, event: DeliveryResultEvent): Promise<void> {
    try {
      await caller.result(event)
    } catch (error) {
      this.options.log(`交付结果没有写入审计：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async stage(caller: DeliveryCaller, input: { requestId: string; paths: string[] }): Promise<GitStageResult> {
    return this.index(caller, 'stage', input)
  }

  async unstage(caller: DeliveryCaller, input: { requestId: string; paths: string[] }): Promise<GitStageResult> {
    return this.index(caller, 'unstage', input)
  }

  private index(caller: DeliveryCaller, kind: 'stage' | 'unstage', input: { requestId: string; paths: string[] }): Promise<GitStageResult> {
    const payload = payloadHash({ kind, paths: [...input.paths].sort() })
    const key = `${caller.sessionId}\n${caller.deviceId}\n${input.requestId}`
    const earlier = this.answered.get(key)
    if (earlier) {
      if (earlier.payload !== payload) throw refuse('request-conflict', '同一个请求标识不能用于不同的操作。')
      return Promise.resolve(earlier.result)
    }
    return this.once(caller, input.requestId, payload, async () => {
      if (!input.paths.length || input.paths.length > PATHS_LIMIT)
        throw new AppError(400, 'git-paths-invalid', `一次可以选 1 到 ${PATHS_LIMIT} 个文件。`)
      const layout = await this.layout(caller.folder)
      let paths: string[]
      try {
        paths = await checkPaths(layout.root, input.paths)
      } catch (error) {
        if (error instanceof GitPathError)
          throw new AppError(400, 'git-paths-invalid', '文件路径无效：必须是仓库里的相对路径，不能经过符号链接。')
        throw error
      }
      const result = await this.hold(caller, layout, kind, input.requestId, async running => {
        const git = this.git()
        const config = await this.config(layout)
        const head = await git.commit(layout, 'HEAD').catch(() => undefined)
        const filtered = kind === 'stage' && config.drivers.length > 0
        await caller.authorize(kind)
        await caller.audit({
          action: kind === 'stage' ? 'git.stage' : 'git.unstage',
          detail: {
            sessionId: caller.sessionId,
            requestHash: sha256Hex(input.requestId),
            files: paths.length,
            ...(kind === 'stage' ? { filtered } : {}),
          },
        })
        if (filtered) {
          const outcome = await this.runYourGit(layout, running, ['add', '--pathspec-from-file=PATHS', '--pathspec-file-nul'], {
            timeoutMs: this.timeouts.stage,
            paths,
          })
          if (outcome.timedOut) {
            await this.reportResult(caller, { operation: kind, outcome: 'unknown' })
            throw unknown()
          }
          if (outcome.code !== 0) {
            await this.reportResult(caller, { operation: kind, outcome: 'failed', code: 'git-stage-failed' })
            throw new AppError(422, 'git-stage-failed', `暂存没有完成（退出码 ${outcome.code ?? '无'}）。`, {
              exitCode: outcome.code ?? -1,
              tail: readableTail(outcome.output),
            })
          }
        } else {
          try {
            if (kind === 'stage') await stageRestricted(git, layout, paths, this.timeouts.stage)
            else await unstageRestricted(git, layout, paths, config.drivers, head, this.timeouts.stage)
          } catch (error) {
            const timeout = error instanceof GitError && error.reason === 'timeout'
            await this.reportResult(caller, {
              operation: kind,
              outcome: timeout ? 'unknown' : 'failed',
              ...(timeout ? {} : { code: 'git-stage-failed' }),
            })
            if (timeout) throw unknown()
            throw new AppError(
              422,
              'git-stage-failed',
              kind === 'stage' ? '暂存没有完成：Git 拒绝了其中的文件（可能被忽略）。' : '取消暂存没有完成。',
            )
          }
        }
        await this.reportResult(caller, { operation: kind, outcome: 'done' })
        return { files: paths.length, ...(filtered ? { filtered: true as const } : {}) }
      })
      this.answered.set(key, { payload, result })
      while (this.answered.size > 512) this.answered.delete(this.answered.keys().next().value!)
      return result
    })
  }

  /** One path of a request, checked like the paths of a whole-file stage. */
  private async onePath(layout: GitLayout, path: string): Promise<string> {
    try {
      return (await checkPaths(layout.root, [path]))[0]!
    } catch (error) {
      if (error instanceof GitPathError)
        throw new AppError(400, 'git-paths-invalid', '文件路径无效：必须是仓库里的相对路径，不能经过符号链接。')
      throw error
    }
  }

  /** `GET …/git/diff`: one file's unstaged or staged lines, with what they were read against. */
  async hunkDiff(folder: string, view: GitStagingView, path: string): Promise<GitHunkDiff> {
    const git = this.git(),
      layout = await this.layout(folder)
    const checked = await this.onePath(layout, path)
    try {
      return hunkDiff(checked, view, await readVersions(git, layout, checked, view))
    } catch (error) {
      if (error instanceof GitError) throw gitFailed()
      throw error
    }
  }

  /**
   * Stages or unstages the picked lines of one file. The index's new content is built here from the file and the index
   * as they are now, and a request read against other versions is refused. The write has a receipt like a commit's:
   * `pending` before it, `done` after. A retry of a request whose answer was lost never guesses: a `done` receipt
   * answers it, and a receipt left open is settled by what the index holds (the blob the write puts there: it landed;
   * the entry it replaces: it did not, and the request runs as new); anything else stays 「结果未知」.
   */
  async stageLines(caller: DeliveryCaller, kind: 'stage' | 'unstage', input: GitLineSelection): Promise<GitStageLinesResult> {
    if (!validRanges(input.old) || !validRanges(input.new))
      throw new AppError(400, 'git-selection-invalid', '选中的行无效：行号要从小到大、互不重叠，一次最多两万行。')
    const payload = payloadHash({ kind, lines: true, path: input.path, base: input.base, old: input.old ?? [], new: input.new ?? [] })
    return this.once(caller, input.requestId, payload, async () => {
      const earlier = this.options.receipts.git(caller.sessionId, caller.deviceId, input.requestId)
      if (earlier) {
        if (earlier.operation !== kind || earlier.payloadHash !== payload)
          throw refuse('request-conflict', '同一个请求标识不能用于不同的操作。')
        if (earlier.state === 'done') return { lines: earlier.lines ?? 1, replay: true as const }
        if (earlier.state === 'failed') throw linesFailure(earlier.code)
      }
      const layout = await this.layout(caller.folder)
      const path = await this.onePath(layout, input.path)
      const view: GitStagingView = kind === 'stage' ? 'unstaged' : 'staged'
      return this.hold(caller, layout, kind, input.requestId, async running => {
        const git = this.git()
        const changed = (which: 'worktree' | 'index' | 'head' | 'both') =>
          refuse('git-file-changed', '这个文件在读取之后又变了，没有写入。重新读取后再选。', { changed: which })
        const invalid = (error: unknown) => {
          if (!(error instanceof SelectionError)) return error
          return error.reason === 'empty' || error.reason === 'out-of-range'
            ? new AppError(400, 'git-selection-invalid', '没有选中可以暂存的行。')
            : refuse('git-selection-invalid', '选中的行已不是这个文件的改动，没有写入。重新读取后再选。')
        }
        const stamp = () => new Date(this.now()).toISOString()
        if (earlier) {
          // An attempt of this request started and its end is not on record. Only the index says what it did.
          let held: string | undefined
          try {
            held = (await indexEntries(git, layout, path)).find(entry => entry.stage === 0)?.oid
          } catch {
            throw unknown()
          }
          if (held !== undefined && held === earlier.resultOid) {
            await this.record(caller, { ...earlier, state: 'done', at: stamp() })
            await this.reportResult(caller, { operation: kind, outcome: 'done' })
            return { lines: earlier.lines ?? 1, replay: true as const }
          }
          // Neither what it would have written nor what it would have replaced: it may have landed and been changed since.
          if (held === undefined || held !== earlier.preIndex) throw unknown()
        }
        /** A refusal that came from looking at the repository settles an open receipt: that attempt did not write. */
        const settle = async (error: unknown): Promise<LineRefusal | undefined> => {
          const code = error instanceof AppError ? LINE_REFUSALS.find(item => item === error.code) : undefined
          if (earlier && code) await this.record(caller, { ...earlier, state: 'failed', code, at: stamp() })
          return code
        }
        /** What this request makes of the file as it is now: refusals first, then the index's new content. */
        const plan = async () => {
          const versions = await readVersions(git, layout, path, view)
          const compared = comparable(path, versions, view)
          const now = baseOf(versions)
          const other = kind === 'stage' ? 'worktree' : 'head'
          const otherSame = now[other] === input.base[other]
          // A request that names the versions it read is told when they are gone, before why the file may go whole now.
          const stale = now.index !== input.base.index ? changed(otherSame ? 'index' : 'both') : otherSame ? undefined : changed(other)
          if (stale && input.base.index !== undefined) throw stale
          if (typeof compared === 'string') throw refuse('git-file-whole', '这个文件只能整个暂存或取消暂存。', { whole: compared })
          if (stale) throw stale
          return { ...selectionResult(compared, input, kind), mode: versions.index!.mode, previous: versions.index!.oid! }
        }
        let result: Awaited<ReturnType<typeof plan>>
        try {
          result = await plan()
        } catch (error) {
          if (error instanceof GitError) throw earlier ? unknown() : gitFailed()
          const refusal = invalid(error)
          await settle(refusal)
          throw refusal
        }
        await caller.authorize(kind)
        await caller.audit({
          action: kind === 'stage' ? 'git.stage' : 'git.unstage',
          detail: {
            sessionId: caller.sessionId,
            requestHash: sha256Hex(input.requestId),
            files: 1,
            lines: result.lines,
            ...(kind === 'stage' ? { filtered: false } : {}),
          },
        })
        // From here every way out is told to the audit log as well.
        const failed = async (code: (typeof RESULT_CODES)[number]) => {
          await this.reportResult(caller, { operation: kind, outcome: 'failed', code })
        }
        let final: Awaited<ReturnType<typeof plan>>
        try {
          // The checks above awaited: the file is read once more, and nothing is written unless it is still the same.
          final = await plan()
          if (final.oid !== result.oid || final.previous !== result.previous) throw changed('both')
        } catch (error) {
          const refusal =
            error instanceof GitError ? new AppError(422, 'git-stage-failed', '暂存没有完成：Git 没有读出这个文件。') : invalid(error)
          await failed((await settle(refusal)) ?? 'git-stage-failed')
          throw refusal
        }
        const pending: GitRecord = {
          kind: 'git',
          operation: kind,
          requestId: input.requestId,
          deviceId: caller.deviceId,
          payloadHash: payload,
          state: 'pending',
          preIndex: final.previous,
          resultOid: final.oid,
          lines: final.lines,
          startedAt: running.startedAt,
          at: stamp(),
        }
        try {
          await this.record(caller, pending, true)
        } catch (error) {
          await failed('git-stage-failed')
          throw error
        }
        try {
          await setIndexBlob(git, layout, { path, mode: final.mode, oid: final.oid }, final.previous, final.text, this.timeouts.stage, () =>
            caller.authorize(kind),
          )
        } catch (error) {
          if (error instanceof GitError && error.reason === 'timeout') {
            await this.record(caller, { ...pending, state: 'unknown', at: stamp() })
            await this.reportResult(caller, { operation: kind, outcome: 'unknown' })
            throw unknown()
          }
          // Authorization was lost, the entry moved, or Git refused: the index was not updated.
          const code = error instanceof IndexMovedError ? 'git-file-changed' : 'git-stage-failed'
          await this.record(caller, { ...pending, state: 'failed', code, at: stamp() })
          await failed(code)
          if (error instanceof AppError) throw error
          if (error instanceof IndexMovedError) throw changed('index')
          throw new AppError(422, 'git-stage-failed', kind === 'stage' ? '暂存没有完成。' : '取消暂存没有完成。')
        }
        await this.record(caller, { ...pending, state: 'done', at: stamp() })
        await this.reportResult(caller, { operation: kind, outcome: 'done' })
        return { lines: final.lines }
      })
    })
  }

  /** `GET …/git/history`: the session's commits, or one file's. */
  async history(folder: string, options: { path?: string } = {}): Promise<GitHistory> {
    const git = this.git(),
      layout = await this.layout(folder)
    const path = options.path === undefined ? undefined : await this.onePath(layout, options.path)
    try {
      return await readHistory(git, layout, await readRepositoryConfig(git, layout), {
        ...(path !== undefined ? { path } : {}),
      })
    } catch (error) {
      if (error instanceof GitError) throw gitFailed()
      throw error
    }
  }

  /** Both ends of a history read: a commit HEAD reaches against its first parent, or HEAD against where it left main. */
  private async ends(layout: GitLayout, sha: string | undefined): Promise<{ from?: string; to: string; base?: string }> {
    const git = this.git()
    try {
      if (sha !== undefined) {
        const commit = await reachableCommit(git, layout, sha)
        if (!commit) throw new AppError(404, 'git-commit-not-found', '这个分支上没有这个提交。')
        return { to: commit.sha, ...(commit.parent ? { from: commit.parent } : {}) }
      }
      const head = await git.commit(layout, 'HEAD')
      const base = head ? await baseOfBranch(git, layout, head) : undefined
      if (!head || !base) throw refuse('git-no-base', '没有可以比较的基线：不在分支上、就在主分支上，或没有主分支。')
      return { from: base.fork, to: head, base: base.name }
    } catch (error) {
      if (error instanceof GitError) throw gitFailed()
      throw error
    }
  }

  /** `GET …/git/history/:sha` and `GET …/git/compare`: the files changed. */
  async treeDiff(folder: string, options: { sha?: string } = {}): Promise<GitCommitDiff> {
    const git = this.git(),
      layout = await this.layout(folder)
    const ends = await this.ends(layout, options.sha)
    try {
      const diff = await readTreeDiff(git, layout, ends.from, ends.to)
      return { sha: ends.to, ...(ends.from ? { parent: ends.from } : {}), ...(ends.base ? { base: ends.base } : {}), ...diff }
    } catch (error) {
      if (error instanceof GitError) throw gitFailed()
      throw error
    }
  }

  /** One file of a commit or of the comparison, for a device that may read the session's files. */
  async treeFile(folder: string, options: { sha?: string; path: string }): Promise<GitCommitFileDiff> {
    const git = this.git(),
      layout = await this.layout(folder)
    const path = await this.onePath(layout, options.path)
    const ends = await this.ends(layout, options.sha)
    try {
      const file = await readTreeFile(git, layout, ends.from, ends.to, path)
      if (!file) throw new AppError(404, 'git-commit-not-found', '这个提交没有改这个文件。')
      return { sha: ends.to, ...(ends.from ? { parent: ends.from } : {}), ...file }
    } catch (error) {
      if (error instanceof GitError) throw gitFailed()
      throw error
    }
  }

  async commit(caller: DeliveryCaller, input: { requestId: string; message: string; skipHooks?: boolean }): Promise<GitCommitResult> {
    const subject = subjectOf(input.message)
    if (!subject || Buffer.byteLength(input.message) > MESSAGE_LIMIT || input.message.includes('\0'))
      throw new AppError(400, 'git-message-invalid', '提交信息不能为空，最多 64 KB。')
    const payload = payloadHash({ kind: 'commit', message: input.message, skipHooks: !!input.skipHooks })
    return this.once(caller, input.requestId, payload, async () => {
      const receipt = this.options.receipts.git(caller.sessionId, caller.deviceId, input.requestId)
      if (receipt) {
        if (receipt.operation !== 'commit' || receipt.payloadHash !== payload)
          throw refuse('request-conflict', '同一个请求标识不能用于不同的操作。')
        return this.answerCommit(caller, receipt)
      }
      const layout = await this.layout(caller.folder)
      return this.hold(caller, layout, 'commit', input.requestId, async running => {
        const git = this.git()
        const config = await this.config(layout)
        let preHead: string | undefined, hooks: HookName[]
        try {
          const status = await readStatus(git, layout, config.drivers)
          if (status.conflictedCount) throw refuse('git-conflicted', '有冲突的文件，在终端里解决后再提交。')
          if (!status.stagedCount) throw refuse('git-nothing-staged', '没有暂存的改动。')
          if (!(await hasIdentity(git, layout)))
            throw refuse('git-identity-missing', 'Git 不知道提交者是谁。在终端里设置 user.name 与 user.email 后再试。')
          preHead = await git.commit(layout, 'HEAD')
          hooks = await listHooks(config, layout, await commonDirOf(git, layout), this.home())
        } catch (error) {
          if (error instanceof GitError) throw gitFailed()
          throw error
        }
        await caller.authorize('commit')
        await caller.audit({
          action: 'git.commit',
          detail: {
            sessionId: caller.sessionId,
            requestHash: sha256Hex(input.requestId),
            ...(preHead ? { preHead } : {}),
            hooks: input.skipHooks ? [] : hooks,
            skipHooks: !!input.skipHooks,
          },
        })
        // Only now: `write-tree` writes tree objects, which is a write like any other.
        const tree = await indexTree(git, layout).catch(() => {
          throw gitFailed()
        })
        const pending: GitRecord = {
          kind: 'git',
          operation: 'commit',
          requestId: input.requestId,
          deviceId: caller.deviceId,
          payloadHash: payload,
          state: 'pending',
          ...(preHead ? { preHead } : {}),
          indexTree: tree,
          subjectHash: sha256Hex(subject),
          ...(input.skipHooks ? { skipHooks: true as const } : {}),
          headRef: 'branch' in layout.head ? `refs/heads/${layout.head.branch}` : 'HEAD',
          startedAt: running.startedAt,
          at: new Date(this.now()).toISOString(),
        }
        await this.record(caller, pending, true)
        const outcome = await this.runYourGit(
          layout,
          running,
          ['commit', '--quiet', '--cleanup=whitespace', '--file=MESSAGE', ...(input.skipHooks ? ['--no-verify'] : [])],
          { timeoutMs: this.timeouts.commit, message: input.message },
        )
        // Git says it committed: the new HEAD on top of the old one is that commit, whatever a hook did to its message.
        // Otherwise, the commit the attempt would have made, if it made one before it was stopped.
        const made =
          outcome.code === 0 && !outcome.timedOut
            ? await committedOnTop(git, layout, preHead)
            : await findCommit(git, layout, { ...pending, subjectHash: sha256Hex(subject) }).catch(() => undefined)
        if (made) {
          await this.record(caller, { ...pending, state: 'done', commit: made, at: new Date(this.now()).toISOString() })
          await this.reportResult(caller, { operation: 'commit', outcome: 'done', commit: made })
          const hookOutput = outcome.hooks.length ? readableTail(outcome.output) : ''
          return { commit: made, ...(hookOutput ? { hookOutput } : {}) }
        }
        if (outcome.timedOut || outcome.code === 0) {
          // Stopped, or Git said it committed and the commit is not where it should be: nothing to tell for sure.
          await this.record(caller, { ...pending, state: 'unknown', at: new Date(this.now()).toISOString() })
          await this.reportResult(caller, { operation: 'commit', outcome: 'unknown' })
          throw unknown()
        }
        const hook = failedHook(outcome)
        const tail = readableTail(outcome.output)
        const identity = /Please tell me who you are|unable to auto-detect email address|empty ident name/u.test(
          outcome.stderr.toString('utf8'),
        )
        const code = hook ? 'git-hook-failed' : identity ? 'git-identity-missing' : 'git-commit-failed'
        await this.record(caller, {
          ...pending,
          state: 'failed',
          code,
          ...(hook ? { hook: hook.name, exitCode: hook.code } : { exitCode: outcome.code ?? -1 }),
          at: new Date(this.now()).toISOString(),
        })
        await this.reportResult(caller, { operation: 'commit', outcome: 'failed', code })
        if (hook)
          throw new AppError(422, code, `钩子 ${hook.name} 没有通过，没有生成提交，暂存不变。`, {
            hook: hook.name,
            exitCode: hook.code,
            tail,
          })
        if (identity) throw refuse(code, 'Git 不知道提交者是谁。在终端里设置 user.name 与 user.email 后再试。')
        throw new AppError(422, code, `提交没有完成（退出码 ${outcome.code ?? '无'}），暂存不变。`, { exitCode: outcome.code ?? -1, tail })
      })
    })
  }

  /** A commit with a receipt is never run again: the receipt, or what the repository shows now, answers it. */
  private async answerCommit(caller: DeliveryCaller, receipt: GitRecord): Promise<GitCommitResult> {
    if (receipt.state === 'done' && receipt.commit) return { commit: receipt.commit, replay: true }
    if (receipt.state === 'failed') throw storedFailure(receipt)
    // Answered from the receipt or not at all: a folder that is no longer a repository (or no Git) says nothing about
    // the commit the first attempt may have made, so it stays unknown rather than refused afresh.
    let layout: GitLayout, git: GitReader
    try {
      layout = await this.layout(caller.folder)
      git = this.git()
    } catch {
      throw unknown()
    }
    const identity = {
      ...(receipt.preHead ? { preHead: receipt.preHead } : {}),
      ...(receipt.indexTree ? { indexTree: receipt.indexTree } : {}),
      subjectHash: receipt.subjectHash ?? '',
      ...(receipt.skipHooks ? { skipHooks: true as const } : {}),
    }
    const made = await findCommit(git, layout, identity).catch(() => undefined)
    if (made) {
      await this.record(caller, { ...receipt, state: 'done', commit: made, at: new Date(this.now()).toISOString() }).catch(() => {})
      return { commit: made, replay: true }
    }
    const head = await git.commit(layout, 'HEAD').catch(() => undefined)
    const locked = await lstat(join(layout.gitdir, 'index.lock')).then(
      () => true,
      error => codeOf(error) !== 'ENOENT',
    )
    // Where HEAD points now, as the receipt records it: a commit made on another branch is not on this one's line.
    const headRef = 'branch' in layout.head ? `refs/heads/${layout.head.branch}` : 'HEAD'
    if (receipt.headRef === headRef && head === receipt.preHead && !locked) {
      // Git is not running there and HEAD is on the same branch, not moved: the commit was never made. A receipt from
      // before `headRef` was kept cannot tell a switched branch apart, so it stays unknown.
      await this.record(caller, { ...receipt, state: 'failed', code: 'git-commit-not-made', at: new Date(this.now()).toISOString() }).catch(
        () => {},
      )
      throw refuse('git-commit-not-made', '这次提交没有生成。可以重新提交。', { replay: true })
    }
    throw unknown()
  }

  async push(caller: DeliveryCaller, input: { requestId: string }): Promise<GitPushResult> {
    const payload = payloadHash({ kind: 'push' })
    return this.once(caller, input.requestId, payload, async () => {
      const receipt = this.options.receipts.git(caller.sessionId, caller.deviceId, input.requestId)
      if (receipt && (receipt.operation !== 'push' || receipt.payloadHash !== payload))
        throw refuse('request-conflict', '同一个请求标识不能用于不同的操作。')
      if (receipt?.state === 'done' && receipt.remote && receipt.ref && receipt.localSha)
        return {
          remote: receipt.remote,
          ref: receipt.ref,
          sha: receipt.localSha,
          ...(receipt.setUpstream ? { setUpstream: true as const } : {}),
          replay: true as const,
        }
      if (receipt?.state === 'failed') throw storedFailure(receipt)
      // An earlier attempt whose result is unknown: the same commit to the same place, which a non-forced push may repeat.
      const earlier =
        receipt?.remote && receipt.ref && receipt.localSha
          ? {
              remote: receipt.remote,
              ref: receipt.ref,
              localSha: receipt.localSha,
              setUpstream: !!receipt.setUpstream,
              via: receipt.via ?? (receipt.setUpstream ? ('origin' as const) : ('upstream' as const)),
            }
          : undefined
      // Answers that may leave a retry as they are: the caller's own checks, and outcomes that settle the receipt.
      const final = new WeakSet<object>()
      const attempt = this.attemptPush(caller, input.requestId, payload, receipt, earlier, final)
      if (!earlier) return attempt
      // A retry is answered from what the remote shows or stays unknown: a refusal that comes before anything is known
      // (a moved folder, a busy repository, a merge under way, Git failing to read, an unsaved receipt or audit, the
      // Host closing) says nothing about the first attempt, and a client would drop 「推送结果未知」 on it.
      return attempt.catch((error: unknown) => {
        if (error instanceof AppError && (error.code === 'git-result-unknown' || error.code === 'host-updating')) throw error
        if (typeof error === 'object' && error !== null && final.has(error)) throw error
        throw unknown()
      })
    })
  }

  private async attemptPush(
    caller: DeliveryCaller,
    requestId: string,
    payload: string,
    receipt: GitRecord | undefined,
    earlier: { remote: string; ref: string; localSha: string; setUpstream: boolean; via: PushVia } | undefined,
    final: WeakSet<object>,
  ): Promise<GitPushResult> {
    const layout = await this.layout(caller.folder)
    // A retry pushes the receipt's commit to the receipt's branch, wherever HEAD is now: only the upstream setting,
    // which belongs to a branch, waits for HEAD to be on that branch again.
    const branch = 'branch' in layout.head ? layout.head.branch : undefined
    if (!earlier && branch === undefined) throw refuse('git-detached', 'HEAD 没有指向分支，没有推送。在终端里切到一个分支后再试。')
    return this.hold(caller, layout, 'push', requestId, async running => {
      const git = this.git()
      let target: { remote: string; ref: string; localSha: string; setUpstream: boolean; via: PushVia }
      if (earlier) {
        target = earlier
      } else if (branch === undefined) {
        throw refuse('git-detached', 'HEAD 没有指向分支，没有推送。在终端里切到一个分支后再试。')
      } else {
        const config = await this.config(layout)
        const localSha = await git.commit(layout, 'HEAD').catch(() => undefined)
        if (!localSha) throw refuse('git-no-commit', '还没有提交，没有可推送的内容。')
        target = { ...pushTarget(config, branch), localSha }
        // Always the branch of the same name, and only a name Git takes as a branch.
        const valid = await git.run(layout, ['check-ref-format', target.ref], { maxBytes: 1024 }).then(
          () => true,
          () => false,
        )
        if (!valid || target.ref.includes(':')) throw refuse('git-remote-invalid', '这个分支名不能用来推送。')
      }
      const hooks = await this.config(layout).then(config =>
        commonDirOf(git, layout).then(common => listHooks(config, layout, common, this.home())),
      )
      const setUpstream = upstreamOn(target, branch)
      await caller.authorize('push').catch((error: unknown) => {
        if (typeof error === 'object' && error !== null) final.add(error)
        throw error
      })
      await caller.audit({
        action: 'git.push',
        detail: {
          sessionId: caller.sessionId,
          requestHash: sha256Hex(requestId),
          localSha: target.localSha,
          remote: target.via,
          remoteHash: sha256Hex(target.remote),
          refHash: sha256Hex(target.ref),
          setUpstream,
          hooks,
        },
      })
      const pending: GitRecord = {
        kind: 'git',
        operation: 'push',
        requestId: requestId,
        deviceId: caller.deviceId,
        payloadHash: payload,
        state: 'pending',
        remote: target.remote,
        ref: target.ref,
        localSha: target.localSha,
        ...(target.setUpstream ? { setUpstream: true as const } : {}),
        via: target.via,
        startedAt: running.startedAt,
        at: new Date(this.now()).toISOString(),
      }
      // A retry leaves its receipt as it is until the outcome is known: rewritten now, a failed write would drop it, and the
      // next retry would push whatever HEAD is then.
      if (!earlier) await this.record(caller, pending, true)
      const stillUnknown = async (details: Record<string, unknown> = {}) => {
        await this.record(caller, { ...pending, state: 'unknown', at: new Date(this.now()).toISOString() })
        await this.reportResult(caller, { operation: 'push', outcome: 'unknown' })
        return unknown(details)
      }
      // On a retry: whether the remote's branch shows the first attempt, before anything is pushed again.
      if (receipt) {
        const remote = await this.landed(layout, running, target)
        if (remote === 'landed') return this.pushed(caller, layout, pending, target, branch)
        // The remote's branch is at a commit this repository does not have: it may well contain this one.
        if (typeof remote === 'object') throw await stillUnknown({ remoteSha: remote.unknownTip })
      }
      // Never forced: no `--force`, no `+` in the refspec, and an explicit refspec so no configured one applies; no
      // tags and no submodules go along.
      const outcome = await this.runYourGit(
        layout,
        running,
        [
          'push',
          '--porcelain',
          '--no-follow-tags',
          '--recurse-submodules=no',
          '--end-of-options',
          target.remote,
          `${target.localSha}:${target.ref}`,
        ],
        { timeoutMs: this.timeouts.push },
      )
      if (outcome.timedOut) throw await stillUnknown()
      const stdout = outcome.stdout.toString('utf8')
      const accepted = outcome.code === 0 && !stdout.split('\n').some(line => line.startsWith('!\t'))
      if (!accepted) {
        const failure = pushFailure(outcome)
        if (receipt) {
          // The first attempt may still be landing (a slow hook on the server, a Git that outlived the Host): look again.
          const again = await this.landed(layout, running, target)
          if (again === 'landed') return this.pushed(caller, layout, pending, target, branch)
          if (again !== 'missing' || !settlesRetry(failure.code, `${stdout}\n${outcome.stderr.toString('utf8')}`))
            throw await stillUnknown(typeof again === 'object' ? { remoteSha: again.unknownTip } : {})
        }
        final.add(failure)
        const hook = failure.details?.hook as HookName | undefined
        await this.record(caller, {
          ...pending,
          state: 'failed',
          code: failure.code,
          ...(hook ? { hook } : {}),
          ...(typeof failure.details?.exitCode === 'number' ? { exitCode: failure.details.exitCode } : {}),
          at: new Date(this.now()).toISOString(),
        })
        await this.reportResult(caller, {
          operation: 'push',
          outcome: 'failed',
          code: failure.code as DeliveryResultEvent['code'] & string,
        })
        throw failure
      }
      return this.pushed(caller, layout, pending, target, branch)
    })
  }

  /**
   * A retried push whose first attempt may have landed: `landed` when the remote's branch is at the commit or past it;
   * the remote's tip when this repository does not have that commit (so it cannot tell); `missing` when the remote
   * answered and its branch does not hold the commit (absent, or at a known commit that does not contain it); `unsure`
   * when `ls-remote` failed, timed out or printed nothing usable. Pushed again on `missing` and `unsure`.
   */
  private async landed(
    layout: GitLayout,
    running: Running,
    target: { remote: string; ref: string; localSha: string },
  ): Promise<'landed' | 'missing' | 'unsure' | { unknownTip: string }> {
    const git = this.git()
    // A push goes to the push URL (`pushurl`, `pushInsteadOf`); `ls-remote <remote>` reads the fetch URL. Only when both
    // are surely the same is the remote read, and always by its name: a URL never goes into arguments (it may hold
    // credentials, and your Git would rewrite it by `insteadOf`, which a push does not). The restricted Git reads the
    // configuration alone, contacting nothing and running no hook.
    const read = async (args: string[], exitCodes?: number[]) =>
      (await git.run(layout, args, { maxBytes: 64 * 1024, ...(exitCodes ? { exitCodes } : {}) }))
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
    try {
      const [fetchUrls, pushUrls, pushInsteadOf] = await Promise.all([
        read(['remote', 'get-url', target.remote]),
        read(['remote', 'get-url', '--push', '--all', target.remote]),
        read(['config', '--get-regexp', '^url\\..*\\.pushinsteadof$'], [0, 1]),
      ])
      if (fetchUrls.length !== 1 || pushUrls.length !== 1 || pushUrls[0] !== fetchUrls[0] || pushInsteadOf.length > 0) return 'unsure'
    } catch {
      return 'unsure'
    }
    const outcome = await this.runYourGit(layout, running, ['ls-remote', '--end-of-options', target.remote, target.ref], {
      timeoutMs: this.timeouts.push,
    })
    if (outcome.timedOut || outcome.code !== 0) return 'unsure'
    const line = outcome.stdout
      .toString('utf8')
      .split('\n')
      .find(entry => entry.endsWith(`\t${target.ref}`))
    if (!line) return 'missing'
    const sha = line.split('\t')[0]
    if (!sha || !OID.test(sha)) return 'unsure'
    if (sha === target.localSha) return 'landed'
    const known = await git.run(layout, ['cat-file', '-e', `${sha}^{commit}`], { maxBytes: 1024 }).then(
      () => true,
      () => false,
    )
    if (!known) return { unknownTip: sha }
    // `--is-ancestor` exits 1 for "no"; any other failure (a commit gone from this repository, say) cannot tell.
    const ancestor = ['merge-base', '--is-ancestor', target.localSha, sha]
    return git.run(layout, ancestor, { maxBytes: 1024 }).then(
      () => 'landed' as const,
      () =>
        git.run(layout, ancestor, { maxBytes: 1024, exitCodes: [1] }).then(
          () => 'missing' as const,
          () => 'unsure' as const,
        ),
    )
  }

  private async pushed(
    caller: DeliveryCaller,
    layout: GitLayout,
    pending: GitRecord,
    target: { remote: string; ref: string; localSha: string; setUpstream: boolean },
    branch: string | undefined,
  ): Promise<GitPushResult> {
    const setUpstream = upstreamOn(target, branch)
    if (setUpstream) {
      // Recorded by the restricted Git, as `push -u` would, without taking the branch's config lock during the push.
      try {
        await this.git().run(layout, ['config', `branch.${branch}.remote`, target.remote], { maxBytes: 1024 })
        await this.git().run(layout, ['config', `branch.${branch}.merge`, target.ref], { maxBytes: 1024 })
      } catch {
        this.options.log('推送已完成，但没能记下上游分支。')
      }
    }
    const { setUpstream: _planned, ...rest } = pending
    await this.record(caller, { ...rest, ...(setUpstream ? { setUpstream } : {}), state: 'done', at: new Date(this.now()).toISOString() })
    await this.reportResult(caller, { operation: 'push', outcome: 'done', commit: target.localSha })
    return {
      remote: target.remote,
      ref: target.ref,
      sha: target.localSha,
      ...(setUpstream ? { setUpstream: true as const } : {}),
    }
  }

  /** Where the branch's push goes, on GitHub: the remote 推送 would use, and the repository its URL names. */
  private async pushRepo(layout: GitLayout, sessionId: string): Promise<{ repo: GhRepo; remote: string; branch: string }> {
    if (!('branch' in layout.head)) throw refuse('git-detached', 'HEAD 没有指向分支，没有 PR 可建。')
    const branch = layout.head.branch
    // Only a name `gh` takes and the session metadata can hold.
    if (!BRANCH.test(branch)) throw new AppError(409, 'pr-input-invalid', '这个分支名不能用于 PR。')
    const config = await this.config(layout)
    let remote: string
    try {
      remote = pushTarget(config, branch).remote
    } catch {
      throw noRemote()
    }
    // The fetch URL with `insteadOf` applied, as `gh` reads remotes; only printed, nothing is contacted.
    const url = await this.git()
      .run(layout, ['ls-remote', '--get-url', '--end-of-options', remote], { maxBytes: 8192 })
      .then(out => out.toString('utf8').trim())
      .catch(() => '')
    const repo = repoOfUrl(url)
    if (!repo) throw noRemote()
    await this.allowHost(layout, sessionId, repo)
    return { repo, remote, branch }
  }

  /**
   * `gh` runs against GitHub, GitHub Enterprise Cloud, or a GitHub Enterprise Server it already has a login for
   * (`gh auth status --hostname`, which prints no token); any other host is not GitHub and nothing is run against it.
   */
  private async allowHost(layout: GitLayout, sessionId: string, repo: GhRepo): Promise<void> {
    if (knownGitHub(repo.host)) return
    if ((this.hostLogins.get(repo.host) ?? 0) > this.now()) return
    if (this.closing) throw new AppError(503, 'host-closing', '运行节点正在关闭')
    const running: Running = { kind: 'pr', requestId: '', startedAt: new Date(this.now()).toISOString(), sessionId }
    this.reading.add(running)
    try {
      const outcome = await this.runAs('gh', layout, running, ['auth', 'status', '--hostname', repo.host], { timeoutMs: this.timeouts.gh })
      const stderr = outcome.stderr.toString('utf8')
      if (outcome.code === 127) throw ghFailure({ code: 127, stderr })
      // A login there that no longer works: GitHub, but logged out.
      if (!outcome.timedOut && outcome.code !== 0 && /Failed to log in|token .*(?:invalid|expired)/iu.test(stderr))
        throw new AppError(409, 'gh-logged-out', 'gh 在这台主机上的登录已失效。在终端里运行 gh auth login。')
      if (outcome.timedOut || outcome.code !== 0) throw noRemote()
      this.hostLogins.set(repo.host, this.now() + HOST_LOGIN_MS)
    } finally {
      this.reading.delete(running)
    }
  }

  /** A read through your `gh`: its standard output, or the fixed reason it gave none. */
  private async ghRead(layout: GitLayout, sessionId: string, args: string[], timeoutMs = this.timeouts.gh): Promise<string> {
    if (this.closing) throw new AppError(503, 'host-closing', '运行节点正在关闭')
    const running: Running = { kind: 'pr', requestId: '', startedAt: new Date(this.now()).toISOString(), sessionId }
    this.reading.add(running)
    try {
      const outcome = await this.runAs('gh', layout, running, args, { timeoutMs })
      if (outcome.timedOut) throw new AppError(504, 'gh-unreachable', 'gh 没有及时答复。')
      if (outcome.code !== 0) throw ghFailure({ code: outcome.code, stderr: outcome.stderr.toString('utf8') })
      return outcome.stdout.toString('utf8')
    } finally {
      this.reading.delete(running)
    }
  }

  /** The open pull requests from this repository's branch, newest first as `gh` lists them. */
  private async openPrs(
    layout: GitLayout,
    sessionId: string,
    target: { repo: GhRepo; branch: string },
  ): Promise<{ open: GitPrBinding[]; exists: boolean }> {
    const out = await this.ghRead(layout, sessionId, [
      'pr',
      'list',
      '--repo',
      target.repo.full,
      `--head=${target.branch}`,
      '--state',
      'open',
      '--json',
      PR_LIST_FIELDS,
      '--limit',
      '20',
    ])
    return readPrList(out, target.branch, target.repo)
  }

  /**
   * The pull request step's state. With a bound pull request: its state, review decision and its head commit's checks,
   * and with `discussion` its reviews and comments; without one, what 创建 PR starts from (`title`: the last commit's
   * subject).
   */
  async prState(input: {
    sessionId: string
    folder: string
    discussion: boolean
    title: boolean
    boundOnly?: boolean
  }): Promise<GitPrState> {
    const layout = await this.layout(input.folder)
    const bound = this.options.prs?.get(input.sessionId)
    if (bound) {
      const where = repoOfPr(bound.url)
      if (!where) throw noRemote()
      await this.allowHost(layout, input.sessionId, where.repo)
      const view = readPrView(
        await this.ghRead(layout, input.sessionId, ['pr', 'view', String(where.number), '--repo', where.repo.full, '--json', PR_FIELDS]),
        where.repo,
      )
      if (view.pr.state !== 'open' && (await this.movedOn(layout, input.sessionId, bound, view.pr.headSha))) {
        await this.options.prs?.unbind(input.sessionId)
        return input.boundOnly ? { checks: [] } : this.unboundState(layout, input)
      }
      let discussion: { items: GitPrState['discussion'] & object; capped: boolean } | undefined
      if (input.discussion) discussion = await this.discussion(layout, input.sessionId, where)
      return {
        pr: view.pr,
        checks: view.checks,
        ...(discussion ? { discussion: discussion.items, ...(discussion.capped ? { discussionCapped: true as const } : {}) } : {}),
      }
    }
    return input.boundOnly ? { checks: [] } : this.unboundState(layout, input)
  }

  private async unboundState(layout: GitLayout, input: { sessionId: string; title: boolean }): Promise<GitPrState> {
    const target = await this.pushRepo(layout, input.sessionId)
    const base = readDefaultBranch(
      await this.ghRead(layout, input.sessionId, ['repo', 'view', target.repo.full, '--json', 'defaultBranchRef']),
    )
    const title = input.title ? await this.lastSubject(layout) : undefined
    return { checks: [], draft: { ...(title ? { title } : {}), ...(base ? { base } : {}) } }
  }

  /** The bound pull request's branch was pushed past the commit it ended at: a new push after a merge or a close. */
  private async movedOn(layout: GitLayout, sessionId: string, bound: GitPrBinding, headSha: string | undefined): Promise<boolean> {
    if (!headSha) return false
    const target = await this.pushRepo(layout, sessionId).catch(() => undefined)
    if (!target || target.branch !== bound.head) return false
    const pushed = await this.git()
      .commit(layout, `refs/remotes/${target.remote}/${target.branch}`)
      .catch(() => undefined)
    return !!pushed && pushed !== headSha
  }

  /**
   * Reviews, conversation comments and line comments: the newest of each, cut by `gh` itself (`--jq`) so a long
   * discussion stays readable; an unreadable one leaves the checks as they are.
   */
  private async discussion(
    layout: GitLayout,
    sessionId: string,
    where: { repo: GhRepo; number: number },
  ): Promise<{ items: NonNullable<GitPrState['discussion']>; capped: boolean }> {
    try {
      const talk = readDiscussion(
        await this.ghRead(layout, sessionId, [
          'pr',
          'view',
          String(where.number),
          '--repo',
          where.repo.full,
          '--json',
          'reviews,comments',
          '--jq',
          DISCUSSION_JQ,
        ]),
      )
      const lines = readLineComments(
        await this.ghRead(layout, sessionId, [
          'api',
          '--hostname',
          where.repo.host,
          '--method',
          'GET',
          '--jq',
          LINE_COMMENTS_JQ,
          `repos/${where.repo.owner}/${where.repo.name}/pulls/${where.number}/comments?per_page=${LINE_COMMENTS}&sort=created&direction=desc`,
        ]),
      )
      const shown = talk.items.length
      return discussionOf([...talk.items, ...lines], talk.total > shown || lines.length >= LINE_COMMENTS)
    } catch (error) {
      if (error instanceof AppError && error.code === 'gh-failed') return { items: [], capped: true }
      throw error
    }
  }

  private async lastSubject(layout: GitLayout): Promise<string | undefined> {
    const out = await this.git()
      .run(layout, ['log', '-1', '--no-show-signature', '--format=%s', 'HEAD', '--'], { maxBytes: 64 * 1024 })
      .catch(() => undefined)
    const subject = out?.toString('utf8').trim().replace(/\s+/gu, ' ').slice(0, 256)
    return subject && validTitle(subject) ? subject : undefined
  }

  /**
   * 创建 PR: an open pull request from the branch is bound instead of a second one (`git.pr.link`); otherwise one is made
   * (`git.pr.create`, recorded first). A retry of an attempt whose result is unknown looks for the branch's pull request
   * again before it makes one. Never closes, merges or edits a pull request.
   */
  async createPr(
    caller: DeliveryCaller,
    input: { requestId: string; title: string; body: string; base: string; draft?: boolean },
  ): Promise<GitPrResult> {
    if (!validTitle(input.title) || !BRANCH.test(input.base) || Buffer.byteLength(input.body) > BODY_LIMIT || input.body.includes('\0'))
      throw new AppError(400, 'pr-input-invalid', '标题必填（一行，最多 256 个字符），基线是分支名，正文最多 64 KB。')
    const prs = this.options.prs
    if (!prs) throw noRemote()
    const title = input.title.trim()
    const payload = payloadHash({ kind: 'pr', title, body: input.body, base: input.base, draft: !!input.draft })
    return this.once(caller, input.requestId, payload, async () => {
      const receipt = this.options.receipts.git(caller.sessionId, caller.deviceId, input.requestId)
      if (receipt && (receipt.operation !== 'pr' || receipt.payloadHash !== payload))
        throw refuse('request-conflict', '同一个请求标识不能用于不同的操作。')
      if (receipt?.state === 'done' && receipt.pr)
        return { pr: receipt.pr, ...(receipt.linked ? { linked: true as const } : {}), replay: true }
      if (receipt?.state === 'failed') throw storedFailure(receipt)
      const layout = await this.layout(caller.folder)
      const target = await this.pushRepo(layout, caller.sessionId)
      const git = this.git()
      if (!(await git.commit(layout, `refs/remotes/${target.remote}/${target.branch}`).catch(() => undefined)))
        throw refuse('pr-not-pushed', '这个分支还不在远端。先推送，再创建 PR。')
      return this.hold(caller, layout, 'pr', input.requestId, async running => {
        const request = { sessionId: caller.sessionId, requestHash: sha256Hex(input.requestId) }
        const where = { remoteHash: sha256Hex(target.remote), headHash: sha256Hex(target.branch) }
        const base: GitRecord = {
          kind: 'git',
          operation: 'pr',
          requestId: input.requestId,
          deviceId: caller.deviceId,
          payloadHash: payload,
          state: 'pending',
          startedAt: running.startedAt,
          at: new Date(this.now()).toISOString(),
        }
        const link = async (pr: GitPrBinding, again: boolean): Promise<GitPrResult> => {
          await caller.authorize('pr')
          await caller.audit({ action: 'git.pr.link', detail: { ...request, number: pr.number, ...where } })
          await this.bindPr(caller.sessionId, pr)
          await this.record(caller, { ...base, state: 'done', pr, linked: true, at: new Date(this.now()).toISOString() })
          await this.reportResult(caller, { operation: 'pr', outcome: 'done', number: pr.number })
          // A retry that finds the branch's pull request finds the one its first attempt made.
          return again ? { pr, replay: true } : { pr, linked: true }
        }
        const found = await this.openPrs(layout, caller.sessionId, target)
        if (found.open[0]) return link(found.open[0], !!receipt)
        // Open already, under a base the metadata cannot hold: never a second one.
        if (found.exists) throw existsElsewhere()
        await caller.authorize('pr')
        await caller.audit({
          action: 'git.pr.create',
          detail: { ...request, ...where, baseHash: sha256Hex(input.base), draft: !!input.draft },
        })
        await this.record(caller, base, true)
        const outcome = await this.runAs(
          'gh',
          layout,
          running,
          [
            'pr',
            'create',
            '--repo',
            target.repo.full,
            `--head=${target.branch}`,
            `--base=${input.base}`,
            `--title=${title}`,
            '--body-file=BODY',
            ...(input.draft ? ['--draft'] : []),
          ],
          { timeoutMs: this.timeouts.prCreate, body: input.body },
        )
        const stillUnknown = async () => {
          await this.record(caller, { ...base, state: 'unknown', at: new Date(this.now()).toISOString() })
          await this.reportResult(caller, { operation: 'pr', outcome: 'unknown' })
          return unknown()
        }
        if (outcome.timedOut) throw await stillUnknown()
        if (outcome.code !== 0) {
          const failure = ghFailure({ code: outcome.code, stderr: outcome.stderr.toString('utf8') }, true)
          // The connection broke during the request: GitHub may have made it.
          if (failure.code === 'gh-unreachable') throw await stillUnknown()
          if (failure.code === 'pr-exists-elsewhere') {
            // Made meanwhile, from another device or a terminal: bind it when it is open in this repository.
            const again = await this.openPrs(layout, caller.sessionId, target).catch(() => ({ open: [], exists: false }))
            if (again.open[0]) return link(again.open[0], false)
          }
          await this.record(caller, {
            ...base,
            state: 'failed',
            code: failure.code,
            ...(typeof failure.details?.exitCode === 'number' ? { exitCode: failure.details.exitCode } : {}),
            at: new Date(this.now()).toISOString(),
          })
          await this.reportResult(caller, {
            operation: 'pr',
            outcome: 'failed',
            code: failure.code as DeliveryResultEvent['code'] & string,
          })
          throw failure
        }
        const url = createdUrl(outcome.stdout.toString('utf8'))
        const made = url ? repoOfPr(url) : undefined
        // Bound only when it is where it was asked for.
        if (!url || !made || !sameRepo(made.repo, target.repo)) throw await stillUnknown()
        const pr: GitPrBinding = { number: made.number, url, base: input.base, head: target.branch }
        await this.bindPr(caller.sessionId, pr)
        await this.record(caller, { ...base, state: 'done', pr, at: new Date(this.now()).toISOString() })
        await this.reportResult(caller, { operation: 'pr', outcome: 'done', number: pr.number })
        return { pr }
      })
    })
  }

  /** A failed write of the binding is only logged: the next 创建 PR finds the pull request open and binds it. */
  private async bindPr(sessionId: string, pr: GitPrBinding): Promise<void> {
    try {
      await this.options.prs?.bind(sessionId, pr)
    } catch (error) {
      this.options.log(`PR 没有记到会话上：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** A failed GitHub Actions job of the bound pull request's checks: the end of its failed steps' log. */
  async checkLog(input: { sessionId: string; folder: string; job: string }): Promise<GitCheckLog> {
    const bound = this.options.prs?.get(input.sessionId)
    const where = bound ? repoOfPr(bound.url) : undefined
    if (!where || !/^\d{1,20}$/u.test(input.job)) throw new AppError(404, 'pr-check-not-found', '找不到这个检查。')
    const layout = await this.layout(input.folder)
    await this.allowHost(layout, input.sessionId, where.repo)
    const view = readPrView(
      await this.ghRead(layout, input.sessionId, ['pr', 'view', String(where.number), '--repo', where.repo.full, '--json', PR_FIELDS]),
      where.repo,
    )
    // Only a failed job of this pull request's current checks, in its own repository.
    const check = view.checks.find(item => item.job === input.job)
    if (!check) throw new AppError(404, 'pr-check-not-found', '找不到这个检查。')
    const out = await this.ghRead(
      layout,
      input.sessionId,
      ['run', 'view', '--job', input.job, '--repo', where.repo.full, '--log-failed'],
      this.timeouts.log,
    ).catch((error: unknown) => {
      // The job or its log is gone (expired, or the run was deleted).
      if (error instanceof AppError && error.code === 'gh-no-remote')
        throw new AppError(404, 'pr-check-not-found', '找不到这个检查的日志。')
      throw error
    })
    return { name: check.name, ...logExcerpt(out) }
  }

  /** `first`: the record a write must have before it runs; otherwise a failed write is logged and memory keeps it. */
  private async record(caller: DeliveryCaller, receipt: GitRecord, first = false): Promise<void> {
    try {
      await this.options.receipts.recordGit(caller.sessionId, receipt)
    } catch (error) {
      if (first) throw new AppError(503, 'git-receipt-unsaved', '交付回执没有写入，没有执行。请稍后再试。')
      this.options.log(`交付回执没有写入：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Your Git, as you: through your login shell, in the terminal's environment, in the work tree. `MESSAGE` and `PATHS`
   * in `args` name 0600 files in a fresh 0700 folder that holds the message and the NUL-separated paths; the message is
   * never an argument. Nothing is read from standard input.
   */
  private runYourGit(
    layout: GitLayout,
    running: Running,
    args: string[],
    options: { timeoutMs: number; message?: string; paths?: readonly string[] },
  ): Promise<Outcome> {
    return this.runAs('git', layout, running, args, options)
  }

  /**
   * Your Git or your `gh`, as you: through your login shell, in the terminal's environment, in the work tree. Git is
   * the one the Host found; `gh` is whichever your profile's PATH finds. `MESSAGE`, `PATHS` and `BODY` in `args` name
   * 0600 files in a fresh 0700 folder; the content is never an argument. Nothing is read from standard input.
   */
  private async runAs(
    program: Program,
    layout: GitLayout,
    running: Running,
    args: string[],
    options: { timeoutMs: number; message?: string; paths?: readonly string[]; body?: string },
  ): Promise<Outcome> {
    const binary = program === 'git' ? this.binary! : 'gh'
    const folder = await mkdtemp(join(tmpdir(), 'latch-git-'))
    try {
      const file = async (name: string, content: string) => {
        const path = join(folder, name)
        await writeFile(path, content, { mode: 0o600, flag: 'wx' })
        return path
      }
      const message = options.message === undefined ? undefined : await file('message', options.message)
      const paths = options.paths === undefined ? undefined : await file('paths', `${options.paths.join('\0')}\0`)
      const body = options.body === undefined ? undefined : await file('body', options.body)
      // Only a whole placeholder argument: a title or a branch that holds `=BODY` stays as it is.
      const files: Record<string, string | undefined> = {
        '--file=MESSAGE': message && `--file=${message}`,
        '--pathspec-from-file=PATHS': paths && `--pathspec-from-file=${paths}`,
        '--body-file=BODY': body && `--body-file=${body}`,
      }
      const resolved = args.map(arg => (Object.hasOwn(files, arg) ? (files[arg] ?? arg) : arg))
      const trace = join(folder, 'trace')
      const shell = await (this.options.shell ?? loginShell)()
      const posix = POSIX_SHELLS.has(shell.argv[0]!.replace(/^-/u, ''))
      const file0 = posix ? shell.file : '/bin/zsh',
        argv0 = posix ? shell.argv[0]! : '-zsh'
      const env = {
        ...deliveryEnvironment({ hostEnv: this.hostEnv, shell: file0, folder: layout.root }),
        ...(program === 'git' ? { GIT_TRACE2_EVENT: trace } : {}),
        ...(options.paths ? { GIT_LITERAL_PATHSPECS: '1' } : {}),
      }
      const argv = program === 'git' ? ['-c', SHELL_SCRIPT, binary, '-C', layout.root, ...resolved] : ['-c', GH_SCRIPT, binary, ...resolved]
      return await new Promise<Outcome>(resolve => {
        const child = spawn(file0, argv, {
          argv0,
          cwd: layout.root,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          // Its own process group without a terminal: a stop ends every process it started, and nothing can prompt.
          detached: true,
        })
        running.pid = child.pid
        const output = new Tail(TAIL_LIMIT),
          // `gh` answers in JSON, read whole; Git's output is only classified.
          stdout = new Tail(program === 'gh' ? 8 * 1024 * 1024 : 256 * 1024),
          stderr = new Tail(256 * 1024)
        const hooks: Outcome['hooks'] = [],
          children = new Map<number, number>()
        let traced = 0,
          timedOut = false
        const readOnce = async () => {
          const text = await readFile(trace).catch(() => Buffer.alloc(0))
          // Only whole lines, and never past 8 MiB of trace.
          const end = text.subarray(0, 8 * 1024 * 1024).lastIndexOf(0x0a) + 1
          if (end <= traced) return
          traceHooks(text.subarray(traced, end).toString('utf8'), hooks, children)
          traced = end
          const current = hooks.findLast(hook => hook.code === undefined)
          const name = current && HOOK_NAMES.has(current.name) ? current.name : undefined
          if (name) running.hook = name
          else delete running.hook
        }
        // One read at a time, in order.
        let reads = Promise.resolve()
        const readTrace = () => (reads = reads.then(readOnce, readOnce))
        const poll = setInterval(() => void readTrace(), 500)
        let last: NodeJS.Timeout | undefined
        const timer = setTimeout(() => {
          timedOut = true
          if (child.pid) {
            signal(child.pid, 'SIGTERM')
            setTimeout(() => signal(child.pid!, 'SIGKILL'), KILL_GRACE_MS).unref()
          }
          // Whatever still holds the output open, the attempt is over once the kill had its time.
          last = setTimeout(() => void finish(null), KILL_GRACE_MS + PIPE_GRACE_MS)
        }, options.timeoutMs)
        child.stdout.on('data', (chunk: Buffer) => {
          output.push(chunk)
          stdout.push(chunk)
        })
        child.stderr.on('data', (chunk: Buffer) => {
          output.push(chunk)
          stderr.push(chunk)
        })
        let finished = false
        const finish = async (code: number | null) => {
          if (finished) return
          finished = true
          clearInterval(poll)
          clearTimeout(timer)
          clearTimeout(last)
          child.stdout.destroy()
          child.stderr.destroy()
          delete running.pid
          await readTrace().catch(() => {})
          resolve({ code, timedOut, output: output.bytes(), stdout: stdout.bytes(), stderr: stderr.bytes(), hooks })
        }
        child.on('error', () => void finish(null))
        // Settled when Git exits: a process a hook left running (a daemon in a session of its own) may hold the output
        // pipes open for as long as it lives, so they get a moment to drain and are then closed.
        child.on('exit', code => {
          setTimeout(() => void finish(code), PIPE_GRACE_MS)
        })
        child.on('close', code => void finish(code))
      })
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  }
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(-pid, name)
  } catch {
    // Already gone.
  }
}

/** The last `limit` bytes of a stream. */
class Tail {
  private chunks: Buffer[] = []
  private size = 0
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size - this.chunks[0]!.length >= this.limit) this.size -= this.chunks.shift()!.length
  }
  bytes(): Buffer {
    const all = Buffer.concat(this.chunks)
    return all.length > this.limit ? all.subarray(all.length - this.limit) : all
  }
}
