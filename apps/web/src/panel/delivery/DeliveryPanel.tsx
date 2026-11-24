import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDownToLine, CircleHelp, GitPullRequest, MessageSquarePlus, RefreshCw, Upload, Webhook } from 'lucide-react'
import type { GitDeliveryState, TaskSummary } from '@latch/protocol'
import {
  Button,
  ConfirmDialog,
  Hint,
  ICON_STROKE,
  Spinner,
  StatusWord,
  Switch,
  TextAreaField,
  type IconComponent,
  CheckGlyph,
  ChevronRightGlyph,
  AlertGlyph,
  CommitGlyph,
  CopyButton,
  InfoGlyph,
  WarningGlyph,
} from '@latch/ui'
import { escapeHiddenCharacters, VisibleText } from '../../components/VisibleText.tsx'
import { computerName, SETUP_COPY } from '../../core/securityCopy.ts'
import { TerminalFillButton } from '../../components/TerminalFillButton.tsx'
import { dateTime } from '../../format.ts'
import {
  abortable,
  abortReason,
  aheadBehind,
  conflictPrompt,
  diverged,
  divergedPrompt,
  fetchReason,
  OPERATION_WORD,
  pullReason,
  REASON,
  repoConfigReason,
  type WriteLimits,
  canPush,
  changedCount,
  checksSummary,
  deliveryStep,
  failureCopy,
  groupRows,
  GROUP_TITLE,
  hookExcerpt,
  hooksDetail,
  hooksUnlisted,
  operationNote,
  primaryAction,
  nothingToMerge,
  prAvailable,
  PULL_COMMAND,
  pushLabel,
  RUNNING_WORD,
  runningLabel,
  shortSha,
  stageAllPaths,
  type DeliveryStep,
  type FileGroup,
} from './model.ts'
import { Line, Output } from './parts.tsx'
import { PullRequestSection, prInput, type PrForm } from './PullRequestSection.tsx'
import { usePullRequest } from './usePullRequest.ts'
import { useDelivery, type DeliveryFailure, type UnknownWrite } from './useDelivery.ts'
import { needsRecheck, usePersonEditAt } from '../../preview/personEdits.ts'
import { defineCopy, formatNumber, plural } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    exitCode: (code: number) => `退出码 ${formatNumber(code)}`,
    unknownCommit: '提交结果未知',
    unknownPush: '推送结果未知',
    unknownDetail: (kind: 'commit' | 'push') => {
      const action = kind === 'commit' ? '提交' : '推送'
      const fresh =
        kind === 'commit' ? '新的提交只提交那时暂存的文件，第一次已经提交的不会再提交一次。' : '新的推送照常推送当前分支，从不强制。'
      return `没有收到答复，这台电脑可能已经${action}。重试沿用同一请求，电脑会先核对结果，不会${action}两次。放弃这次结果只在这个页面上放下它，之后可以发起新的请求；电脑上的记录仍是结果未知。${fresh}`
    },
    committed: '已提交 ',
    pushedTo: '已推送到 ',
    pulled: (count: number) => `已拉取 ${formatNumber(count)} 个提交 · `,
    fileCount: (count: number) => `${formatNumber(count)} 个文件`,
    more: (count: number) => `还有 ${formatNumber(count)} 个`,
    notStaged: (count: number) => `${formatNumber(count)} 个文件未暂存`,
    staged: (count: number) => `${formatNumber(count)} 个文件已暂存`,
    aheadBehind: (ahead: number, behind: number) => `领先 ${formatNumber(ahead)} · 落后 ${formatNumber(behind)}`,
    stage: '暂存',
    commit: '提交',
    push: '推送',
    steps: '交付步骤',
    pushHook: '推送前的钩子没通过',
    commitHook: '提交钩子没通过',
    exit: (code: number) => ` · 退出码 ${formatNumber(code)}`,
    hookOutput: '钩子输出',
    notPushed: '没有推送',
    notCommitted: '没有生成提交，暂存保持不变',
    chat: '加入对话',
    remoteRejected: '远端钩子拒绝了推送',
    remoteOutput: '远端输出',
    commitFailed: '提交失败',
    gitOutput: 'Git 输出',
    labelExit: (value1: string, code: number) => `${value1} · 退出码 ${formatNumber(code)}`,
    copyPull: '复制拉取命令',
    checking: '核对中…',
    retrySame: '重试同一请求',
    abandon: '放弃这次结果',
    creatingPR: '创建 PR 中…',
    titleFirst: '先写标题',
    createPR: '创建 PR',
    recheck: '需要复验',
    recheckInfo: '之后你编辑过文件，这次的结果不包括那些修改。',
    offline: (value1: string | number) => `${value1} 不在线 · 恢复后再交付`,
    readOnly: '这个会话只读',
    agentBusy: 'Agent 正在改这个文件夹',
    fetched: '已获取',
    upToDate: '已是最新',
    aborted: '已中止',
    upstreamSet: ' · 已设为上游',
    commitMessage: '提交信息',
    skipOnce: '这次不运行提交钩子',
    runHooks: '运行仓库钩子',
    skipHooks: '跳过钩子',
    noFiles: '这台设备看不到会话文件夹里的文件',
    pushing: '推送中…',
    committing: '提交中…',
    messageFirst: '先写提交信息',
    commitStaged: '提交已暂存的',
    readFailed: '读不到仓库',
    retry: '重试',
    reading: '正在读取…',
    checkFailed: '检查失败',
    checkingStatus: '检查进行中',
    checkPassed: '检查通过',
    noChanges: '没有未提交的改动',
    unstageAll: '全部取消暂存',
    stageGroup: (value1: string | number) => `暂存全部${value1}`,
    noneStaged: '还没有暂存的文件',
    unstage: '取消暂存',
    stageAll: '全部暂存',
    lastFetch: (value1: string | number) => `最近获取 ${value1}`,
    neverFetched: '还没有获取过，落后数未知',
    upstreamDetail: (value1: string | number, value2: string | number) => `${value1} 上游：${value2}`,
    upstreamOtherBranch: '上游是另一个分支',
    abortTitle: (value1: string | number) => `中止${value1}？`,
    abortRebase: '回到这次变基开始之前。已解决的冲突、停下的这一步里还没提交的修改和变基带来的改动都会丢失，不能撤销。',
    abortInfo: (value1: string | number) => `回到这次${value1}开始之前。已解决的冲突和它带来的改动都会丢失，不能撤销。`,
    abortConfirm: (value1: string | number) => `中止${value1}`,
    staging: '暂存中…',
    onlyStaged: '只提交已暂存的',
    unstagedWarning: (count: number) => `未暂存的 ${formatNumber(count)} 个文件不提交。`,
    aheadUpstream: (value1: string, count: number) => `领先 ${value1} ${formatNumber(count)} 个提交`,
    notRemote: '这个分支还不在远端',
    setsUpstream: (value1: string) => `推送后以 ${value1} 为上游`,
    notPushedYet: '已提交，未推送',
    sync: '同步',
    fetching: '获取中…',
    fetch: '获取',
    pulling: '拉取中…',
    fastForward: '只快进；分叉时不合并也不变基',
    pullCount: (count: number) => `拉取 ${formatNumber(count)} 个提交`,
    pull: '拉取',
    operationConflicts: (value1: string | number) => `${value1}有冲突`,
    operationRunning: (value1: string | number) => `${value1}进行中`,
    resolveAgent: '交给 Agent 解决',
    aborting: '中止中…',
    abort: '中止',
    diverged: '与上游已分叉',
    handOff: '交给 Agent',
    leave: '保持原样',
  },
  {
    exitCode: (code: number) => `Exit code ${formatNumber(code)}`,
    unknownCommit: 'Commit outcome unknown',
    unknownPush: 'Push outcome unknown',
    unknownDetail: (kind: 'commit' | 'push') => {
      const action = kind === 'commit' ? 'commit' : 'push'
      const fresh =
        kind === 'commit'
          ? 'A new commit includes the files staged then. Files already committed won’t be committed a second time.'
          : 'A new push sends the current branch, without forcing.'
      return `No reply arrived. The computer may already have completed the ${action}. Retrying reuses the request and checks the outcome first. Stopping the wait dismisses the outcome on this page. The computer still records the outcome as unknown. ${fresh}`
    },
    committed: 'Committed ',
    pushedTo: 'Pushed to ',
    pulled: (count: number) => plural(count, { one: 'Pulled {n} commit · ', other: 'Pulled {n} commits · ' }),
    fileCount: (count: number) => plural(count, { one: '{n} file', other: '{n} files' }),
    more: (count: number) => `${formatNumber(count)} more`,
    notStaged: (count: number) => plural(count, { one: '{n} file unstaged', other: '{n} files unstaged' }),
    staged: (count: number) => plural(count, { one: '{n} file staged', other: '{n} files staged' }),
    aheadBehind: (ahead: number, behind: number) => `Ahead ${formatNumber(ahead)} · Behind ${formatNumber(behind)}`,
    stage: 'Stage',
    commit: 'Commit',
    push: 'Push',
    steps: 'Delivery steps',
    pushHook: 'Pre-push hook failed',
    commitHook: 'Commit hook failed',
    exit: (code: number) => ` · Exit code ${formatNumber(code)}`,
    hookOutput: 'Hook output',
    notPushed: 'Nothing was pushed',
    notCommitted: 'No commit was created. Staging is unchanged.',
    chat: 'Add to chat',
    remoteRejected: 'Remote hook rejected the push',
    remoteOutput: 'Remote output',
    commitFailed: 'Commit failed',
    gitOutput: 'Git output',
    labelExit: (value1: string, code: number) => `${value1} · Exit code ${formatNumber(code)}`,
    copyPull: 'Copy pull command',
    checking: 'Checking…',
    retrySame: 'Retry same request',
    abandon: 'Stop waiting for this outcome',
    creatingPR: 'Creating PR…',
    titleFirst: 'Enter a title first',
    createPR: 'Create PR',
    recheck: 'Needs recheck',
    recheckInfo: 'You edited files afterward. This result doesn’t include those changes.',
    offline: (value1: string | number) => `${value1} is offline · Resume delivery after reconnecting`,
    readOnly: 'This session is read only',
    agentBusy: 'Agent is changing this folder',
    fetched: 'Fetched',
    upToDate: 'Up to date',
    aborted: 'Aborted',
    upstreamSet: ' · Set as upstream',
    commitMessage: 'Commit message',
    skipOnce: 'Skip commit hooks this time',
    runHooks: 'Run repository hooks',
    skipHooks: 'Skip hooks',
    noFiles: 'This device can’t see the session’s files',
    pushing: 'Pushing…',
    committing: 'Committing…',
    messageFirst: 'Enter a commit message first',
    commitStaged: 'Commit staged changes',
    readFailed: 'Couldn’t read repository',
    retry: 'Retry',
    reading: 'Reading…',
    checkFailed: 'Checks failed',
    checkingStatus: 'Checks in progress',
    checkPassed: 'Checks passed',
    noChanges: 'No uncommitted changes',
    unstageAll: 'Unstage all',
    stageGroup: (value1: string | number) => `Stage all ${value1}`,
    noneStaged: 'No files staged yet',
    unstage: 'Unstage',
    stageAll: 'Stage all',
    lastFetch: (value1: string | number) => `Last fetched ${value1}`,
    neverFetched: 'No fetch yet · Behind count unknown',
    upstreamDetail: (value1: string | number, value2: string | number) => `${value1} Upstream: ${value2}`,
    upstreamOtherBranch: 'Upstream is a different branch',
    abortTitle: (value1: string | number) => `Abort ${value1}?`,
    abortRebase:
      'Return to the state before this rebase. Resolved conflicts, uncommitted edits in the current step, and changes from the rebase will be lost permanently.',
    abortInfo: (value1: string | number) =>
      `Return to the state before this ${value1}. Resolved conflicts and changes from the operation will be lost permanently.`,
    abortConfirm: (value1: string | number) => `Abort ${value1}`,
    staging: 'Staging…',
    onlyStaged: 'Commit staged files only',
    unstagedWarning: (count: number) => `The ${formatNumber(count)} unstaged files will stay out of the commit.`,
    aheadUpstream: (value1: string, count: number) => `${plural(count, { one: '{n} commit', other: '{n} commits' })} ahead of ${value1}`,
    notRemote: 'This branch isn’t on the remote yet',
    setsUpstream: (value1: string) => `Push sets ${value1} as upstream`,
    notPushedYet: 'Committed · Not pushed',
    sync: 'Sync',
    fetching: 'Fetching…',
    fetch: 'Fetch',
    pulling: 'Pulling…',
    fastForward: 'Fast-forward only · Diverged branches aren’t merged or rebased',
    pullCount: (count: number) => `Pull ${plural(count, { one: '{n} commit', other: '{n} commits' })}`,
    pull: 'Pull',
    operationConflicts: (value1: string | number) => `${value1} has conflicts`,
    operationRunning: (value1: string | number) => `${value1} in progress`,
    resolveAgent: 'Ask agent to resolve',
    aborting: 'Aborting…',
    abort: 'Abort',
    diverged: 'Diverged from upstream',
    handOff: 'Ask agent',
    leave: 'Keep as is',
  },
)

const ACTIVE = new Set(['running', 'waiting-approval'])
const GROUPS: readonly FileGroup[] = ['staged', 'unstaged', 'untracked', 'conflicted']

export interface DeliveryPanelProps {
  summary: TaskSummary
  /** The Host's revision of the session (`TaskDetail.sync.revision`). */
  revision?: number | undefined
  /** The tab is on screen: it reads only then. */
  open: boolean
  focusPr?: boolean
  canReadFiles: boolean
  canRun: boolean
  hostName?: string
  offline: boolean
  phone: boolean
  /** Opens the file's diff (or the file) in the panel. */
  onOpenFile: (path: string) => void
  /** Puts text into the session's composer draft without sending it. */
  onCompose?: ((text: string) => void) | undefined
  /** A commit or push the Host answered as done, for a page that leads somewhere after it. */
  onOutcome?: ((kind: 'committed' | 'pushed') => void) | undefined
  /** The Host fetches, pulls (fast-forward only) and aborts an operation under way (`features.gitSync`). */
  sync?: boolean
}

const STEP_ORDER = ['stage', 'commit', 'push', 'pr'] as const
const STEP_WORD = {
  get stage() {
    return COPY.stage
  },
  get commit() {
    return COPY.commit
  },
  get push() {
    return COPY.push
  },
  pr: 'PR',
} as const

/** 暂存 › 提交 › 推送 › PR: the steps before the current one are done. */
function Steps({ step }: { step: DeliveryStep }) {
  const at = step === 'done' ? STEP_ORDER.length : STEP_ORDER.indexOf(step)
  return (
    <ol className="delivery-steps" aria-label={COPY.steps}>
      {STEP_ORDER.map((name, index) => (
        <li
          key={name}
          data-state={index < at ? 'done' : index === at ? 'current' : undefined}
          aria-current={index === at ? 'step' : undefined}>
          {index > 0 && <ChevronRightGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />}
          {index < at && <CheckGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />}
          <span>{STEP_WORD[name]}</span>
        </li>
      ))}
    </ol>
  )
}

/** A hook that refused: its name, exit code and the end of its output, which can go into the draft. */
function HookCard({ failure, onCompose }: { failure: DeliveryFailure; onCompose?: ((text: string) => void) | undefined }) {
  const push = failure.kind === 'push'
  const title = push ? COPY.pushHook : COPY.commitHook
  return (
    <section className="delivery-card" data-tone="red" aria-label={title}>
      <header className="delivery-card-head">
        <AlertGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        <strong>{title}</strong>
        <span className="delivery-card-meta">
          {failure.hook ?? (push ? 'pre-push' : 'pre-commit')}
          {failure.exitCode !== undefined && COPY.exit(failure.exitCode)}
        </span>
      </header>
      {failure.tail ? <Output text={failure.tail} label={COPY.hookOutput} /> : null}
      <div className="delivery-card-foot">
        <span className="delivery-card-note">{push ? COPY.notPushed : COPY.notCommitted}</span>
        {onCompose && (
          <Button
            size="xs"
            variant="outline"
            icon={MessageSquarePlus}
            onClick={() => {
              onCompose(hookExcerpt({ ...failure, push }))
            }}>
            {COPY.chat}
          </Button>
        )}
      </div>
    </section>
  )
}

function FailureLine({ failure, state }: { failure: DeliveryFailure; state?: GitDeliveryState | undefined }) {
  const copy = failureCopy(failure.code, state?.gitOperation)
  if (failure.code === 'git-push-remote-rejected')
    return (
      <section className="delivery-card" data-tone="red" aria-label={COPY.remoteRejected}>
        <header className="delivery-card-head">
          <AlertGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          <strong>{COPY.remoteRejected}</strong>
        </header>
        {failure.remoteLines?.length ? <Output text={failure.remoteLines.join('\n')} label={COPY.remoteOutput} /> : null}
      </section>
    )
  if (failure.code === 'git-commit-failed' && failure.tail)
    return (
      <section className="delivery-card" data-tone="red" aria-label={COPY.commitFailed}>
        <header className="delivery-card-head">
          <AlertGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          <strong>{COPY.commitFailed}</strong>
          {failure.exitCode !== undefined && <span className="delivery-card-meta">{COPY.exitCode(failure.exitCode)}</span>}
        </header>
        <Output text={failure.tail} label={COPY.gitOutput} />
        <div className="delivery-card-foot">
          <span className="delivery-card-note">{COPY.notCommitted}</span>
        </div>
      </section>
    )
  if (!copy)
    return (
      <Line tone="red" icon={AlertGlyph}>
        {failure.text}
      </Line>
    )
  const label =
    failure.code === 'git-push-failed' && failure.exitCode !== undefined
      ? COPY.labelExit(copy.label, failure.exitCode)
      : failure.code === 'git-repo-config' && failure.repoKind
        ? repoConfigReason(failure.repoKind)
        : copy.label
  return (
    <Line
      tone={copy.tone === 'failed' ? 'red' : copy.tone === 'warn' ? 'amber' : 'muted'}
      icon={copy.tone === 'failed' ? AlertGlyph : copy.tone === 'warn' ? WarningGlyph : InfoGlyph}
      detail={copy.detail}
      {...(failure.code === 'git-push-non-fast-forward'
        ? {
            // The next step, as a command to copy or type into this session's terminal; Latch itself never fetches.
            action: (
              <span className="delivery-command">
                <code>{PULL_COMMAND}</code>
                <CopyButton text={PULL_COMMAND} label={COPY.copyPull} size="xs" />
                <TerminalFillButton command={PULL_COMMAND} />
              </span>
            ),
          }
        : {})}>
      {label}
    </Line>
  )
}

function UnknownLine({
  unknown,
  busy,
  disabled,
  onRetry,
  onAbandon,
}: {
  unknown: UnknownWrite
  busy: boolean
  disabled: boolean
  onRetry: () => void
  onAbandon: () => void
}) {
  return (
    <Line
      locked
      tone="muted"
      icon={CircleHelp}
      detail={COPY.unknownDetail(unknown.kind)}
      action={
        <>
          <Button size="xs" variant="outline" loading={busy} loadingLabel={COPY.checking} disabled={disabled} onClick={onRetry}>
            {COPY.retrySame}
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={onAbandon}>
            {COPY.abandon}
          </Button>
        </>
      }>
      {unknown.kind === 'commit' ? COPY.unknownCommit : COPY.unknownPush}
    </Line>
  )
}

/** The right panel's 交付 tab: stage, commit and push the session's repository. */
export function DeliveryPanel(props: DeliveryPanelProps) {
  const { summary, revision, open, canRun, hostName, offline, phone, onOpenFile, onCompose, onOutcome, sync = false } = props
  const delivery = useDelivery({ sessionId: summary.id, status: summary.status, revision, open, offline })
  const { pending, writing, failure, unknown, outcome, writes } = delivery
  const read = props.canReadFiles ? delivery.read : ({ kind: 'denied' } as const)
  useEffect(() => {
    if (outcome?.kind === 'committed' || outcome?.kind === 'pushed') onOutcome?.(outcome.kind)
  }, [outcome, onOutcome])
  const [aborting, setAborting] = useState(false)
  /** 保持原样 on the diverged card: hidden until the counts change. */
  const [leftAt, setLeftAt] = useState<string>()
  const [message, setMessage] = useState('')
  const [skipHooks, setSkipHooks] = useState(false)
  const [showOutput, setShowOutput] = useState(false)
  const [prForm, setPrForm] = useState<PrForm>({ title: '', body: '', base: '', draft: false })
  const turnRunning = ACTIVE.has(summary.status)
  const readOnly = summary.personal !== undefined
  const canWrite = canRun && !readOnly
  const state = read.kind === 'ready' ? read.state : undefined
  const hostRunning = state?.running
  const busy = !!hostRunning || writing !== undefined || pending.size > 0
  const blocked = offline || !canWrite || !!state?.gitOperation
  const fileWrites = !blocked && !turnRunning && !hostRunning
  const frozen = writing === 'commit' || unknown?.kind === 'commit'
  const limits: WriteLimits = { offline, canWrite: canRun, readOnly, busy, turnRunning }
  const divergedKey = state ? `${state.ahead}:${state.behind}:${state.fetchedAt ?? ''}` : ''
  const divergedShown =
    !!state && !!state.branch && !!state.upstream && (failure?.code === 'git-pull-diverged' || diverged(state)) && leftAt !== divergedKey
  // A device that cannot list the files still sees and makes the pull request: the Host says what it may read.
  const prEnabled = read.kind === 'denied' || (!!state && prAvailable(state))
  const prSectionRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!props.focusPr || !open || !prEnabled) return
    const frame = requestAnimationFrame(() => {
      const section = prSectionRef.current
      const body = section?.closest<HTMLElement>('.delivery-body')
      if (section && body) body.scrollTop += section.getBoundingClientRect().top - body.getBoundingClientRect().top
    })
    return () => cancelAnimationFrame(frame)
  }, [props.focusPr, open, prEnabled])
  const pull = usePullRequest({
    sessionId: summary.id,
    enabled: prEnabled,
    open,
    offline,
    canReadFiles: props.canReadFiles,
    pushed: outcome?.kind === 'pushed' ? outcome.result.sha : undefined,
  })
  const prState = pull.read.kind === 'ready' ? pull.read.state : undefined
  const prUnbound = !!prState && !prState.pr
  const prBlocked = offline || !canWrite || busy || pull.creating || !!pull.unknown
  const createPr = async () => {
    const end = await pull.create(prInput(prForm, prState))
    if (end === 'done') setPrForm({ title: '', body: '', base: '', draft: false })
  }
  const prReady = !!prState && !!prInput(prForm, prState).title && !!prInput(prForm, prState).base
  const prSection = prEnabled ? (
    <PullRequestSection
      sessionId={summary.id}
      sectionRef={prSectionRef}
      read={pull.read}
      head={state?.head}
      branch={state?.branch}
      form={prForm}
      onForm={setPrForm}
      canWrite={canWrite}
      canReadFiles={props.canReadFiles}
      nothingAhead={!!state && nothingToMerge(state)}
      disabled={prBlocked}
      creating={pull.creating}
      failure={pull.failure}
      unknown={pull.unknown}
      retryDisabled={offline || !canWrite || busy || pull.creating}
      logs={props.canReadFiles ? pull.logs : {}}
      onReload={() => void pull.reload()}
      onRetry={() => void pull.retry()}
      onAbandon={pull.abandon}
      onReadLog={job => void pull.readLog(job)}
      onCloseLog={pull.closeLog}
      onCompose={onCompose}
    />
  ) : null
  /** A phone's foot is its page's bottom bar: buttons a thumb can hit. */
  const footSize = phone ? ({ size: 'lg' } as const) : {}
  const prButton = (
    <Button
      variant="primary"
      {...footSize}
      icon={GitPullRequest}
      loading={pull.creating}
      loadingLabel={COPY.creatingPR}
      disabled={prBlocked || !prReady}
      tooltip={!prReady ? COPY.titleFirst : undefined}
      onClick={() => void createPr()}>
      {COPY.createPR}
    </Button>
  )
  // A file saved from the preview after the commit: what its hooks checked is not what is there now.
  const recheck = needsRecheck(outcome?.at, usePersonEditAt(summary.id))
  const recheckMark = recheck ? <Hint label={<StatusWord tone="warn">{COPY.recheck}</StatusWord>}>{COPY.recheckInfo}</Hint> : null

  const commit = async () => {
    const end = await writes.commit(message.trim(), skipHooks)
    if (end === 'done') {
      setMessage('')
      setShowOutput(false)
    }
    // The switch is for one commit: it goes off after each one that was answered, never kept. An unknown one keeps it for
    // the retry, which sends the same request; one refused during an update was not answered at all.
    if (end === 'done' || end === 'failed') setSkipHooks(false)
  }
  // A commit whose answer never came keeps its switch until the retry, which must send the same request.
  const retry = async () => {
    const wasCommit = unknown?.kind === 'commit'
    const end = await writes.retry()
    if (wasCommit && (end === 'done' || end === 'failed')) setSkipHooks(false)
  }

  const computer = computerName(hostName)
  const runningWord = hostRunning ? runningLabel(hostRunning) : writing ? RUNNING_WORD[writing] : undefined

  const notes = (
    <>
      {offline && (
        <Line tone="amber" icon={WarningGlyph}>
          {COPY.offline(computer)}
        </Line>
      )}
      {readOnly && (
        <Line tone="muted" icon={InfoGlyph}>
          {COPY.readOnly}
        </Line>
      )}
      {state?.gitOperation && !(sync && abortable(state)) && (
        <Line tone="amber" icon={WarningGlyph}>
          {operationNote(state.gitOperation)}
        </Line>
      )}
      {sync && state && abortable(state) && (
        <OperationCard
          state={state}
          reason={abortReason(state, limits)}
          aborting={writing === 'abort'}
          onCompose={onCompose}
          onAbort={() => setAborting(true)}
        />
      )}
      {sync && state && divergedShown && (
        <DivergedCard
          state={state}
          ahead={failure?.code === 'git-pull-diverged' ? (failure.ahead ?? state.ahead) : state.ahead}
          behind={failure?.code === 'git-pull-diverged' ? (failure.behind ?? state.behind) : state.behind}
          onCompose={onCompose}
          onLeave={() => {
            setLeftAt(divergedKey)
            if (failure?.code === 'git-pull-diverged') delivery.dismiss()
          }}
        />
      )}
      {turnRunning && !state?.gitOperation && canWrite && (
        <Line tone="muted" icon={InfoGlyph} hover detail={failureCopy('git-turn-running')?.detail}>
          {COPY.agentBusy}
        </Line>
      )}
      {unknown && (
        <UnknownLine
          unknown={unknown}
          busy={writing === unknown.kind}
          disabled={offline || (busy && writing !== unknown.kind)}
          onRetry={() => void retry()}
          onAbandon={() => {
            if (unknown.kind === 'commit') setSkipHooks(false)
            writes.abandon()
          }}
        />
      )}
      {failure?.code === 'git-hook-failed' ? (
        <HookCard failure={failure} onCompose={onCompose} />
      ) : failure && failure.code !== 'git-pull-diverged' && !(failure.code === 'git-turn-running' && turnRunning) ? (
        <FailureLine failure={failure} state={state} />
      ) : null}
      {outcome?.kind === 'committed' && (
        <Line
          icon={CheckGlyph}
          action={
            outcome.result.hookOutput ? (
              <Button size="xs" variant="ghost" aria-expanded={showOutput} onClick={() => setShowOutput(value => !value)}>
                {COPY.hookOutput}
              </Button>
            ) : undefined
          }>
          {COPY.committed}
          <code className="delivery-sha">{shortSha(outcome.result.commit)}</code>
          {recheckMark}
        </Line>
      )}
      {outcome?.kind === 'committed' && showOutput && outcome.result.hookOutput && (
        <Output text={outcome.result.hookOutput} label={COPY.hookOutput} />
      )}
      {outcome?.kind === 'fetched' && (
        <Line icon={CheckGlyph}>
          {COPY.fetched}{' '}
          <code className="delivery-sha">
            <VisibleText text={outcome.result.remote} />
          </code>
        </Line>
      )}
      {outcome?.kind === 'pulled' && (
        <Line icon={CheckGlyph}>
          {outcome.result.updated ? (
            <>
              {COPY.pulled(outcome.result.commits)}
              <code className="delivery-sha">{shortSha(outcome.result.head)}</code>
            </>
          ) : (
            COPY.upToDate
          )}
        </Line>
      )}
      {outcome?.kind === 'aborted' && (
        <Line icon={CheckGlyph}>
          {COPY.aborted}
          {OPERATION_WORD[outcome.result.operation]}
        </Line>
      )}
      {outcome?.kind === 'pushed' && (
        <Line icon={CheckGlyph}>
          {COPY.pushedTo}
          <code className="delivery-sha">
            <VisibleText text={`${outcome.result.remote}/${outcome.result.ref.replace(/^refs\/heads\//u, '')}`} />
          </code>{' '}
          · <code className="delivery-sha">{shortSha(outcome.result.sha)}</code>
          {outcome.result.setUpstream ? COPY.upstreamSet : ''}
          {recheckMark}
        </Line>
      )}
    </>
  )

  const messageBox = (
    <section className="delivery-section" aria-label={COPY.commit}>
      <TextAreaField
        label={COPY.commitMessage}
        className="delivery-message"
        rows={phone ? 3 : 2}
        value={message}
        readOnly={frozen}
        disabled={!canWrite}
        spellCheck={false}
        onChange={event => {
          setMessage(event.target.value)
        }}
      />
      <div className="delivery-hooks">
        <Hint lead={<Webhook size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />} label={skipHooks ? COPY.skipOnce : COPY.runHooks}>
          {state ? hooksDetail(state) : hooksUnlisted()}
        </Hint>
        <span className="delivery-space" />
        <label className="delivery-switch">
          <span>{COPY.skipHooks}</span>
          <Switch label={COPY.skipHooks} checked={skipHooks} disabled={frozen || !canWrite} onCheckedChange={setSkipHooks} />
        </label>
      </div>
    </section>
  )

  if (read.kind === 'denied')
    return (
      <div className="delivery-panel" data-phone={phone ? '' : undefined}>
        <div className="delivery-body">
          <div className="changes-empty delivery-locked">
            <div>
              <p className="changes-empty-title">{COPY.noFiles}</p>
              <p className="changes-empty-detail">{SETUP_COPY.filesNeedScope(computer)}</p>
            </div>
          </div>
          {notes}
          {canWrite && messageBox}
          {prSection}
        </div>
        {canWrite && (
          <div className="delivery-foot">
            <Button
              variant="outline"
              {...footSize}
              loading={writing === 'push'}
              loadingLabel={COPY.pushing}
              disabled={offline || busy || unknown?.kind === 'push'}
              onClick={() => void writes.push()}>
              {COPY.push}
            </Button>
            <span className="delivery-space" />
            {prUnbound && !message.trim() ? (
              prButton
            ) : (
              <Button
                variant="primary"
                {...footSize}
                loading={writing === 'commit'}
                loadingLabel={COPY.committing}
                disabled={offline || busy || !message.trim() || unknown?.kind === 'commit'}
                tooltip={!message.trim() ? COPY.messageFirst : undefined}
                onClick={() => void commit()}>
                {COPY.commitStaged}
              </Button>
            )}
          </div>
        )}
      </div>
    )

  if (!state)
    return (
      <div className="delivery-panel" data-phone={phone ? '' : undefined}>
        <div className="delivery-body">
          {read.kind === 'failed' ? (
            <div className="changes-empty">
              <div>
                <p className="changes-empty-title">{failureCopy(read.code)?.label ?? COPY.readFailed}</p>
                {!failureCopy(read.code) && <p className="changes-empty-detail">{read.text}</p>}
                <Button size="xs" variant="outline" onClick={() => void delivery.reload()}>
                  {COPY.retry}
                </Button>
              </div>
            </div>
          ) : (
            <div className="delivery-loading" aria-busy="true">
              <Spinner size={14} />
              <span>{COPY.reading}</span>
            </div>
          )}
        </div>
      </div>
    )

  const step = deliveryStep(state, { bound: !prUnbound })
  const primary = primaryAction(state, { bound: !prUnbound, justCommitted: phone && outcome?.kind === 'committed' })
  const summaryWord = state?.head && prState?.pr?.headSha === state.head ? checksSummary(prState.checks) : undefined
  const upstreamOther = !!state.upstream && !!state.remote && !!state.branch && state.upstream !== `${state.remote}/${state.branch}`
  const pushable = canPush(state) && !upstreamOther
  const total = state.staged.length + changedCount(state)
  // Known to have diverged: a push would be refused as not a fast-forward, so it waits for the two to be brought together.
  const pushOff = sync && diverged(state) ? REASON.diverged : undefined
  const pushButton = (
    <Button
      size="xs"
      variant="outline"
      icon={Upload}
      loading={writing === 'push'}
      loadingLabel={COPY.pushing}
      disabled={blocked || busy || unknown?.kind === 'push' || pushOff !== undefined}
      tooltip={pushOff}
      onClick={() => void writes.push()}>
      {pushLabel(state)}
    </Button>
  )
  const primaryBlocked =
    blocked
    || busy
    || (primary?.kind === 'push' && pushOff !== undefined)
    || (primary?.kind !== 'push' && turnRunning)
    || (primary?.kind === 'commit' && (!message.trim() || state.conflicted.length > 0))
    || unknown?.kind === primary?.kind
  const runPrimary = () => {
    if (!primary) return
    if (primary.kind === 'stage') writes.stage(primary.paths)
    else if (primary.kind === 'commit') void commit()
    else void writes.push()
  }

  return (
    <div className="delivery-panel" data-phone={phone ? '' : undefined}>
      <div className="delivery-bar">
        <Steps step={step} />
        <span className="delivery-space" />
        {runningWord ? (
          <StatusWord tone="running">{runningWord}</StatusWord>
        ) : summaryWord === 'fail' ? (
          <StatusWord tone="failed">{COPY.checkFailed}</StatusWord>
        ) : summaryWord === 'pending' ? (
          <StatusWord tone="running">{COPY.checkingStatus}</StatusWord>
        ) : summaryWord === 'pass' ? (
          <StatusWord tone="done">{COPY.checkPassed}</StatusWord>
        ) : null}
      </div>
      <div className="delivery-body">
        {notes}
        {total === 0 ? (
          <Line tone="muted" icon={CheckGlyph}>
            {COPY.noChanges}
          </Line>
        ) : (
          <div className="delivery-groups">
            {GROUPS.map(group => {
              const rows = groupRows(state, group)
              if (rows.length === 0 && group !== 'staged') return null
              const all = rows.map(row => row.path)
              const headerStaged = group === 'staged'
              return (
                <div key={group} className="delivery-group" role="group" aria-label={GROUP_TITLE[group]}>
                  <div className="delivery-group-head">
                    <input
                      type="checkbox"
                      className="ui-checkbox"
                      checked={headerStaged && rows.length > 0}
                      aria-label={headerStaged ? COPY.unstageAll : COPY.stageGroup(GROUP_TITLE[group])}
                      aria-disabled={!fileWrites || rows.length === 0 || undefined}
                      onChange={() => {
                        if (!fileWrites || rows.length === 0) return
                        if (headerStaged) writes.unstage(all)
                        else writes.stage(all)
                      }}
                    />
                    <span className="delivery-group-title">{GROUP_TITLE[group]}</span>
                    <span className="delivery-space" />
                    <span className="delivery-count">{rows.length}</span>
                  </div>
                  {rows.length === 0 && <p className="delivery-group-empty">{COPY.noneStaged}</p>}
                  {rows.map(row => {
                    const wanted = pending.get(row.path)
                    const checked = wanted ? wanted === 'stage' : row.staged
                    return (
                      <div key={`${group}\n${row.path}`} className="delivery-file" data-pending={wanted ? '' : undefined}>
                        <input
                          type="checkbox"
                          className="ui-checkbox"
                          checked={checked}
                          aria-label={`${row.staged ? COPY.unstage : COPY.stage} ${escapeHiddenCharacters(row.path)}`}
                          aria-disabled={!fileWrites || wanted !== undefined || undefined}
                          onChange={() => {
                            if (!fileWrites || wanted) return
                            if (row.staged) writes.unstage([row.path])
                            else writes.stage([row.path])
                          }}
                        />
                        <button
                          type="button"
                          className="delivery-file-name"
                          title={escapeHiddenCharacters(row.path)}
                          onClick={() => {
                            onOpenFile(row.path)
                          }}>
                          <bdi>
                            <VisibleText text={row.path} />
                          </bdi>
                        </button>
                        <span className="delivery-file-word">{wanted ? <Spinner size={12} /> : row.word}</span>
                      </div>
                    )
                  })}
                </div>
              )
            })}
            {state.more ? <p className="delivery-more">{COPY.more(state.more)}</p> : null}
            {primary?.kind !== 'stage' && changedCount(state) > 0 && (
              <div className="delivery-stage-all">
                <Button size="xs" variant="ghost" disabled={!fileWrites || busy} onClick={() => writes.stage(stageAllPaths(state))}>
                  {COPY.stageAll}
                </Button>
              </div>
            )}
          </div>
        )}
        {(state.staged.length > 0 || frozen) && messageBox}
        <section className="delivery-section" aria-label={COPY.push}>
          <h3 className="delivery-heading">{COPY.push}</h3>
          {!state.branch ? (
            <FailureCopyLine code="git-detached" />
          ) : !state.head ? (
            <FailureCopyLine code="git-no-commit" />
          ) : !state.remote ? (
            <FailureCopyLine code="git-no-remote" />
          ) : (
            <>
              <div className="delivery-remote">
                <Upload size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
                <code>
                  <VisibleText text={state.remote} />
                </code>
                <ChevronRightGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
                <code className="delivery-branch" title={escapeHiddenCharacters(state.branch)}>
                  <VisibleText text={state.branch} />
                </code>
                <span className="delivery-space" />
                <span
                  className="delivery-count"
                  title={state.upstream ? (state.fetchedAt ? COPY.lastFetch(dateTime(state.fetchedAt)) : COPY.neverFetched) : undefined}>
                  {aheadBehind(state)}
                </span>
              </div>
              {upstreamOther && (
                <Line
                  tone="muted"
                  icon={InfoGlyph}
                  hover
                  detail={COPY.upstreamDetail(failureCopy('git-upstream-other-branch')?.detail ?? '', state.upstream ?? '')}>
                  {COPY.upstreamOtherBranch}
                </Line>
              )}
              {pushable && primary?.kind !== 'push' && !sync && <div className="delivery-stage-all">{pushButton}</div>}
            </>
          )}
        </section>
        {sync && (
          <SyncRow
            push={pushable && primary?.kind !== 'push' ? pushButton : undefined}
            state={state}
            fetchOff={fetchReason(state, limits)}
            pullOff={pullReason(state, limits)}
            writing={writing}
            onFetch={() => void writes.fetch()}
            onPull={() => void writes.pull()}
          />
        )}
        {prSection}
      </div>
      {aborting && abortable(state) && (
        <ConfirmDialog
          title={COPY.abortTitle(OPERATION_WORD[abortable(state)!])}
          message={abortable(state) === 'rebase' ? COPY.abortRebase : COPY.abortInfo(OPERATION_WORD[abortable(state)!])}
          confirmLabel={COPY.abortConfirm(OPERATION_WORD[abortable(state)!])}
          danger
          onConfirm={async () => {
            await writes.abort(abortable(state)!)
          }}
          onClose={() => setAborting(false)}
        />
      )}
      <div className="delivery-foot">
        <FootNote state={state} step={step} />
        <span className="delivery-space" />
        {primary?.kind === 'pr' && canWrite && prButton}
        {primary && primary.kind !== 'pr' && (primary.kind !== 'push' || pushable) && canWrite && (
          <Button
            variant="primary"
            {...footSize}
            icon={primary.kind === 'push' ? Upload : primary.kind === 'commit' ? CommitGlyph : undefined}
            loading={writing === primary.kind || (primary.kind === 'stage' && pending.size > 0)}
            loadingLabel={primary.kind === 'stage' ? COPY.staging : RUNNING_WORD[primary.kind]}
            disabled={primaryBlocked}
            tooltip={primary.kind === 'commit' && !message.trim() ? COPY.messageFirst : primary.kind === 'push' ? pushOff : undefined}
            onClick={runPrimary}>
            {primary.label}
          </Button>
        )}
      </div>
    </div>
  )
}

function FailureCopyLine({ code }: { code: string }) {
  const copy = failureCopy(code)
  if (!copy) return null
  return (
    <Line tone="muted" icon={InfoGlyph} hover detail={copy.detail}>
      {copy.label}
    </Line>
  )
}

function FootNote({ state, step }: { state: GitDeliveryState; step: DeliveryStep }) {
  if (step === 'stage') return <span className="delivery-foot-note">{COPY.notStaged(changedCount(state))}</span>
  if (step === 'commit') {
    const left = changedCount(state)
    return left ? (
      <Hint lead={false} label={COPY.onlyStaged}>
        {COPY.unstagedWarning(left)}
      </Hint>
    ) : (
      <span className="delivery-foot-note">{COPY.staged(state.staged.length)}</span>
    )
  }
  if (step === 'push') {
    // Pushed without `-u`: the remote has the branch, and a push with nothing new there only sets the upstream.
    const note = state.upstream
      ? COPY.aheadUpstream(state.upstream, state.ahead)
      : state.remoteBranch
        ? state.remoteBranch.ahead
          ? COPY.aheadUpstream(state.remoteBranch.name, state.remoteBranch.ahead)
          : COPY.setsUpstream(state.remoteBranch.name)
        : COPY.notRemote
    return <span className="delivery-foot-note">{note}</span>
  }
  if (state.head && !state.remote) return <span className="delivery-foot-note">{COPY.notPushedYet}</span>
  return null
}

/** 获取 and 拉取, each disabled with its reason as the hover. */
function SyncRow({
  push,
  state,
  fetchOff,
  pullOff,
  writing,
  onFetch,
  onPull,
}: {
  push?: ReactNode
  state: GitDeliveryState
  fetchOff: string | undefined
  pullOff: string | undefined
  writing: string | undefined
  onFetch: () => void
  onPull: () => void
}) {
  const behind = !!state.fetchedAt && state.behind > 0 && !diverged(state)
  return (
    <div className="delivery-sync" role="group" aria-label={COPY.sync}>
      {push}
      <Button
        size="xs"
        variant="outline"
        icon={RefreshCw}
        loading={writing === 'fetch'}
        loadingLabel={COPY.fetching}
        disabled={fetchOff !== undefined}
        tooltip={fetchOff}
        onClick={onFetch}>
        {COPY.fetch}
      </Button>
      <Button
        size="xs"
        variant={behind && pullOff === undefined ? 'primary' : 'outline'}
        icon={ArrowDownToLine}
        loading={writing === 'pull'}
        loadingLabel={COPY.pulling}
        disabled={pullOff !== undefined}
        tooltip={pullOff ?? COPY.fastForward}
        onClick={onPull}>
        {behind ? COPY.pullCount(state.behind) : COPY.pull}
      </Button>
    </div>
  )
}

/** A merge, rebase, cherry-pick or revert under way: its conflicted files go to the Agent, or the operation is aborted. */
function OperationCard({
  state,
  reason,
  aborting,
  onCompose,
  onAbort,
}: {
  state: GitDeliveryState
  reason: string | undefined
  aborting: boolean
  onCompose?: ((text: string) => void) | undefined
  onAbort: () => void
}) {
  const operation = abortable(state)!
  const word = OPERATION_WORD[operation]
  const count = state.conflicted.length
  const title = count ? COPY.operationConflicts(word) : COPY.operationRunning(word)
  return (
    <section className="delivery-card" data-tone="amber" aria-label={title}>
      <header className="delivery-card-head">
        <WarningGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        <strong>{title}</strong>
        {count > 0 && <span className="delivery-card-meta">{COPY.fileCount(count)}</span>}
      </header>
      <div className="delivery-card-foot">
        <span className="delivery-space" />
        {onCompose && count > 0 && (
          <Button
            size="xs"
            variant="outline"
            icon={MessageSquarePlus}
            onClick={() => {
              onCompose(conflictPrompt({ operation, paths: state.conflicted, ...(state.more ? { more: state.more } : {}) }))
            }}>
            {COPY.resolveAgent}
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          loading={aborting}
          loadingLabel={COPY.aborting}
          disabled={reason !== undefined}
          tooltip={reason}
          onClick={onAbort}>
          {COPY.abort}
          {word}
        </Button>
      </div>
    </section>
  )
}

/** The branch and its upstream have diverged: nothing is merged or rebased here; the Agent can be asked, or it is left. */
function DivergedCard({
  state,
  ahead,
  behind,
  onCompose,
  onLeave,
}: {
  state: GitDeliveryState
  ahead: number
  behind: number
  onCompose?: ((text: string) => void) | undefined
  onLeave: () => void
}) {
  return (
    <section className="delivery-card" data-tone="amber" aria-label={COPY.diverged}>
      <header className="delivery-card-head">
        <WarningGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        <strong>{COPY.diverged}</strong>
        <span className="delivery-card-meta">{COPY.aheadBehind(ahead, behind)}</span>
      </header>
      <div className="delivery-card-foot">
        <span className="delivery-space" />
        {onCompose && (
          <Button
            size="xs"
            variant="outline"
            icon={MessageSquarePlus}
            onClick={() => {
              onCompose(divergedPrompt({ branch: state.branch ?? '', upstream: state.upstream ?? '', ahead, behind }))
            }}>
            {COPY.handOff}
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={onLeave}>
          {COPY.leave}
        </Button>
      </div>
    </section>
  )
}
