// The 交付 tab's pure logic: where the repository stands, what the one blue button does, and what each fixed reason says.
import type { GitDeliveryFile, GitDeliveryKind, GitDeliveryRunning, GitDeliveryState, GitFileStatus, GitOperation } from '@latch/protocol'

export type DeliveryStep = 'stage' | 'commit' | 'push' | 'done'

/** The progress line's place: staged files wait for a commit, local commits for a push, changed files for staging. */
export function deliveryStep(state: GitDeliveryState): DeliveryStep {
  if (state.staged.length > 0) return 'commit'
  if (changedCount(state) > 0) return 'stage'
  if (canPush(state)) return 'push'
  return 'done'
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

export function pushLabel(state: Pick<GitDeliveryState, 'upstream' | 'ahead'>): string {
  return state.upstream && state.ahead > 0 ? `推送 ${state.ahead} 个提交` : '推送'
}

/** The one blue button: 暂存全部, then 提交 N 个文件, then 推送 (推送 N 个提交 when the branch is ahead). */
export function primaryAction(state: GitDeliveryState): PrimaryAction | undefined {
  const step = deliveryStep(state)
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

/** The one line that says why nothing can be written now. */
export function operationNote(operation: GitOperation | undefined): string {
  return operation && operation !== 'unmerged' ? `${OPERATION_WORD[operation]}进行中，在终端里完成` : '合并/变基进行中，在终端里完成'
}

export const RUNNING_WORD: Record<GitDeliveryKind, string> = {
  stage: '暂存中…',
  unstage: '取消暂存中…',
  commit: '提交中…',
  push: '推送中…',
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
      return { label: '远端有你没有的提交', tone: 'failed', detail: '先在终端里拉取并合并，再推送。Latch 从不强制推送。' }
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
    case 'request-conflict':
      return { label: '同一请求换了内容，没有执行', tone: 'failed' }
    case 'git-failed':
      return { label: 'Git 没有完成', tone: 'failed' }
    default:
      return undefined
  }
}

/**
 * How a commit or push ends. `updating`: the Host is installing an update and refused it before looking at anything,
 * receipts included, so it is neither a failure nor an answer: what was pending stays pending, its request ID too.
 */
export type WriteEnd = 'done' | 'failed' | 'unknown' | 'updating'

export function writeEnd(input: { code?: string | undefined; uncertain: boolean }): Exclude<WriteEnd, 'done'> {
  if (input.code === 'host-updating') return 'updating'
  return input.uncertain ? 'unknown' : 'failed'
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
