import { CircleDashed, CircleHelp, CircleMinus, GitPullRequest, MessageSquarePlus } from 'lucide-react'
import { useMemo, useState, type ReactNode, type Ref } from 'react'
import { PrFollowControl } from './PrFollow.tsx'
import type { GitCheck, GitPrComment, GitPrState, GitPullRequest as PullRequest } from '@latch/protocol'
import {
  Badge,
  Button,
  ButtonLink,
  Checkbox,
  ICON_STROKE,
  IconButton,
  Spinner,
  StatusWord,
  Switch,
  TextAreaField,
  TextField,
  CheckGlyph,
  AlertGlyph,
  ExternalGlyph,
  InfoGlyph,
  RefreshGlyph,
  WarningGlyph,
  CloseGlyph,
} from '@latch/ui'
import { escapeHiddenCharacters, VisibleText } from '../../components/VisibleText.tsx'
import {
  checkDuration,
  checkExcerpt,
  checksStale,
  CHECK_WORD,
  commentExcerpt,
  commentPlace,
  failureCopy,
  PR_STATE_WORD,
  REVIEW_DECISION_WORD,
  shortSha,
} from './model.ts'
import { Line, Output } from './parts.tsx'
import type { LogRead, PrCreateInput, PrFailure, PrRead, PrUnknown } from './usePullRequest.ts'
import { defineCopy, formatNumber, plural } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    noLog: '（日志为空）',
    recent: (count: number) => `· 只显示最新 ${formatNumber(count)} 条`,
    viewLog: '查看日志',
    readingLog: '正在读取日志…',
    logName: (value1: string | number) => `${value1} 的日志`,
    logTail: '日志的最后 200 行',
    chat: '加入对话',
    selectFeedback: (label: string) => `选择 ${label}`,
    clearFeedback: '取消选择',
    addFeedback: (count: number) => `将 ${formatNumber(count)} 项加入草稿`,
    open: '打开',
    refresh: '刷新',
    draft: '草稿',
    reading: '正在读取 PR…',
    retry: '重试',
    unknownInfo:
      '没有收到答复，PR 可能已经建好。重试沿用同一请求，电脑会先按分支查找，不会建两个。放弃这次结果只在这个页面上放下它，电脑上的记录仍是结果未知；之后再创建 PR 时，电脑同样先按分支查找，找到就绑定它。',
    checking: '核对中…',
    retrySame: '重试同一请求',
    abandon: '放弃这次结果',
    unknown: 'PR 结果未知',
    checks: '检查',
    oldCheck: '检查对应的不是这里最新的提交',
    oldCommit: '旧提交',
    noChecks: '没有检查',
    comments: '评论',
    noComments: '没有评论',
    title: '标题',
    base: '合入',
    body: '正文',
    creationFailed: 'PR 没有创建',
    ghOutput: 'gh 输出',
  },
  {
    noLog: '(Log is empty)',
    recent: (count: number) => plural(count, { one: '· Showing only the latest comment', other: '· Showing only the latest {n} comments' }),
    viewLog: 'View log',
    readingLog: 'Reading log…',
    logName: (value1: string | number) => `Log for ${value1}`,
    logTail: 'Last 200 lines of the log',
    chat: 'Add to chat',
    selectFeedback: (label: string) => `Select ${label}`,
    clearFeedback: 'Clear selection',
    addFeedback: (count: number) => plural(count, { one: 'Add 1 item to draft', other: 'Add {n} items to draft' }),
    open: 'Open',
    refresh: 'Refresh',
    draft: 'Draft',
    reading: 'Reading PR…',
    retry: 'Retry',
    unknownInfo:
      'No reply arrived. The PR may already exist. Retrying reuses the request and checks the branch first to avoid creating a duplicate. Stopping the wait dismisses the result on this page. The computer keeps the outcome as unknown. A later request checks the branch again and links an existing PR if it finds one.',
    checking: 'Checking…',
    retrySame: 'Retry same request',
    abandon: 'Stop waiting for this outcome',
    unknown: 'PR outcome unknown',
    checks: 'Checks',
    oldCheck: 'These checks ran against an earlier commit',
    oldCommit: 'Older commit',
    noChecks: 'No checks',
    comments: 'Comments',
    noComments: 'No comments',
    title: 'Title',
    base: 'Base branch',
    body: 'Description',
    creationFailed: 'PR wasn’t created',
    ghOutput: 'gh output',
  },
)

export interface PrForm {
  title: string
  body: string
  base: string
  draft: boolean
}

export interface PullRequestSectionProps {
  sessionId?: string
  sectionRef?: Ref<HTMLElement>
  read: PrRead
  /** The commit the branch is at here: checks of another one are 「旧提交」. */
  head?: string | undefined
  /** The branch the pull request is made from. */
  branch?: string | undefined
  form: PrForm
  onForm: (form: PrForm) => void
  canWrite: boolean
  canReadFiles: boolean
  /** Nothing to merge into the base (`nothingToMerge`): no form to make a pull request. */
  nothingAhead?: boolean
  disabled: boolean
  creating: boolean
  failure?: PrFailure | undefined
  unknown?: PrUnknown | undefined
  logs: Record<string, LogRead>
  onReload: () => void
  onRetry: () => void
  onAbandon: () => void
  /** The unknown row's retry: not held back by that unknown result, as the rest of the section is. */
  retryDisabled: boolean
  onReadLog: (job: string) => void
  onCloseLog: (job: string) => void
  onCompose?: ((text: string) => void) | undefined
}

/** The form's values as 创建 PR sends them. */
export function prInput(form: PrForm, state: GitPrState | undefined): PrCreateInput {
  return {
    title: form.title.trim() || state?.draft?.title || '',
    body: form.body,
    base: form.base.trim() || state?.draft?.base || '',
    draft: form.draft,
  }
}

function CheckStateGlyph({ state }: { state: GitCheck['state'] }) {
  const props = { size: 14, strokeWidth: ICON_STROKE[14], nonScalingStroke: true, 'aria-hidden': true as const }
  if (state === 'pass') return <CheckGlyph {...props} />
  if (state === 'fail') return <CloseGlyph {...props} />
  if (state === 'pending') return <CircleDashed {...props} />
  return <CircleMinus {...props} />
}

function CheckRow({
  check,
  pr,
  pick,
  log,
  onReadLog,
  onCloseLog,
  onCompose,
}: {
  check: GitCheck
  pr: PullRequest
  pick?: ReactNode
  log: LogRead | undefined
  onReadLog: (job: string) => void
  onCloseLog: (job: string) => void
  onCompose?: ((text: string) => void) | undefined
}) {
  const duration = check.state === 'pass' ? checkDuration(check) : undefined
  const job = check.state === 'fail' ? check.job : undefined
  return (
    <>
      <div className="delivery-check" data-state={check.state}>
        {pick}
        <CheckStateGlyph state={check.state} />
        <span className="delivery-check-name" title={check.workflow ? `${check.workflow} · ${check.name}` : check.name}>
          <VisibleText text={check.name} />
        </span>
        <span className="delivery-space" />
        <span className="delivery-check-word">{duration ?? CHECK_WORD[check.state]}</span>
        {job && (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={log !== undefined}
            onClick={() => {
              if (log) onCloseLog(job)
              else onReadLog(job)
            }}>
            {COPY.viewLog}
          </Button>
        )}
      </div>
      {job && log?.kind === 'loading' && (
        <div className="delivery-loading" aria-busy="true">
          <Spinner size={12} />
          <span>{COPY.readingLog}</span>
        </div>
      )}
      {job && log?.kind === 'failed' && (
        <Line tone="red" icon={AlertGlyph}>
          {failureCopy(log.code)?.label ?? log.text}
        </Line>
      )}
      {job && log?.kind === 'ready' && (
        <div className="delivery-log">
          <Output text={log.log.text || COPY.noLog} label={COPY.logName(check.name)} />
          <div className="delivery-card-foot">
            <span className="delivery-card-note">{log.log.truncated ? COPY.logTail : ''}</span>
            {onCompose && (
              <Button
                size="xs"
                variant="outline"
                icon={MessageSquarePlus}
                onClick={() => {
                  onCompose(checkExcerpt({ number: pr.number, check: check.name, sha: pr.headSha, text: log.log.text }))
                }}>
                {COPY.chat}
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function Comment({
  comment,
  pr,
  pick,
  onCompose,
}: {
  comment: GitPrComment
  pr: PullRequest
  pick?: ReactNode
  onCompose?: ((text: string) => void) | undefined
}) {
  const label = escapeHiddenCharacters(`${comment.author} · ${commentPlace(comment)}`)
  return (
    <article className="delivery-comment" aria-label={label}>
      <header className="delivery-comment-head">
        {pick}
        <strong>
          <VisibleText text={comment.author} />
        </strong>
        <span className="delivery-comment-place" data-review={comment.review}>
          <VisibleText text={commentPlace(comment)} />
        </span>
        <span className="delivery-space" />
        {onCompose && (
          <Button
            size="xs"
            variant="ghost"
            icon={MessageSquarePlus}
            onClick={() => {
              onCompose(commentExcerpt({ number: pr.number, comment }))
            }}>
            {COPY.chat}
          </Button>
        )}
      </header>
      {comment.body && (
        <p className="delivery-comment-body">
          <VisibleText text={comment.body} />
        </p>
      )}
    </article>
  )
}

function PrRow({ pr, onReload, loading }: { pr: PullRequest; onReload: () => void; loading: boolean }) {
  const decision = pr.reviewDecision
  return (
    <div className="delivery-pr">
      <div className="delivery-pr-line">
        <GitPullRequest size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        <span className="delivery-pr-title" title={pr.title}>
          <span className="delivery-pr-number">#{pr.number}</span> <VisibleText text={pr.title} />
        </span>
        {pr.url.startsWith('https://') && (
          <ButtonLink size="xs" variant="ghost" icon={ExternalGlyph} href={pr.url} target="_blank" rel="noopener noreferrer">
            {COPY.open}
          </ButtonLink>
        )}
        <IconButton size="xs" label={COPY.refresh} icon={RefreshGlyph} disabled={loading} onClick={onReload} />
      </div>
      <div className="delivery-pr-states">
        <StatusWord tone={pr.state === 'merged' ? 'done' : 'neutral'}>{PR_STATE_WORD[pr.state]}</StatusWord>
        {pr.draft && <Badge>{COPY.draft}</Badge>}
        {decision && (
          <StatusWord tone={decision === 'changes-requested' ? 'warn' : decision === 'approved' ? 'done' : 'neutral'}>
            {REVIEW_DECISION_WORD[decision]}
          </StatusWord>
        )}
        <span className="delivery-pr-branches">
          <VisibleText text={`${pr.base} ← ${pr.head}`} />
        </span>
      </div>
    </div>
  )
}

function feedbackKeys(state: GitPrState) {
  const checks = state.checks.map(check =>
    JSON.stringify(['check', check.name, check.workflow, check.state, check.job, check.startedAt, check.completedAt]),
  )
  const comments = (state.discussion ?? []).map(comment =>
    JSON.stringify(['comment', comment.kind, comment.author, comment.review, comment.path, comment.line, comment.body, comment.at]),
  )
  const identities = [...checks, ...comments]
  const counts = new Map<string, number>()
  for (const identity of identities) counts.set(identity, (counts.get(identity) ?? 0) + 1)
  // Identical rows can be selected individually while displayed, but cannot be matched safely across reads.
  const keys = identities.map((identity, index) => (counts.get(identity) === 1 ? identity : `duplicate:${index}`))
  return { checks: keys.slice(0, checks.length), comments: keys.slice(checks.length), counts }
}

function PrFeedback({
  state,
  pr,
  stale,
  logs,
  canReadFiles,
  onReadLog,
  onCloseLog,
  onCompose,
}: Pick<PullRequestSectionProps, 'logs' | 'canReadFiles' | 'onReadLog' | 'onCloseLog' | 'onCompose'> & {
  state: GitPrState
  pr: PullRequest
  stale: boolean
}) {
  const keys = useMemo(() => feedbackKeys(state), [state])
  const canPick = canReadFiles && !!onCompose
  const [selection, setSelection] = useState<{ source: GitPrState; keys: Set<string> }>()
  let picked = selection?.keys
  if (selection && (!canPick || selection.source !== state)) {
    picked = canPick ? new Set([...selection.keys].filter(key => keys.counts.get(key) === 1)) : undefined
    setSelection(picked?.size ? { source: state, keys: picked } : undefined)
  }

  const select = (key: string, checked: boolean) => {
    setSelection(previous => {
      if (!checked && !previous?.keys.has(key)) return previous
      const next = new Set(previous?.keys)
      if (checked) next.add(key)
      else next.delete(key)
      return next.size ? { source: state, keys: next } : undefined
    })
  }
  const checkbox = (key: string, name: string) => (
    <label className="delivery-feedback-pick">
      <Checkbox
        aria-label={COPY.selectFeedback(escapeHiddenCharacters(name))}
        checked={picked?.has(key) ?? false}
        onChange={event => select(key, event.target.checked)}
      />
    </label>
  )
  const addOne = (key: string, text: string) => {
    onCompose?.(text)
    select(key, false)
  }
  const addPicked = () => {
    if (!onCompose || !picked?.size) return
    const excerpts: string[] = []
    for (const [index, check] of state.checks.entries()) {
      if (!picked.has(keys.checks[index])) continue
      const log = check.job ? logs[check.job] : undefined
      excerpts.push(
        checkExcerpt({ number: pr.number, check: check.name, sha: pr.headSha, text: log?.kind === 'ready' ? log.log.text : undefined }),
      )
    }
    for (const [index, comment] of (state.discussion ?? []).entries()) {
      if (picked.has(keys.comments[index])) excerpts.push(commentExcerpt({ number: pr.number, comment }))
    }
    if (excerpts.length) onCompose(excerpts.join('\n\n'))
    setSelection(undefined)
  }

  return (
    <>
      <div className="delivery-subhead">
        <span>{COPY.checks}</span>
        {pr.headSha && <code className="delivery-sha">{shortSha(pr.headSha)}</code>}
        {stale && (
          <Badge tone="warn" title={COPY.oldCheck}>
            {COPY.oldCommit}
          </Badge>
        )}
      </div>
      {state.checks.length === 0 ? (
        <p className="delivery-group-empty">{COPY.noChecks}</p>
      ) : (
        <div className="delivery-checks" role="list" aria-label={COPY.checks}>
          {state.checks.map((check, index) => {
            const key = keys.checks[index]
            return (
              <div role="listitem" key={key}>
                <CheckRow
                  check={check}
                  pr={pr}
                  pick={
                    canPick && check.state === 'fail' && pr.headSha
                      ? checkbox(key, check.workflow ? `${check.workflow} · ${check.name}` : check.name)
                      : undefined
                  }
                  log={check.job ? logs[check.job] : undefined}
                  onReadLog={onReadLog}
                  onCloseLog={onCloseLog}
                  onCompose={onCompose ? text => addOne(key, text) : undefined}
                />
              </div>
            )
          })}
        </div>
      )}
      {state.discussion && (
        <>
          <div className="delivery-subhead">
            <span>{COPY.comments}</span>
            <span className="delivery-count">{state.discussion.length}</span>
            {state.discussionCapped && <span className="delivery-count">{COPY.recent(state.discussion.length)}</span>}
          </div>
          {state.discussion.length === 0 ? (
            <p className="delivery-group-empty">{COPY.noComments}</p>
          ) : (
            <div className="delivery-comments">
              {state.discussion.map((comment, index) => {
                const key = keys.comments[index]
                return (
                  <Comment
                    key={key}
                    comment={comment}
                    pr={pr}
                    pick={canPick ? checkbox(key, `${comment.author} · ${commentPlace(comment)}`) : undefined}
                    onCompose={onCompose ? text => addOne(key, text) : undefined}
                  />
                )
              })}
            </div>
          )}
        </>
      )}
      {!!picked?.size && (
        <div className="delivery-feedback-actions">
          <Button size="sm" variant="ghost" onClick={() => setSelection(undefined)}>
            {COPY.clearFeedback}
          </Button>
          <Button size="sm" variant="outline" icon={MessageSquarePlus} onClick={addPicked}>
            {COPY.addFeedback(picked.size)}
          </Button>
        </div>
      )}
    </>
  )
}

/** The pull request step of 交付: 创建 PR, or the bound pull request with its checks, reviews and comments. */
export function PullRequestSection(props: PullRequestSectionProps) {
  const { read, head, branch, form, onForm, canWrite, nothingAhead, disabled, creating, failure, unknown, logs, onCompose } = props
  const state = read.kind === 'ready' ? read.state : undefined
  const pr = state?.pr
  const stale = pr ? checksStale(pr, head) : false
  const loading = read.kind === 'loading'
  const copy = read.kind === 'failed' ? failureCopy(read.code) : undefined

  return (
    <section ref={props.sectionRef} className="delivery-section" aria-label="PR">
      <div className="delivery-section-head">
        <h3 className="delivery-heading">PR</h3>
        <span className="delivery-space" />
        <span className="delivery-count">GitHub</span>
      </div>
      {read.kind === 'loading' && !state && (
        <div className="delivery-loading" aria-busy="true">
          <Spinner size={12} />
          <span>{COPY.reading}</span>
        </div>
      )}
      {read.kind === 'failed' && (
        <Line
          tone={copy?.tone === 'failed' || !copy ? 'red' : copy.tone === 'warn' ? 'amber' : 'muted'}
          icon={copy?.tone === 'neutral' ? InfoGlyph : copy?.tone === 'warn' ? WarningGlyph : AlertGlyph}
          detail={copy?.detail}
          action={
            <Button size="xs" variant="ghost" onClick={props.onReload}>
              {COPY.retry}
            </Button>
          }>
          {copy?.label ?? read.text}
        </Line>
      )}
      {unknown && (
        <Line
          locked
          tone="muted"
          icon={CircleHelp}
          detail={COPY.unknownInfo}
          action={
            <>
              <Button
                size="xs"
                variant="outline"
                loading={creating}
                loadingLabel={COPY.checking}
                disabled={props.retryDisabled}
                onClick={props.onRetry}>
                {COPY.retrySame}
              </Button>
              <Button size="xs" variant="ghost" disabled={creating} onClick={props.onAbandon}>
                {COPY.abandon}
              </Button>
            </>
          }>
          {COPY.unknown}
        </Line>
      )}
      {failure && <PrFailureLine failure={failure} />}
      {pr && (
        <>
          <PrRow pr={pr} onReload={props.onReload} loading={loading} />
          {props.sessionId && canWrite && props.canReadFiles && (pr.state === 'open' || state.follow?.enabled) && (
            <PrFollowControl
              key={pr.url}
              sessionId={props.sessionId}
              number={pr.number}
              value={state.follow}
              restriction={state.automaticRestriction}
              disabled={disabled}
              reload={props.onReload}
            />
          )}
          <PrFeedback
            key={JSON.stringify([pr.url, pr.number, pr.headSha])}
            state={state}
            pr={pr}
            stale={stale}
            logs={logs}
            canReadFiles={props.canReadFiles}
            onReadLog={props.onReadLog}
            onCloseLog={props.onCloseLog}
            onCompose={onCompose}
          />
        </>
      )}
      {state && !pr && nothingAhead && (
        <Line tone="muted" icon={InfoGlyph}>
          {failureCopy('pr-nothing-ahead')?.label}
        </Line>
      )}
      {state && !pr && canWrite && !nothingAhead && (
        <div className="delivery-pr-form">
          <TextField
            label={COPY.title}
            value={form.title}
            placeholder={state.draft?.title}
            maxLength={256}
            disabled={disabled || !!unknown}
            onChange={event => {
              onForm({ ...form, title: event.target.value })
            }}
          />
          <div className="delivery-pr-into">
            <TextField
              label={COPY.base}
              className="delivery-pr-base"
              value={form.base}
              placeholder={state.draft?.base}
              spellCheck={false}
              disabled={disabled || !!unknown}
              onChange={event => {
                onForm({ ...form, base: event.target.value })
              }}
            />
            {branch && (
              <code className="delivery-pr-head" title={branch}>
                ← <VisibleText text={branch} />
              </code>
            )}
          </div>
          <TextAreaField
            label={COPY.body}
            className="delivery-pr-body"
            rows={3}
            value={form.body}
            disabled={disabled || !!unknown}
            onChange={event => {
              onForm({ ...form, body: event.target.value })
            }}
          />
          <label className="delivery-switch">
            <span>{COPY.draft}</span>
            <Switch
              label={COPY.draft}
              checked={form.draft}
              disabled={disabled || !!unknown}
              onCheckedChange={draft => {
                onForm({ ...form, draft })
              }}
            />
          </label>
        </div>
      )}
    </section>
  )
}

function PrFailureLine({ failure }: { failure: PrFailure }) {
  const copy = failureCopy(failure.code)
  if (failure.code === 'pr-create-failed' && failure.tail)
    return (
      <section className="delivery-card" data-tone="red" aria-label={COPY.creationFailed}>
        <header className="delivery-card-head">
          <AlertGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          <strong>{COPY.creationFailed}</strong>
        </header>
        <Output text={failure.tail} label={COPY.ghOutput} />
      </section>
    )
  return (
    <Line
      tone={!copy || copy.tone === 'failed' ? 'red' : copy.tone === 'warn' ? 'amber' : 'muted'}
      icon={!copy || copy.tone === 'failed' ? AlertGlyph : copy.tone === 'warn' ? WarningGlyph : InfoGlyph}
      detail={copy?.detail}>
      {copy?.label ?? failure.text}
    </Line>
  )
}
