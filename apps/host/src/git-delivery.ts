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
import type { GitCommitResult, GitDeliveryKind, GitDeliveryRunning, GitDeliveryState, GitPushResult, GitStageResult } from '@latch/protocol'
import { canonicalJson, redactSecrets, sha256Hex } from '@latch/core/node-kit'
import type { RESULT_CODES } from './audit-actions/git.ts'
import { readGitLayout, type GitLayout } from './branch-reader.ts'
import { GitError, GitReader, findGit, gitOperation } from './changes/git.ts'
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
  readStatus,
  stageRestricted,
  subjectOf,
  unstageRestricted,
  type HookName,
  type RepositoryConfig,
} from './changes/git-status.ts'
import { codeOf } from './http-util.ts'
import type { GitRecord, SessionReceipts } from './session-meta.ts'
import { loginShell, terminalEnvironment, type ShellCommand } from './terminal/environment.ts'

export const MESSAGE_LIMIT = 64 * 1024
/** What a failure or a hook's output returns at most, after redaction: the end of it. */
export const TAIL_LIMIT = 256 * 1024
const REMOTE_LINES = 100
const TIMEOUTS = { commit: 10 * 60_000, push: 2 * 60_000, stage: 2 * 60_000 }
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
  action: 'git.stage' | 'git.unstage' | 'git.commit' | 'git.push'
  detail: Record<string, unknown>
}
export interface DeliveryResultEvent {
  operation: GitDeliveryKind
  outcome: 'done' | 'failed' | 'unknown'
  code?: (typeof RESULT_CODES)[number]
  commit?: string
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

export interface GitDeliveryOptions {
  /** Your Git; found where the 改动 reader finds it by default. */
  git?: string
  /** The restricted runner's home (whose global configuration applies); the Host user's by default. */
  home?: string
  /** The environment the terminal's is built from; the Host's own by default. */
  hostEnv?: NodeJS.ProcessEnv
  shell?: () => Promise<ShellCommand>
  receipts: Pick<SessionReceipts, 'git' | 'recordGit'>
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

const refuse = (code: string, message: string, details?: Record<string, unknown>) => new AppError(409, code, message, details)
const gitFailed = () => new AppError(500, 'git-failed', 'Git 没有完成读取，请稍后再试。')
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
  const redacted = redactSecrets(text).trim()
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

/** The receipt's answer, for a retry with the same request. */
function storedFailure(receipt: GitRecord): AppError {
  const details = {
    ...(receipt.hook ? { hook: receipt.hook } : {}),
    ...(receipt.exitCode !== undefined ? { exitCode: receipt.exitCode } : {}),
    replay: true,
  }
  const code = receipt.code ?? (receipt.operation === 'commit' ? 'git-commit-failed' : 'git-push-failed')
  return new AppError(code === 'git-commit-not-made' ? 409 : 422, code, '这个请求之前没有成功，没有再执行一次。', details)
}

/** The writes of 交付, one at a time per repository, and its status read. */
export class GitDelivery {
  private readonly binary: string | undefined
  private readonly reader: GitReader | undefined
  private readonly hostEnv: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly timeouts: typeof TIMEOUTS
  /** By the repository's shared Git directory. */
  private readonly running = new Map<string, Running>()
  /** Requests under way, by session, device and request: a retry waits for the same answer. */
  private readonly inflight = new Map<string, { payload: string; answer: Promise<unknown> }>()
  /** Stage and unstage answers, for a retry after a lost response; they are safe to repeat, so not kept on disk. */
  private readonly answered = new Map<string, { payload: string; result: GitStageResult }>()
  private closing = false

  constructor(private readonly options: GitDeliveryOptions) {
    this.binary = findGit(options.git ? [options.git] : undefined)
    this.reader = this.binary
      ? new GitReader({ binary: this.binary, timeoutMs: 30_000, ...(options.home ? { home: options.home } : {}) })
      : undefined
    this.hostEnv = options.hostEnv ?? process.env
    this.now = options.now ?? Date.now
    this.timeouts = { ...TIMEOUTS, ...options.timeouts }
  }

  /** Stops every Git it started (SIGTERM, then SIGKILL): a commit stopped this way is answered by its receipt later. */
  async close(): Promise<void> {
    this.closing = true
    for (const running of this.running.values()) if (running.pid) signal(running.pid, 'SIGTERM')
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
    const running: Running = { kind, requestId, startedAt: new Date(this.now()).toISOString(), sessionId: caller.sessionId }
    this.running.set(common, running)
    this.options.changed?.(caller.sessionId)
    try {
      if (await gitOperation(layout).catch(() => 'unmerged' as const))
        throw refuse('git-operation-in-progress', '仓库正在合并、变基、拣选或还原，在终端里完成后再试。')
      return await work(running, common)
    } finally {
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
    const layout = await this.layout(caller.folder)
    const git = this.git()
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
    if (head === receipt.preHead && !locked) {
      // Git is not running there and HEAD has not moved: the commit was never made.
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
      const layout = await this.layout(caller.folder)
      if (!('branch' in layout.head)) throw refuse('git-detached', 'HEAD 没有指向分支，没有推送。在终端里切到一个分支后再试。')
      const branch = layout.head.branch
      return this.hold(caller, layout, 'push', input.requestId, async running => {
        const git = this.git()
        let target: { remote: string; ref: string; localSha: string; setUpstream: boolean; via: PushVia }
        if (receipt?.remote && receipt.ref && receipt.localSha) {
          // An earlier attempt whose result is unknown: the same commit to the same place, which a non-forced push may repeat.
          target = {
            remote: receipt.remote,
            ref: receipt.ref,
            localSha: receipt.localSha,
            setUpstream: !!receipt.setUpstream,
            via: receipt.via ?? (receipt.setUpstream ? 'origin' : 'upstream'),
          }
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
        await caller.authorize('push')
        await caller.audit({
          action: 'git.push',
          detail: {
            sessionId: caller.sessionId,
            requestHash: sha256Hex(input.requestId),
            localSha: target.localSha,
            remote: target.via,
            remoteHash: sha256Hex(target.remote),
            refHash: sha256Hex(target.ref),
            setUpstream: target.setUpstream,
            hooks,
          },
        })
        const pending: GitRecord = {
          kind: 'git',
          operation: 'push',
          requestId: input.requestId,
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
        await this.record(caller, pending, true)
        const stillUnknown = async (details: Record<string, unknown> = {}) => {
          await this.record(caller, { ...pending, state: 'unknown', at: new Date(this.now()).toISOString() })
          await this.reportResult(caller, { operation: 'push', outcome: 'unknown' })
          return unknown(details)
        }
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
          // On a retry, the first attempt may have landed before the remote moved on.
          if (receipt && failure.code === 'git-push-non-fast-forward') throw await stillUnknown()
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
    })
  }

  /**
   * A retried push whose first attempt may have landed: `landed` when the remote's branch is at the commit or past it,
   * the remote's tip when this repository does not have that commit (so it cannot tell), `push` otherwise.
   */
  private async landed(
    layout: GitLayout,
    running: Running,
    target: { remote: string; ref: string; localSha: string },
  ): Promise<'landed' | 'push' | { unknownTip: string }> {
    const outcome = await this.runYourGit(layout, running, ['ls-remote', '--end-of-options', target.remote, target.ref], {
      timeoutMs: this.timeouts.push,
    })
    if (outcome.timedOut || outcome.code !== 0) return 'push'
    const line = outcome.stdout
      .toString('utf8')
      .split('\n')
      .find(entry => entry.endsWith(`\t${target.ref}`))
    const sha = line?.split('\t')[0]
    if (!sha || !OID.test(sha)) return 'push'
    if (sha === target.localSha) return 'landed'
    const git = this.git()
    const known = await git.run(layout, ['cat-file', '-e', `${sha}^{commit}`], { maxBytes: 1024 }).then(
      () => true,
      () => false,
    )
    if (!known) return { unknownTip: sha }
    return git.run(layout, ['merge-base', '--is-ancestor', target.localSha, sha], { maxBytes: 1024 }).then(
      () => 'landed' as const,
      () => 'push' as const,
    )
  }

  private async pushed(
    caller: DeliveryCaller,
    layout: GitLayout,
    pending: GitRecord,
    target: { remote: string; ref: string; localSha: string; setUpstream: boolean },
    branch: string,
  ): Promise<GitPushResult> {
    if (target.setUpstream) {
      // Recorded by the restricted Git, as `push -u` would, without taking the branch's config lock during the push.
      try {
        await this.git().run(layout, ['config', `branch.${branch}.remote`, target.remote], { maxBytes: 1024 })
        await this.git().run(layout, ['config', `branch.${branch}.merge`, target.ref], { maxBytes: 1024 })
      } catch {
        this.options.log('推送已完成，但没能记下上游分支。')
      }
    }
    await this.record(caller, { ...pending, state: 'done', at: new Date(this.now()).toISOString() })
    await this.reportResult(caller, { operation: 'push', outcome: 'done', commit: target.localSha })
    return {
      remote: target.remote,
      ref: target.ref,
      sha: target.localSha,
      ...(target.setUpstream ? { setUpstream: true as const } : {}),
    }
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
  private async runYourGit(
    layout: GitLayout,
    running: Running,
    args: string[],
    options: { timeoutMs: number; message?: string; paths?: readonly string[] },
  ): Promise<Outcome> {
    const binary = this.binary!
    const folder = await mkdtemp(join(tmpdir(), 'latch-git-'))
    try {
      const file = async (name: string, content: string) => {
        const path = join(folder, name)
        await writeFile(path, content, { mode: 0o600, flag: 'wx' })
        return path
      }
      const message = options.message === undefined ? undefined : await file('message', options.message)
      const paths = options.paths === undefined ? undefined : await file('paths', `${options.paths.join('\0')}\0`)
      const resolved = args.map(arg => arg.replace('=MESSAGE', `=${message}`).replace('=PATHS', `=${paths}`))
      const trace = join(folder, 'trace')
      const shell = await (this.options.shell ?? loginShell)()
      const posix = POSIX_SHELLS.has(shell.argv[0]!.replace(/^-/u, ''))
      const file0 = posix ? shell.file : '/bin/zsh',
        argv0 = posix ? shell.argv[0]! : '-zsh'
      const env = {
        ...deliveryEnvironment({ hostEnv: this.hostEnv, shell: file0, folder: layout.root }),
        GIT_TRACE2_EVENT: trace,
        ...(options.paths ? { GIT_LITERAL_PATHSPECS: '1' } : {}),
      }
      return await new Promise<Outcome>(resolve => {
        const child = spawn(file0, ['-c', SHELL_SCRIPT, binary, '-C', layout.root, ...resolved], {
          argv0,
          cwd: layout.root,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          // Its own process group without a terminal: a stop ends every process it started, and nothing can prompt.
          detached: true,
        })
        running.pid = child.pid
        const output = new Tail(TAIL_LIMIT),
          stdout = new Tail(256 * 1024),
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
