import { useEffect, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  GitCommitHorizontal,
  GitPullRequest,
  Info,
  MessageSquarePlus,
  TriangleAlert,
  Upload,
  Webhook,
} from 'lucide-react'
import type { GitDeliveryState, TaskSummary } from '@latch/protocol'
import { Button, Hint, ICON_STROKE, Spinner, StatusWord, Switch, TextAreaField, type LucideIcon } from '@latch/ui'
import { escapeHiddenCharacters, VisibleText } from '../../components/VisibleText.tsx'
import { computerName, SETUP_COPY } from '../../core/securityCopy.ts'
import {
  canPush,
  changedCount,
  checksSummary,
  deliveryStep,
  failureCopy,
  groupRows,
  GROUP_TITLE,
  hookExcerpt,
  hooksDetail,
  HOOKS_UNLISTED,
  operationNote,
  primaryAction,
  prAvailable,
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

const ACTIVE = new Set(['running', 'waiting-approval'])
const GROUPS: readonly FileGroup[] = ['staged', 'unstaged', 'untracked', 'conflicted']

export interface DeliveryPanelProps {
  summary: TaskSummary
  /** The Host's revision of the session (`TaskDetail.sync.revision`). */
  revision?: number | undefined
  /** The tab is on screen: it reads only then. */
  open: boolean
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
}

const STEP_ORDER = ['stage', 'commit', 'push', 'pr'] as const
const STEP_WORD = { stage: '暂存', commit: '提交', push: '推送', pr: 'PR' } as const

/** 暂存 › 提交 › 推送 › PR: the steps before the current one are done. */
function Steps({ step }: { step: DeliveryStep }) {
  const at = step === 'done' ? STEP_ORDER.length : STEP_ORDER.indexOf(step)
  return (
    <ol className="delivery-steps" aria-label="交付步骤">
      {STEP_ORDER.map((name, index) => (
        <li
          key={name}
          data-state={index < at ? 'done' : index === at ? 'current' : undefined}
          aria-current={index === at ? 'step' : undefined}>
          {index > 0 && <ChevronRight size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />}
          {index < at && <Check size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />}
          <span>{STEP_WORD[name]}</span>
        </li>
      ))}
    </ol>
  )
}

/** A hook that refused: its name, exit code and the end of its output, which can go into the draft. */
function HookCard({ failure, onCompose }: { failure: DeliveryFailure; onCompose?: ((text: string) => void) | undefined }) {
  const push = failure.kind === 'push'
  const title = push ? '推送前的钩子没通过' : '提交钩子没通过'
  return (
    <section className="delivery-card" data-tone="red" aria-label={title}>
      <header className="delivery-card-head">
        <CircleAlert size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        <strong>{title}</strong>
        <span className="delivery-card-meta">
          {failure.hook ?? (push ? 'pre-push' : 'pre-commit')}
          {failure.exitCode !== undefined && ` · 退出码 ${failure.exitCode}`}
        </span>
      </header>
      {failure.tail ? <Output text={failure.tail} label="钩子输出" /> : null}
      <div className="delivery-card-foot">
        <span className="delivery-card-note">{push ? '没有推送' : '没有生成提交，暂存保持不变'}</span>
        {onCompose && (
          <Button
            size="xs"
            variant="outline"
            icon={MessageSquarePlus}
            onClick={() => {
              onCompose(hookExcerpt({ ...failure, push }))
            }}>
            加入对话
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
      <section className="delivery-card" data-tone="red" aria-label="远端钩子拒绝了推送">
        <header className="delivery-card-head">
          <CircleAlert size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          <strong>远端钩子拒绝了推送</strong>
        </header>
        {failure.remoteLines?.length ? <Output text={failure.remoteLines.join('\n')} label="远端输出" /> : null}
      </section>
    )
  if (failure.code === 'git-commit-failed' && failure.tail)
    return (
      <section className="delivery-card" data-tone="red" aria-label="提交失败">
        <header className="delivery-card-head">
          <CircleAlert size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          <strong>提交失败</strong>
          {failure.exitCode !== undefined && <span className="delivery-card-meta">退出码 {failure.exitCode}</span>}
        </header>
        <Output text={failure.tail} label="Git 输出" />
        <div className="delivery-card-foot">
          <span className="delivery-card-note">没有生成提交，暂存保持不变</span>
        </div>
      </section>
    )
  if (!copy)
    return (
      <Line tone="red" icon={CircleAlert}>
        {failure.text}
      </Line>
    )
  const label =
    failure.code === 'git-push-failed' && failure.exitCode !== undefined ? `${copy.label} · 退出码 ${failure.exitCode}` : copy.label
  return (
    <Line
      tone={copy.tone === 'failed' ? 'red' : copy.tone === 'warn' ? 'amber' : 'muted'}
      icon={copy.tone === 'failed' ? CircleAlert : copy.tone === 'warn' ? TriangleAlert : Info}
      detail={copy.detail}>
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
  const what = unknown.kind === 'commit' ? '提交' : '推送'
  const fresh =
    unknown.kind === 'commit' ? '新的提交只提交那时暂存的文件，第一次已经提交的不会再提交一次。' : '新的推送照常推送当前分支，从不强制。'
  return (
    <Line
      tone="muted"
      icon={CircleHelp}
      detail={`没有收到答复，这台电脑可能已经${what}。重试沿用同一请求，电脑会先核对结果，不会${what}两次。放弃这次结果只在这个页面上放下它，之后可以发起新的请求；电脑上的记录仍是结果未知。${fresh}`}
      action={
        <>
          <Button size="xs" variant="outline" loading={busy} loadingLabel="核对中…" disabled={disabled} onClick={onRetry}>
            重试同一请求
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={onAbandon}>
            放弃这次结果
          </Button>
        </>
      }>
      {what}结果未知
    </Line>
  )
}

/** The right panel's 交付 tab: stage, commit and push the session's repository. */
export function DeliveryPanel(props: DeliveryPanelProps) {
  const { summary, revision, open, canRun, hostName, offline, phone, onOpenFile, onCompose, onOutcome } = props
  const delivery = useDelivery({ sessionId: summary.id, status: summary.status, revision, open, offline })
  const { read, pending, writing, failure, unknown, outcome, writes } = delivery
  useEffect(() => {
    if (outcome) onOutcome?.(outcome.kind)
  }, [outcome, onOutcome])
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
  // A device that cannot list the files still sees and makes the pull request: the Host says what it may read.
  const prEnabled = read.kind === 'denied' || (!!state && prAvailable(state))
  const pull = usePullRequest({
    sessionId: summary.id,
    enabled: prEnabled,
    open,
    offline,
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
      read={pull.read}
      head={state?.head}
      branch={state?.branch}
      form={prForm}
      onForm={setPrForm}
      canWrite={canWrite}
      disabled={prBlocked}
      creating={pull.creating}
      failure={pull.failure}
      unknown={pull.unknown}
      retryDisabled={offline || !canWrite || busy || pull.creating}
      logs={pull.logs}
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
      loadingLabel="创建 PR 中…"
      disabled={prBlocked || !prReady}
      tooltip={!prReady ? '先写标题' : undefined}
      onClick={() => void createPr()}>
      创建 PR
    </Button>
  )
  // A file saved from the preview after the commit: what its hooks checked is not what is there now.
  const recheck = needsRecheck(outcome?.at, usePersonEditAt(summary.id))
  const recheckMark = recheck ? (
    <Hint label={<StatusWord tone="warn">需要复验</StatusWord>}>之后你编辑过文件，这次的结果不包括那些修改。</Hint>
  ) : null

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
      {offline && <Line tone="amber" icon={TriangleAlert}>{`${computer} 不在线 · 恢复后再交付`}</Line>}
      {readOnly && (
        <Line tone="muted" icon={Info}>
          这个会话只读
        </Line>
      )}
      {state?.gitOperation && (
        <Line tone="amber" icon={TriangleAlert}>
          {operationNote(state.gitOperation)}
        </Line>
      )}
      {turnRunning && !state?.gitOperation && canWrite && (
        <Line tone="muted" icon={Info} detail={failureCopy('git-turn-running')?.detail}>
          Agent 正在改这个文件夹
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
      ) : failure && !(failure.code === 'git-turn-running' && turnRunning) ? (
        <FailureLine failure={failure} state={state} />
      ) : null}
      {outcome?.kind === 'committed' && (
        <Line
          icon={Check}
          action={
            outcome.result.hookOutput ? (
              <Button size="xs" variant="ghost" aria-expanded={showOutput} onClick={() => setShowOutput(value => !value)}>
                钩子输出
              </Button>
            ) : undefined
          }>
          已提交 <code className="delivery-sha">{shortSha(outcome.result.commit)}</code>
          {recheckMark}
        </Line>
      )}
      {outcome?.kind === 'committed' && showOutput && outcome.result.hookOutput && (
        <Output text={outcome.result.hookOutput} label="钩子输出" />
      )}
      {outcome?.kind === 'pushed' && (
        <Line icon={Check}>
          已推送到{' '}
          <code className="delivery-sha">
            <VisibleText text={`${outcome.result.remote}/${outcome.result.ref.replace(/^refs\/heads\//u, '')}`} />
          </code>{' '}
          · <code className="delivery-sha">{shortSha(outcome.result.sha)}</code>
          {outcome.result.setUpstream ? ' · 已设为上游' : ''}
          {recheckMark}
        </Line>
      )}
    </>
  )

  const messageBox = (
    <section className="delivery-section" aria-label="提交">
      <TextAreaField
        label="提交信息"
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
        <Hint
          lead={<Webhook size={12} strokeWidth={ICON_STROKE[12]} />}
          label={skipHooks ? '这次不运行提交钩子' : '运行仓库钩子'}
          moreLabel="钩子说明">
          {state ? hooksDetail(state) : HOOKS_UNLISTED}
        </Hint>
        <span className="delivery-space" />
        <label className="delivery-switch">
          <span>跳过钩子</span>
          <Switch label="跳过钩子" checked={skipHooks} disabled={frozen || !canWrite} onCheckedChange={setSkipHooks} />
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
              <p className="changes-empty-title">这台设备看不到会话文件夹里的文件</p>
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
              loadingLabel="推送中…"
              disabled={offline || busy || unknown?.kind === 'push'}
              onClick={() => void writes.push()}>
              推送
            </Button>
            <span className="delivery-space" />
            {prUnbound && !message.trim() ? (
              prButton
            ) : (
              <Button
                variant="primary"
                {...footSize}
                loading={writing === 'commit'}
                loadingLabel="提交中…"
                disabled={offline || busy || !message.trim() || unknown?.kind === 'commit'}
                tooltip={!message.trim() ? '先写提交信息' : undefined}
                onClick={() => void commit()}>
                提交已暂存的
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
                <p className="changes-empty-title">{failureCopy(read.code)?.label ?? '读不到仓库'}</p>
                {!failureCopy(read.code) && <p className="changes-empty-detail">{read.text}</p>}
                <Button size="xs" variant="outline" onClick={() => void delivery.reload()}>
                  重试
                </Button>
              </div>
            </div>
          ) : (
            <div className="delivery-loading" aria-busy="true">
              <Spinner size={14} />
              <span>正在读取…</span>
            </div>
          )}
        </div>
      </div>
    )

  const step = deliveryStep(state, { bound: !prUnbound })
  const primary = primaryAction(state, { bound: !prUnbound, justCommitted: phone && outcome?.kind === 'committed' })
  const summaryWord = prState?.pr ? checksSummary(prState.checks) : undefined
  const upstreamOther = !!state.upstream && !!state.remote && !!state.branch && state.upstream !== `${state.remote}/${state.branch}`
  const pushable = canPush(state) && !upstreamOther
  const total = state.staged.length + changedCount(state)
  const primaryBlocked =
    blocked
    || busy
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
          <StatusWord tone="failed">检查失败</StatusWord>
        ) : summaryWord === 'pending' ? (
          <StatusWord tone="running">检查进行中</StatusWord>
        ) : summaryWord === 'pass' ? (
          <StatusWord tone="done">检查通过</StatusWord>
        ) : null}
      </div>
      <div className="delivery-body">
        {notes}
        {total === 0 ? (
          <Line tone="muted" icon={Check}>
            没有未提交的改动
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
                      aria-label={headerStaged ? '全部取消暂存' : `暂存全部${GROUP_TITLE[group]}`}
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
                  {rows.length === 0 && <p className="delivery-group-empty">还没有暂存的文件</p>}
                  {rows.map(row => {
                    const wanted = pending.get(row.path)
                    const checked = wanted ? wanted === 'stage' : row.staged
                    return (
                      <div key={`${group}\n${row.path}`} className="delivery-file" data-pending={wanted ? '' : undefined}>
                        <input
                          type="checkbox"
                          className="ui-checkbox"
                          checked={checked}
                          aria-label={`${row.staged ? '取消暂存' : '暂存'} ${escapeHiddenCharacters(row.path)}`}
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
            {state.more ? <p className="delivery-more">还有 {state.more} 个</p> : null}
            {primary?.kind !== 'stage' && changedCount(state) > 0 && (
              <div className="delivery-stage-all">
                <Button size="xs" variant="ghost" disabled={!fileWrites || busy} onClick={() => writes.stage(stageAllPaths(state))}>
                  全部暂存
                </Button>
              </div>
            )}
          </div>
        )}
        {(state.staged.length > 0 || frozen) && messageBox}
        <section className="delivery-section" aria-label="推送">
          <h3 className="delivery-heading">推送</h3>
          {!state.branch ? (
            <FailureCopyLine code="git-detached" />
          ) : !state.head ? (
            <FailureCopyLine code="git-no-commit" />
          ) : !state.remote ? (
            <FailureCopyLine code="git-no-remote" />
          ) : (
            <>
              <div className="delivery-remote">
                <Upload size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
                <code>
                  <VisibleText text={state.remote} />
                </code>
                <ChevronRight size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
                <code className="delivery-branch" title={escapeHiddenCharacters(state.branch)}>
                  <VisibleText text={state.branch} />
                </code>
                <span className="delivery-space" />
                <span className="delivery-count">
                  {!state.upstream
                    ? '新分支'
                    : state.ahead || state.behind
                      ? [state.ahead ? `领先 ${state.ahead}` : '', state.behind ? `落后 ${state.behind}` : ''].filter(Boolean).join(' · ')
                      : '已是最新'}
                </span>
              </div>
              {upstreamOther && (
                <Line
                  tone="muted"
                  icon={Info}
                  detail={`${failureCopy('git-upstream-other-branch')?.detail ?? ''} 上游：${state.upstream ?? ''}`}>
                  上游是另一个分支
                </Line>
              )}
              {pushable && primary?.kind !== 'push' && (
                <div className="delivery-stage-all">
                  <Button
                    size="xs"
                    variant="outline"
                    icon={Upload}
                    loading={writing === 'push'}
                    loadingLabel="推送中…"
                    disabled={blocked || busy || unknown?.kind === 'push'}
                    onClick={() => void writes.push()}>
                    {pushLabel(state)}
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
        {prSection}
      </div>
      <div className="delivery-foot">
        <FootNote state={state} step={step} />
        <span className="delivery-space" />
        {primary?.kind === 'pr' && canWrite && prButton}
        {primary && primary.kind !== 'pr' && (primary.kind !== 'push' || pushable) && canWrite && (
          <Button
            variant="primary"
            {...footSize}
            icon={primary.kind === 'push' ? Upload : primary.kind === 'commit' ? GitCommitHorizontal : undefined}
            loading={writing === primary.kind || (primary.kind === 'stage' && pending.size > 0)}
            loadingLabel={primary.kind === 'stage' ? '暂存中…' : RUNNING_WORD[primary.kind]}
            disabled={primaryBlocked}
            tooltip={primary.kind === 'commit' && !message.trim() ? '先写提交信息' : undefined}
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
    <Line tone="muted" icon={Info} detail={copy.detail}>
      {copy.label}
    </Line>
  )
}

function FootNote({ state, step }: { state: GitDeliveryState; step: DeliveryStep }) {
  if (step === 'stage') return <span className="delivery-foot-note">{changedCount(state)} 个文件未暂存</span>
  if (step === 'commit') {
    const left = changedCount(state)
    return left ? (
      <Hint lead={false} label="只提交已暂存的">{`未暂存的 ${left} 个文件不提交。`}</Hint>
    ) : (
      <span className="delivery-foot-note">{state.staged.length} 个文件已暂存</span>
    )
  }
  if (step === 'push')
    return (
      <span className="delivery-foot-note">{state.upstream ? `领先 ${state.upstream} ${state.ahead} 个提交` : '这个分支还不在远端'}</span>
    )
  if (state.head && !state.remote) return <span className="delivery-foot-note">已提交，未推送</span>
  return null
}
