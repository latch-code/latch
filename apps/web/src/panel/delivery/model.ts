// The 交付 tab's pure logic: where the repository stands, what the one blue button does, and what each fixed reason says.
import { relativeTime } from '../../format.ts'
import type {
  GitCheck,
  GitCheckState,
  GitDeliveryFile,
  GitDeliveryKind,
  GitDeliveryRunning,
  GitDeliveryState,
  GitFileStatus,
  GitOperation,
  GitPrComment,
  GitPrStatus,
  GitPullRequest,
  GitReviewDecision,
  GitReviewState,
} from '@latch/protocol'

export type DeliveryStep = 'stage' | 'commit' | 'push' | 'pr' | 'done'

/**
 * The progress line's place: staged files wait for a commit, local commits for a push, changed files for staging, and
 * a branch on its remote for a pull request until one is bound.
 */
export function deliveryStep(state: GitDeliveryState, pr: { bound: boolean } = { bound: true }): DeliveryStep {
  if (state.staged.length > 0) return 'commit'
  if (changedCount(state) > 0) return 'stage'
  if (canPush(state)) return 'push'
  if (prAvailable(state) && !nothingToMerge(state) && !pr.bound) return 'pr'
  return 'done'
}

/** The branch is on its remote as the same name, so a pull request can be made from it, or one is bound to it. */
export function prAvailable(state: Pick<GitDeliveryState, 'branch' | 'remote' | 'upstream'>): boolean {
  return !!state.branch && !!state.remote && state.upstream === `${state.remote}/${state.branch}`
}

/** It is the base branch itself, or has no commit the base lacks: a new pull request would merge nothing. */
export function nothingToMerge(state: Pick<GitDeliveryState, 'base'>): boolean {
  return state.base?.ahead === 0
}

/**
 * The line beside the remote: 新分支, 领先 and 落后, or 已是最新. Behind is counted from the last fetch (获取), so it
 * shows only with that time, which goes with it; without one nothing says the branch is up to date.
 */
export function aheadBehind(state: Pick<GitDeliveryState, 'upstream' | 'ahead' | 'behind' | 'fetchedAt'>, now = new Date()): string {
  if (!state.upstream) return '新分支'
  const ahead = state.ahead ? `领先 ${state.ahead}` : ''
  if (state.fetchedAt === undefined) return ahead || '已推送'
  const when = relativeTime(state.fetchedAt, now)
  const fetched = /(分钟|小时|天)$/u.test(when) ? `${when}前获取` : /^\d/u.test(when) ? `${when} 获取` : `${when}获取`
  return [ahead, state.behind ? `落后 ${state.behind}` : '', !ahead && !state.behind ? '已是最新' : '', fetched].filter(Boolean).join(' · ')
}

/** Files that can still be staged: unstaged, untracked and conflicted. */
export function changedCount(state: GitDeliveryState): number {
  return state.unstaged.length + state.untracked.length + state.conflicted.length
}

/** Every path a 暂存全部 stages, each once. */
export function stageAllPaths(state: GitDeliveryState): string[] {
  return [...new Set([...state.unstaged.map(file => file.path), ...state.untracked, ...state.conflicted])]
}

/** A push has somewhere to go and something to take there. Without an upstream the branch itself is new on the remote. */
export function canPush(state: GitDeliveryState): boolean {
  if (!state.branch || !state.head || !state.remote) return false
  return !state.upstream || state.ahead > 0
}

export type PrimaryAction =
  | { kind: 'stage'; label: string; paths: string[] }
  | { kind: 'commit'; label: string }
  | { kind: 'push'; label: string }
  | { kind: 'pr'; label: string }

export function pushLabel(state: Pick<GitDeliveryState, 'upstream' | 'ahead'>): string {
  return state.upstream && state.ahead > 0 ? `推送 ${state.ahead} 个提交` : '推送'
}

/**
 * The one blue button: 暂存全部, then 提交 N 个文件, then 推送 (推送 N 个提交 when the branch is ahead), then 创建 PR.
 * `justCommitted` (the phone's page, right after its commit): the files left out were left out on purpose, so 推送 comes
 * next while there is somewhere to push, and 全部暂存 stays a quiet button.
 */
export function primaryAction(
  state: GitDeliveryState,
  pr: { bound: boolean; justCommitted?: boolean } = { bound: true },
): PrimaryAction | undefined {
  if (pr.justCommitted && state.staged.length === 0 && state.conflicted.length === 0 && canPush(state))
    return { kind: 'push', label: pushLabel(state) }
  const step = deliveryStep(state, pr)
  if (step === 'pr') return { kind: 'pr', label: '创建 PR' }
  if (step === 'commit') return { kind: 'commit', label: `提交 ${state.staged.length} 个文件` }
  if (step === 'stage') return { kind: 'stage', label: '暂存全部', paths: stageAllPaths(state) }
  if (step === 'push') return { kind: 'push', label: pushLabel(state) }
  return undefined
}

export const STATUS_WORD: Record<GitFileStatus, string> = { A: '新增', M: '修改', D: '删除', T: '类型变化' }

export const OPERATION_WORD: Record<GitOperation, string> = {
  merge: '合并',
  rebase: '变基',
  'cherry-pick': '拣选',
  revert: '还原',
  unmerged: '合并',
}

/**
 * The one line that says why nothing can be written now. `abortable`: the Host can abort it (`features.gitSync`), so
 * the panel offers that instead of the terminal.
 */
export function operationNote(operation: GitOperation | undefined, abortable = false): string {
  if (operation && operation !== 'unmerged')
    return abortable ? `${OPERATION_WORD[operation]}进行中` : `${OPERATION_WORD[operation]}进行中，在终端里完成`
  return '合并/变基进行中，在终端里完成'
}

export const RUNNING_WORD: Record<GitDeliveryKind, string> = {
  stage: '暂存中…',
  unstage: '取消暂存中…',
  commit: '提交中…',
  push: '推送中…',
  pr: '创建 PR 中…',
  fetch: '获取中…',
  pull: '拉取中…',
  abort: '中止中…',
}

export function runningLabel(running: Pick<GitDeliveryRunning, 'kind' | 'hook'>): string {
  return running.hook ? `${RUNNING_WORD[running.kind]} ${running.hook}` : RUNNING_WORD[running.kind]
}

/** What a refusal or failure carries besides its code (`GitDeliveryError` details). */
export interface FailureDetails {
  hook?: string
  exitCode?: number
  tail?: string
  remoteLines?: string[]
  running?: GitDeliveryRunning
  remoteSha?: string
  /** `git-pull-diverged`: the branch's own commits and the upstream's. */
  ahead?: number
  behind?: number
}

export function failureDetails(details: Readonly<Record<string, unknown>>): FailureDetails {
  const out: FailureDetails = {}
  if (typeof details.hook === 'string') out.hook = details.hook
  if (typeof details.exitCode === 'number') out.exitCode = details.exitCode
  if (typeof details.tail === 'string') out.tail = details.tail
  if (Array.isArray(details.remoteLines)) out.remoteLines = details.remoteLines.filter((line): line is string => typeof line === 'string')
  const running = details.running as Partial<GitDeliveryRunning> | undefined
  if (running && typeof running.kind === 'string' && typeof running.requestId === 'string')
    out.running = {
      kind: running.kind,
      requestId: running.requestId,
      startedAt: typeof running.startedAt === 'string' ? running.startedAt : '',
      ...(typeof running.hook === 'string' ? { hook: running.hook } : {}),
    }
  if (typeof details.remoteSha === 'string') out.remoteSha = details.remoteSha
  if (typeof details.ahead === 'number') out.ahead = details.ahead
  if (typeof details.behind === 'number') out.behind = details.behind
  return out
}

/**
 * How a refusal or failure reads: a short label, a tone (neutral is not a failure), and the fine print for a Hint.
 * `undefined` for codes the tab draws in its own way (the hook card, result unknown) or does not know.
 */
export interface FailureCopy {
  label: string
  tone: 'neutral' | 'warn' | 'failed'
  detail?: string
}

export function failureCopy(code: string, operation?: GitOperation): FailureCopy | undefined {
  switch (code) {
    case 'git-turn-running':
      return { label: 'Agent 正在改这个文件夹', tone: 'neutral', detail: '这一轮结束后再暂存或提交；推送不受影响。' }
    case 'git-operation-in-progress':
      return { label: operationNote(operation), tone: 'warn' }
    case 'host-updating':
      return { label: '这台电脑正在安装更新', tone: 'neutral' }
    case 'git-busy':
      return { label: '另一个交付操作正在进行', tone: 'neutral' }
    case 'git-nothing-staged':
      return { label: '没有暂存的文件', tone: 'neutral' }
    case 'git-conflicted':
      return { label: '有冲突的文件', tone: 'warn', detail: '先在终端里解决冲突，再暂存这些文件。' }
    case 'git-identity-missing':
      return { label: 'Git 不知道提交者是谁', tone: 'warn', detail: '在终端里设置 user.name 与 user.email 后再提交。' }
    case 'git-no-remote':
      return { label: '没有远端，提交留在本地', tone: 'neutral' }
    case 'git-detached':
      return { label: '不在任何分支上', tone: 'neutral', detail: 'HEAD 是分离的，推送需要一个分支。' }
    case 'git-no-commit':
      return { label: '还没有提交', tone: 'neutral' }
    case 'git-upstream-other-branch':
      return {
        label: '上游是另一个分支',
        tone: 'neutral',
        detail: '推送总是推到远端上与当前分支同名的分支，这个分支的上游指向别的名字。在终端里推送，或改成同名的上游。',
      }
    case 'git-remote-invalid':
      return { label: '推送的远端不在仓库配置里', tone: 'failed', detail: '检查 pushRemote、pushDefault 与上游的远端名。' }
    case 'git-commit-failed':
      return { label: '提交失败', tone: 'failed' }
    case 'git-commit-not-made':
      return { label: '没有生成提交，可以重新提交', tone: 'neutral' }
    case 'git-push-auth':
      return { label: '远端不接受凭据', tone: 'failed', detail: '在终端里检查这个仓库的登录或 SSH 密钥。' }
    case 'git-push-non-fast-forward':
      return { label: '远端有你没有的提交', tone: 'failed', detail: '先拉取并合并（git pull），再推送。Latch 从不强制推送。' }
    case 'git-push-remote-rejected':
      return { label: '远端钩子拒绝了推送', tone: 'failed' }
    case 'git-push-unreachable':
      return { label: '连不上远端', tone: 'failed' }
    case 'git-push-host-key':
      return { label: '远端主机密钥没有通过验证', tone: 'failed', detail: '在终端里连一次这个远端，核对并记下主机密钥。' }
    case 'git-push-failed':
      return { label: '推送失败', tone: 'failed' }
    case 'git-stage-failed':
      return { label: '暂存失败', tone: 'failed', detail: 'Git 拒绝了这些文件，例如被忽略的文件。' }
    case 'git-receipt-unsaved':
      return { label: '没能记下这次请求，没有执行', tone: 'failed' }
    case 'git-not-repository':
      return { label: '会话文件夹不是 Git 仓库的顶层', tone: 'neutral' }
    case 'git-no-git':
      return { label: '这台电脑上找不到 Git', tone: 'failed' }
    case 'git-folder-unavailable':
    case 'workspace-changed':
      return { label: '会话文件夹不可用', tone: 'failed' }
    case 'git-paths-invalid':
      return { label: '路径无效', tone: 'failed' }
    case 'rate-limited':
      return { label: '请求太频繁，稍后再试', tone: 'neutral' }
    case 'task-not-found':
      return { label: '找不到这个会话', tone: 'neutral' }
    case 'session-read-only':
      return { label: '这个会话只读', tone: 'neutral' }
    case 'scope-required':
    case 'file-scope':
    case 'agent-scope-required':
      return { label: '这台设备没有这项权限', tone: 'neutral', detail: '在电脑上的设备管理里调整这台设备的权限。' }
    case 'request-conflict':
      return { label: '同一请求换了内容，没有执行', tone: 'failed' }
    case 'git-failed':
      return { label: 'Git 没有完成', tone: 'failed' }
    case 'gh-missing':
      return { label: '没有 gh', tone: 'warn', detail: '安装 GitHub CLI（gh），再在终端里运行 gh auth login。' }
    case 'gh-logged-out':
      return { label: 'gh 未登录', tone: 'warn', detail: '在终端里运行 gh auth login。' }
    case 'gh-no-remote':
      return { label: '这个远端不是 GitHub', tone: 'neutral', detail: '其他平台的 PR 尚未实现。' }
    case 'gh-unreachable':
      return { label: '连不上 GitHub', tone: 'failed' }
    case 'gh-failed':
      return { label: 'gh 没有完成', tone: 'failed' }
    case 'pr-exists-elsewhere':
      return { label: '这个分支已有 PR，不在推送的仓库里', tone: 'warn', detail: '在 GitHub 上查看这个分支的 PR。' }
    case 'pr-not-pushed':
      return { label: '先推送这个分支', tone: 'neutral' }
    case 'pr-nothing-ahead':
      return { label: '没有可以合入的提交', tone: 'neutral' }
    case 'pr-create-failed':
      return { label: 'PR 没有创建', tone: 'failed' }
    case 'pr-input-invalid':
      return { label: '标题或基线无效', tone: 'failed', detail: '标题一行、最多 256 个字符；基线是分支名。' }
    case 'pr-check-not-found':
      return { label: '这个检查已不在 PR 上', tone: 'neutral' }
    case 'git-no-upstream':
      return { label: REASON.noUpstream, tone: 'neutral', detail: '先推送一次，这个分支就有了上游。' }
    case 'git-remote-form':
      return {
        label: '这个远端不能在这里获取',
        tone: 'neutral',
        detail: '只经 https、http、ssh 或本机路径获取，获取规则只写远端跟踪分支与标签。在终端里获取。',
      }
    case 'git-fetch-auth':
      return { label: '远端不接受凭据', tone: 'failed', detail: '在终端里检查这个仓库的登录或 SSH 密钥。' }
    case 'git-fetch-host-key':
      return { label: '远端主机密钥没有通过验证', tone: 'failed', detail: '在终端里连一次这个远端，核对并记下主机密钥。' }
    case 'git-fetch-unreachable':
      return { label: '连不上远端', tone: 'failed' }
    case 'git-fetch-timeout':
      return { label: '获取超时', tone: 'failed' }
    case 'git-fetch-failed':
      return { label: '获取失败', tone: 'failed' }
    case 'git-pull-diverged':
      return { label: REASON.diverged, tone: 'warn' }
    case 'git-pull-local-changes':
      return { label: '未提交的改动会被覆盖', tone: 'warn', detail: '上游改了同样的文件。先提交或暂存这些改动，再拉取。' }
    case 'git-pull-failed':
      return { label: '拉取失败，仓库保持原样', tone: 'failed' }
    case 'git-drivers':
      return { label: REASON.drivers, tone: 'neutral', detail: '在终端里完成这一步，filter 与合并驱动才会照常运行。' }
    case 'git-no-operation':
      return { label: '已没有进行中的操作', tone: 'neutral' }
    case 'git-operation-changed':
      return { label: '进行中的操作变了，没有中止', tone: 'warn' }
    case 'git-abort-failed':
      return { label: '没有中止', tone: 'failed', detail: '在终端里查看仓库的状态。' }
    case 'sync-unanswered':
      return { label: '没有收到答复，已重新读取仓库', tone: 'neutral' }
    default:
      return undefined
  }
}

/**
 * How a commit or push ends. `updating`: the Host is installing an update and refused it before looking at anything,
 * receipts included, so it is neither a failure nor an answer: what was pending stays pending, its request ID too.
 */
export type WriteEnd = 'done' | 'failed' | 'unknown' | 'updating'

/**
 * Answers to a retried write that the Host gives only after reading its receipt (`replay`) or what the remote holds;
 * every other answer to a retry says nothing about the first attempt (docs/GIT-DELIVERY.md「回执与结果未知」).
 * - commit: never run again, so only the receipt's answer settles it.
 * - push: the failures of a push run again after `ls-remote` showed the remote's branch without the commit.
 * - pr: the Host looked the branch's pull request up and found none, then `gh pr create` refused, or found one
 *   elsewhere. `gh-*` codes may come from before that lookup, so they settle nothing.
 */
const SETTLES_RETRY: Readonly<Record<'commit' | 'push' | 'pr', ReadonlySet<string>>> = {
  commit: new Set(),
  push: new Set([
    'git-push-remote-rejected',
    'git-hook-failed',
    'git-push-auth',
    'git-push-host-key',
    'git-push-unreachable',
    'git-push-failed',
  ]),
  pr: new Set(['pr-create-failed', 'pr-exists-elsewhere']),
}

/**
 * `retry`: the same request again after an unknown result. It settles only on an answer from the receipt (`replay`) or
 * from the remote; any other refusal (a route's 400, 403 or 429, a session check) says nothing about the first attempt,
 * so the result stays unknown with its request ID, for the person to retry or abandon.
 */
export function writeEnd(input: {
  code?: string | undefined
  uncertain: boolean
  retry?: { kind: 'commit' | 'push' | 'pr'; replay: boolean }
}): Exclude<WriteEnd, 'done'> {
  if (input.code === 'host-updating') return 'updating'
  if (input.uncertain) return 'unknown'
  const retry = input.retry
  if (retry && !retry.replay && !(input.code !== undefined && SETTLES_RETRY[retry.kind].has(input.code))) return 'unknown'
  return 'failed'
}

/** The write whose result is unknown after an attempt: the attempt's own, or the one pending before it. */
export function unknownAfter<T extends { requestId: string }>(pending: T | undefined, write: T, end: WriteEnd): T | undefined {
  if (end === 'unknown') return write
  if (end === 'updating') return pending
  return pending?.requestId === write.requestId ? undefined : pending
}

/** A fence longer than any run of backticks in the text, so the excerpt cannot close it early. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/gu)].map(match => match[0].length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/** At most this much of a hook's output goes into the draft: its end, where the reason usually is. */
export const EXCERPT_LINES = 80
export const EXCERPT_CHARS = 8_000

/** The hook failure as a fenced excerpt for the composer draft; it is never sent by itself. */
export function hookExcerpt(input: { hook?: string; exitCode?: number; tail?: string; push?: boolean }): string {
  const name = input.hook ?? (input.push ? 'pre-push' : 'pre-commit')
  const exit = input.exitCode !== undefined ? `，退出码 ${input.exitCode}` : ''
  let tail = (input.tail ?? '').replace(/\s+$/u, '')
  const lines = tail.split('\n')
  if (lines.length > EXCERPT_LINES) tail = lines.slice(-EXCERPT_LINES).join('\n')
  if (tail.length > EXCERPT_CHARS) tail = tail.slice(-EXCERPT_CHARS)
  const fence = fenceFor(tail)
  const head = input.push ? `推送前的钩子 ${name} 没通过${exit}，没有推送：` : `提交钩子 ${name} 没通过${exit}，没有生成提交：`
  return `${head}\n\n${fence}text\n${tail}\n${fence}`
}

const ACCOUNT_NOTE = '提交与推送以你在这台电脑上的账户运行，用你的凭据，与在终端里相同；这不是沙箱。'

/** The fine print of 「运行仓库钩子」: the hooks it may run, the filters, and whose account it runs as. */
export function hooksDetail(state: Pick<GitDeliveryState, 'hooks' | 'filters'>): string {
  const hooks = state.hooks.length ? `仓库的钩子：${state.hooks.join('、')}。` : '仓库里没有可执行的钩子。'
  const filters = state.filters ? '仓库配置了 filter 驱动（如 Git LFS），暂存与提交时照常运行。' : ''
  return `${hooks}${filters}${ACCOUNT_NOTE}`
}

/** The same fine print for a device that cannot read the repository: the hooks are not listed to it. */
export const HOOKS_UNLISTED = `仓库的钩子会照常运行。${ACCOUNT_NOTE}`

export type FileGroup = 'staged' | 'unstaged' | 'untracked' | 'conflicted'

export interface GroupRow {
  path: string
  /** A word for the file's state: 新增, 修改, 删除, 类型变化, 未跟踪, 冲突. */
  word: string
  /** Pressing its box stages it (false) or unstages it (true). */
  staged: boolean
}

export const GROUP_TITLE: Record<FileGroup, string> = { staged: '已暂存', unstaged: '未暂存', untracked: '未跟踪', conflicted: '冲突' }

const tracked = (files: GitDeliveryFile[], staged: boolean): GroupRow[] =>
  files.map(file => ({ path: file.path, word: STATUS_WORD[file.status], staged }))

export function groupRows(state: GitDeliveryState, group: FileGroup): GroupRow[] {
  if (group === 'staged') return tracked(state.staged, true)
  if (group === 'unstaged') return tracked(state.unstaged, false)
  if (group === 'untracked') return state.untracked.map(path => ({ path, word: '未跟踪', staged: false }))
  return state.conflicted.map(path => ({ path, word: '冲突', staged: false }))
}

/** A short commit for display. */
export const shortSha = (sha: string) => sha.slice(0, 7)

export const PR_STATE_WORD: Record<GitPrStatus, string> = { open: '开启', closed: '已关闭', merged: '已合并' }

export const REVIEW_DECISION_WORD: Record<GitReviewDecision, string> = {
  approved: '已批准',
  'changes-requested': '要求修改',
  'review-required': '待审阅',
}

export const REVIEW_WORD: Record<GitReviewState, string> = {
  approved: '批准',
  'changes-requested': '要求修改',
  commented: '审阅',
  dismissed: '已撤销的审阅',
}

export const CHECK_WORD: Record<GitCheckState, string> = { pass: '通过', fail: '失败', pending: '进行中', skipped: '跳过' }

/** The checks as one state: any failure, else any still running, else passed; nothing without checks. */
export function checksSummary(checks: readonly GitCheck[]): 'fail' | 'pending' | 'pass' | undefined {
  if (checks.some(check => check.state === 'fail')) return 'fail'
  if (checks.some(check => check.state === 'pending')) return 'pending'
  if (checks.some(check => check.state === 'pass')) return 'pass'
  return undefined
}

/** The checks are of another commit than the one the branch is at here: an older push, or a commit not pushed yet. */
export function checksStale(pr: Pick<GitPullRequest, 'headSha'>, head: string | undefined): boolean {
  return !!pr.headSha && !!head && pr.headSha !== head
}

/** How long a finished check ran, as m:ss (h:mm:ss past an hour). */
export function checkDuration(check: Pick<GitCheck, 'startedAt' | 'completedAt'>): string | undefined {
  if (!check.startedAt || !check.completedAt) return undefined
  const ms = Date.parse(check.completedAt) - Date.parse(check.startedAt)
  if (!Number.isFinite(ms) || ms < 0) return undefined
  const total = Math.round(ms / 1000)
  const hours = Math.floor(total / 3600),
    minutes = Math.floor((total % 3600) / 60),
    seconds = String(total % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** A failed check's log excerpt for the composer draft, fenced, with the check and the commit it ran on. */
export function checkExcerpt(input: { number: number; check: string; sha?: string | undefined; text: string }): string {
  const fence = fenceFor(input.text)
  const at = input.sha ? `（${shortSha(input.sha)}）` : ''
  return `PR #${input.number} 的检查 ${input.check} 失败${at}：\n\n${fence}text\n${input.text.replace(/\s+$/u, '')}\n${fence}`
}

/** Where a review or comment is: the file and line of a line comment, else what kind of remark it is. */
export function commentPlace(comment: Pick<GitPrComment, 'kind' | 'review' | 'path' | 'line'>): string {
  if (comment.kind === 'line') return comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ''}` : '行内评论'
  if (comment.kind === 'review') return comment.review ? REVIEW_WORD[comment.review] : '审阅'
  return '评论'
}

/** A review or comment for the composer draft: author, place and the original words, fenced. */
export function commentExcerpt(input: { number: number; comment: GitPrComment }): string {
  const { comment } = input
  const text = comment.body || '（没有正文）'
  const fence = fenceFor(text)
  return `PR #${input.number} · ${comment.author} · ${commentPlace(comment)}：\n\n${fence}text\n${text}\n${fence}`
}

/** What to run after a push the remote refused as not a fast-forward: the upstream's commits, merged or rebased as your Git is set. */
export const PULL_COMMAND = 'git pull'

/**
 * Why a control is off, one wording everywhere: the control is disabled and this is its hover. The same words head the
 * fixed reasons above where a refusal says the same thing.
 */
export const REASON = {
  offline: '这台电脑不在线',
  permission: '这台设备没有这项权限',
  readOnly: '这个会话只读',
  busy: '另一个交付操作正在进行',
  turn: 'Agent 正在改这个文件夹',
  noRemote: '这个仓库没有远端',
  detached: '不在任何分支上',
  noUpstream: '这个分支没有上游',
  notFetched: '还没有获取过，先获取',
  diverged: '与上游已分叉',
  drivers: '仓库配置了 filter 或合并驱动',
  upToDate: '已是最新',
  ghLoggedOut: 'gh 未登录',
  ghMissing: '没有 gh',
} as const

export function operationReason(operation: GitOperation): string {
  return `${OPERATION_WORD[operation]}进行中`
}

/** The page's own limits on a write, before the repository's: undefined when none applies. */
export interface WriteLimits {
  offline: boolean
  canWrite: boolean
  readOnly: boolean
  busy: boolean
  turnRunning: boolean
}

function limitReason(limits: WriteLimits, turnSensitive: boolean): string | undefined {
  if (limits.offline) return REASON.offline
  if (limits.readOnly) return REASON.readOnly
  if (!limits.canWrite) return REASON.permission
  if (limits.busy) return REASON.busy
  if (turnSensitive && limits.turnRunning) return REASON.turn
  return undefined
}

/** The branch and its upstream each have commits the other lacks, as of the last fetch. */
export function diverged(state: Pick<GitDeliveryState, 'upstream' | 'ahead' | 'behind' | 'fetchedAt'>): boolean {
  return !!state.upstream && !!state.fetchedAt && state.ahead > 0 && state.behind > 0
}

/** Why 获取 is off, or undefined when it may be pressed. A fetch changes only refs: a turn or an operation does not stop it. */
export function fetchReason(state: GitDeliveryState, limits: WriteLimits): string | undefined {
  return limitReason(limits, false) ?? (!state.remote && !state.upstream ? REASON.noRemote : undefined)
}

/**
 * Why 拉取 is off, or undefined when it may be pressed. It fetches first, then only fast-forwards, so it needs an
 * upstream, a fetch to say how far behind the branch is, and no commits of its own the upstream lacks.
 */
export function pullReason(state: GitDeliveryState, limits: WriteLimits): string | undefined {
  const limit = limitReason(limits, true)
  if (limit) return limit
  if (state.gitOperation) return state.gitOperation === 'unmerged' ? operationReason('merge') : operationReason(state.gitOperation)
  if (!state.branch) return REASON.detached
  if (!state.remote && !state.upstream) return REASON.noRemote
  if (!state.upstream) return REASON.noUpstream
  if (state.filters) return REASON.drivers
  if (!state.fetchedAt) return REASON.notFetched
  if (diverged(state)) return REASON.diverged
  return undefined
}

/** Why 中止 is off, or undefined when it may be pressed. */
export function abortReason(state: GitDeliveryState, limits: WriteLimits): string | undefined {
  return limitReason(limits, true) ?? (state.filters ? REASON.drivers : undefined)
}

/** The operation that 中止 ends, when one is under way and its kind is known. */
export function abortable(state: Pick<GitDeliveryState, 'gitOperation'>): Exclude<GitOperation, 'unmerged'> | undefined {
  return state.gitOperation && state.gitOperation !== 'unmerged' ? state.gitOperation : undefined
}

const CONTINUE: Record<Exclude<GitOperation, 'unmerged'>, string> = {
  merge: 'git merge --continue',
  rebase: 'git rebase --continue',
  'cherry-pick': 'git cherry-pick --continue',
  revert: 'git revert --continue',
}

/** 交给 Agent 解决: the conflicted files and what to do, for the composer draft; never sent by itself. */
export function conflictPrompt(input: { operation: Exclude<GitOperation, 'unmerged'>; paths: readonly string[]; more?: number }): string {
  const list = input.paths.join('\n')
  const fence = fenceFor(list)
  const more = input.more ? `\n（还有 ${input.more} 个没有列出）` : ''
  const word = OPERATION_WORD[input.operation]
  return `仓库正在${word}，这些文件有冲突：\n\n${fence}text\n${list}\n${fence}${more}\n\n请解决这些冲突，保留两边需要的改动；解决后暂存这些文件并完成这次${word}（${CONTINUE[input.operation]}），再告诉我结果。不要中止，也不要强制推送。`
}

/** 交给 Agent: a branch that diverged from its upstream, for the composer draft; how to bring them together is asked. */
export function divergedPrompt(input: { branch: string; upstream: string; ahead: number; behind: number }): string {
  return `分支 ${input.branch} 与上游 ${input.upstream} 已分叉：这里有 ${input.ahead} 个上游没有的提交，上游有 ${input.behind} 个这里没有的提交。请把上游的提交整合进来，用合并还是变基先问我；有冲突就解决。不要强制推送。`
}
