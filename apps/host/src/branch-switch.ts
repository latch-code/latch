// 切换分支: a person moves a project's folder to another of its local branches. Listing
// reads Git's metadata files only (branch-list.ts). The switch is the restricted Git (changes/git.ts) with no hook,
// filter, fsmonitor, submodule or transport, and it is refused instead of neutralised whenever the repository's
// configuration would have your Git run something here: any filter driver, or hooks the repository sets for itself.
import { AppError } from '@latch/sdk'
import type { BranchListing, BranchSwitchConfigKind, BranchSwitchResult } from '@latch/protocol'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import type { SWITCH_CODES } from './audit-actions/git.ts'
import { readGitLayout, type GitLayout } from './branch-reader.ts'
import { BranchListError, branchesElsewhere, listBranches } from './branch-list.ts'
import { GitError, GitReader, findGit, gitOperation } from './changes/git.ts'
import { commonDirOf, readRepositoryConfig, type RepositoryConfig } from './changes/git-status.ts'
import type { RepositoryHolds } from './git-delivery.ts'

/** A switch writes the work tree: as long as making a worktree may take, then the result is unknown. */
const SWITCH_TIMEOUT_MS = 10 * 60_000
/** No gc or maintenance, no submodules; the runner adds the rest (no hooks, fsmonitor, transport, pager or editor). */
const WRITE_CONFIG = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'submodule.recurse=false']
/** Answers kept for a retry of the same request from the same device. */
const ANSWERS = 256

type SwitchCode = (typeof SWITCH_CODES)[number]

const refuse = (code: string, message: string, details?: Record<string, unknown>) => new AppError(409, code, message, details)

const CONFIG_WORDS: Readonly<Record<BranchSwitchConfigKind, string>> = {
  filter: '仓库配置了 filter 驱动（如 Git LFS），切换会运行它。在终端里切换。',
  hook: '仓库自己的配置设置了钩子（core.hooksPath 或 hook.*），切换会运行它们。在终端里切换。',
}

/** Why the repository's configuration keeps a switch from running here, or undefined. */
function configRefusal(config: RepositoryConfig): AppError | undefined {
  const kind: BranchSwitchConfigKind | undefined = config.drivers.length > 0 ? 'filter' : config.ownHooks ? 'hook' : undefined
  return kind && refuse('branch-switch-config', CONFIG_WORDS[kind], { kind })
}

/** One switch, as the route sees it: who asks, which project, and the checks only the Host's state can make. */
export interface SwitchCaller {
  deviceId: string
  workspaceId: string
  /** The project's folder. */
  folder: string
  /**
   * Refusals that hold only for a switch that has to run (a Latch worktree, a session busy in the folder): asked after a
   * retry's answer and an already-there HEAD are given, so those never meet them.
   */
  prepare: () => Promise<void>
  /**
   * The device may still switch here, and no session whose folder overlaps this one runs, waits for approval or is
   * starting a turn. Called before the audit record and again right before Git starts.
   */
  authorize: () => Promise<void>
  /**
   * From here until the returned call, new turns, starts and terminals in sessions of this folder are refused
   * (`branch-switching`); set before the last `authorize`, so nothing slips between them.
   */
  hold: () => () => void
  /** Written before Git runs; when it throws, nothing runs. */
  audit: (detail: { requestHash: string; fromHash: string; toHash: string; preHead?: string }) => Promise<void>
  /** Written after; a failure is only logged. */
  result: (event: { requestHash: string; outcome: 'done' | 'failed' | 'unknown'; code?: SwitchCode; head?: string }) => Promise<void>
}

export interface BranchSwitcherOptions {
  holds: RepositoryHolds
  git?: string
  /** The restricted runner's home (whose global configuration applies); the Host user's by default. */
  home?: string
  timeoutMs?: number
  log: (text: string) => void
  /** HEAD of this folder may have moved: read its branch again and tell clients. */
  moved: (folder: string) => void
}

export class BranchSwitcher {
  private readonly reader: GitReader | undefined
  /** Requests under way and answered, by device and request. */
  private readonly inflight = new Map<string, { payload: string; answer: Promise<BranchSwitchResult> }>()
  private readonly answered = new Map<string, { payload: string; result: BranchSwitchResult }>()
  private closing = false

  constructor(private readonly options: BranchSwitcherOptions) {
    const binary = findGit(options.git ? [options.git] : undefined)
    this.reader = binary ? new GitReader({ binary, ...(options.home ? { home: options.home } : {}) }) : undefined
  }

  close(): void {
    this.closing = true
  }

  private git(): GitReader {
    if (!this.reader) throw refuse('git-no-git', '这台电脑上找不到 Git。安装 Git（或 Xcode 命令行工具）后再试。')
    return this.reader
  }

  private async layout(folder: string): Promise<GitLayout> {
    const layout = await readGitLayout(folder)
    if (!layout) throw refuse('git-not-repository', '项目文件夹不是 Git 仓库的顶层文件夹。')
    return layout
  }

  /** The project folder's local branches, from metadata files only. */
  async list(folder: string): Promise<BranchListing> {
    const layout = await this.layout(folder)
    try {
      return await listBranches(layout)
    } catch (error) {
      if (error instanceof BranchListError) throw refuse('branches-unreadable', '读不到这个仓库的分支。')
      throw error
    }
  }

  /**
   * Switches the folder to `branch`, one of the names its listing gives. The same request from the same device gets
   * the same answer; a request whose answer was lost finds HEAD already there and is answered without running Git.
   */
  async switch(caller: SwitchCaller, input: { requestId: string; branch: string }): Promise<BranchSwitchResult> {
    const key = `${caller.deviceId}\n${caller.workspaceId}\n${input.requestId}`
    const payload = sha256Hex(canonicalJson({ branch: input.branch }))
    const done = this.answered.get(key)
    if (done) {
      if (done.payload !== payload) throw refuse('request-conflict', '同一个请求标识不能用于不同的操作。')
      return { ...done.result, replay: true }
    }
    const current = this.inflight.get(key)
    if (current) {
      if (current.payload !== payload) throw refuse('request-conflict', '同一个请求标识不能用于不同的操作。')
      return current.answer
    }
    const answer = this.run(caller, input).then(result => {
      this.answered.set(key, { payload, result })
      while (this.answered.size > ANSWERS) this.answered.delete(this.answered.keys().next().value!)
      return result
    })
    this.inflight.set(key, { payload, answer })
    void answer.then(
      () => this.inflight.delete(key),
      () => this.inflight.delete(key),
    )
    return answer
  }

  private async run(caller: SwitchCaller, input: { requestId: string; branch: string }): Promise<BranchSwitchResult> {
    if (this.closing) throw new AppError(503, 'host-closing', '运行节点正在关闭')
    const git = this.git()
    const layout = await this.layout(caller.folder)
    const target = input.branch
    // Already there (a retry whose answer was lost, or a second press): nothing to run.
    if ('branch' in layout.head && layout.head.branch === target) {
      const head = await git.commit(layout, 'HEAD').catch(() => undefined)
      return { branch: target, ...(head ? { head } : {}), unchanged: true }
    }
    await caller.prepare()
    // Only a name the Host's own listing gives: never a revision, a path or an option.
    const listing = await this.list(caller.folder)
    const choice = listing.branches.find(item => item.name === target)
    if (!choice) throw refuse('branch-switch-unknown', '这个仓库里没有这个本地分支，没有切换。')
    if (choice.checkedOut) throw refuse('branch-switch-checked-out', '这个分支已在另一个工作树检出，同一个分支不能同时在两处检出。')
    let common: string
    try {
      common = await commonDirOf(git, layout)
    } catch {
      throw new AppError(500, 'git-failed', 'Git 没有完成读取，请稍后再试。')
    }
    const release = this.options.holds.take(common, 'branch-switch')
    if (!release) throw refuse('git-busy', '这个仓库正在进行另一个 Git 操作，等它结束后再试。')
    let unhold: (() => void) | undefined
    try {
      if (await gitOperation(layout).catch(() => 'unknown' as const))
        throw refuse('git-operation-in-progress', '仓库正在合并、变基、拣选或还原，在终端里完成后再试。')
      const config = await readRepositoryConfig(git, layout).catch(() => {
        throw new AppError(500, 'git-failed', 'Git 没有完成读取，请稍后再试。')
      })
      const refused = configRefusal(config)
      if (refused) throw refused
      const commit = await git.commit(layout, `refs/heads/${target}`)
      if (!commit) throw refuse('branch-switch-unknown', '这个仓库里没有这个本地分支，没有切换。')
      const preHead = await git.commit(layout, 'HEAD').catch(() => undefined)
      const from = 'branch' in layout.head ? `branch:${layout.head.branch}` : `detached:${layout.head.detached}`
      // New turns in this folder are refused from here; the check after it sees every one that began before.
      unhold = caller.hold()
      await caller.authorize()
      const requestHash = sha256Hex(input.requestId)
      await caller.audit({ requestHash, fromHash: sha256Hex(from), toHash: sha256Hex(`branch:${target}`), ...(preHead ? { preHead } : {}) })
      return await this.checkout(caller, layout, { requestHash, target, commit })
    } finally {
      unhold?.()
      release()
      this.options.moved(caller.folder)
    }
  }

  /** After the audit record: `git switch`, then what HEAD says, which is the answer whatever Git's exit status. */
  private async checkout(
    caller: SwitchCaller,
    layout: GitLayout,
    plan: { requestHash: string; target: string; commit: string },
  ): Promise<BranchSwitchResult> {
    const git = this.git()
    const finish = async (outcome: 'done' | 'failed' | 'unknown', code?: SwitchCode, head?: string) => {
      try {
        await caller.result({ requestHash: plan.requestHash, outcome, ...(code ? { code } : {}), ...(head ? { head } : {}) })
      } catch (error) {
        this.options.log(`切换分支的结果没有写入审计：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      await git.run(
        layout,
        [
          ...WRITE_CONFIG,
          'switch',
          '--no-guess',
          '--no-recurse-submodules',
          // An ignored file the branch tracks (an .env) is refused, never overwritten.
          '--no-overwrite-ignore',
          '--quiet',
          '--end-of-options',
          plan.target,
        ],
        {
          maxBytes: 1024 * 1024,
          stderrBytes: 16 * 1024,
          // Git's own words, in English whatever the computer's language, so its refusals can be told apart.
          env: { LC_ALL: 'C' },
          timeoutMs: this.options.timeoutMs ?? SWITCH_TIMEOUT_MS,
          // Read again right before Git starts: the configuration, the branch and the folder's sessions.
          authorize: async () => {
            await caller.authorize()
            const refused = configRefusal(await readRepositoryConfig(git, layout))
            if (refused) throw refused
            if ((await git.commit(layout, `refs/heads/${plan.target}`)) !== plan.commit)
              throw refuse('branch-switch-moved', '这个分支刚刚变了，没有切换。重新打开列表再试。')
          },
        },
      )
    } catch (error) {
      if (error instanceof AppError) {
        const code = (['branch-switch-config', 'branch-switch-moved'] as const).find(item => item === error.code) ?? 'refused'
        await finish('failed', code)
        throw error
      }
      // A hook in some configuration whose name cannot be switched off from the command line: nothing ran.
      if (error instanceof GitError && error.reason === 'unsafe-config') {
        await finish('failed', 'branch-switch-config')
        throw refuse('branch-switch-config', CONFIG_WORDS.hook, { kind: 'hook' })
      }
      const now = await readGitLayout(layout.root)
      if (now && 'branch' in now.head && now.head.branch === plan.target) {
        const head = await git.commit(now, 'HEAD').catch(() => undefined)
        await finish('done', undefined, head)
        return { branch: plan.target, ...(head ? { head } : {}) }
      }
      if (error instanceof GitError && error.reason === 'timeout') {
        await finish('unknown')
        throw new AppError(504, 'git-result-unknown', 'Git 没有及时完成切换，结果未知。重试同一个请求即可知道。')
      }
      const said = error instanceof GitError ? (error.stderr ?? '') : ''
      if (/would be overwritten by checkout|untracked working tree files would be/iu.test(said)) {
        await finish('failed', 'branch-switch-local-changes')
        throw refuse('branch-switch-local-changes', '有未提交的改动会被这个分支覆盖，没有切换。先提交或移走这些改动。')
      }
      if (
        /is already (?:checked out|used by worktree) at/iu.test(said)
        || (await branchesElsewhere(layout).catch(() => new Set())).has(plan.target)
      ) {
        await finish('failed', 'branch-switch-checked-out')
        throw refuse('branch-switch-checked-out', '这个分支已在另一个工作树检出，同一个分支不能同时在两处检出。')
      }
      await finish('failed', 'branch-switch-failed')
      throw new AppError(422, 'branch-switch-failed', 'Git 没有完成切换，文件夹仍在原来的分支上。在终端里查看。')
    }
    const now = await readGitLayout(layout.root)
    if (!now || !('branch' in now.head) || now.head.branch !== plan.target) {
      await finish('failed', 'branch-switch-failed')
      throw new AppError(422, 'branch-switch-failed', 'Git 没有完成切换，文件夹仍在原来的分支上。在终端里查看。')
    }
    const head = await git.commit(now, 'HEAD').catch(() => undefined)
    await finish('done', undefined, head)
    return { branch: plan.target, ...(head ? { head } : {}) }
  }
}
