import { CircleDashed, CircleHelp, CircleMinus, GitPullRequest, MessageSquarePlus } from 'lucide-react'
import type { Ref } from 'react'
import type { GitCheck, GitPrComment, GitPrState, GitPullRequest as PullRequest } from '@latch/protocol'
import {
  Badge,
  Button,
  ButtonLink,
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
import { VisibleText } from '../../components/VisibleText.tsx'
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

export interface PrForm {
  title: string
  body: string
  base: string
  draft: boolean
}

export interface PullRequestSectionProps {
  sectionRef?: Ref<HTMLElement>
  read: PrRead
  /** The commit the branch is at here: checks of another one are 「旧提交」. */
  head?: string | undefined
  /** The branch the pull request is made from. */
  branch?: string | undefined
  form: PrForm
  onForm: (form: PrForm) => void
  canWrite: boolean
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
  log,
  onReadLog,
  onCloseLog,
  onCompose,
}: {
  check: GitCheck
  pr: PullRequest
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
            查看日志
          </Button>
        )}
      </div>
      {job && log?.kind === 'loading' && (
        <div className="delivery-loading" aria-busy="true">
          <Spinner size={12} />
          <span>正在读取日志…</span>
        </div>
      )}
      {job && log?.kind === 'failed' && (
        <Line tone="red" icon={AlertGlyph}>
          {failureCopy(log.code)?.label ?? log.text}
        </Line>
      )}
      {job && log?.kind === 'ready' && (
        <div className="delivery-log">
          <Output text={log.log.text || '（日志为空）'} label={`${check.name} 的日志`} />
          <div className="delivery-card-foot">
            <span className="delivery-card-note">{log.log.truncated ? '日志的最后 200 行' : ''}</span>
            {onCompose && (
              <Button
                size="xs"
                variant="outline"
                icon={MessageSquarePlus}
                onClick={() => {
                  onCompose(checkExcerpt({ number: pr.number, check: check.name, sha: pr.headSha, text: log.log.text }))
                }}>
                加入对话
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function Comment({ comment, pr, onCompose }: { comment: GitPrComment; pr: PullRequest; onCompose?: ((text: string) => void) | undefined }) {
  return (
    <article className="delivery-comment" aria-label={`${comment.author} · ${commentPlace(comment)}`}>
      <header className="delivery-comment-head">
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
            加入对话
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
            打开
          </ButtonLink>
        )}
        <IconButton size="xs" label="刷新" icon={RefreshGlyph} disabled={loading} onClick={onReload} />
      </div>
      <div className="delivery-pr-states">
        <StatusWord tone={pr.state === 'merged' ? 'done' : 'neutral'}>{PR_STATE_WORD[pr.state]}</StatusWord>
        {pr.draft && <Badge>草稿</Badge>}
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
          <span>正在读取 PR…</span>
        </div>
      )}
      {read.kind === 'failed' && (
        <Line
          tone={copy?.tone === 'failed' || !copy ? 'red' : copy.tone === 'warn' ? 'amber' : 'muted'}
          icon={copy?.tone === 'neutral' ? InfoGlyph : copy?.tone === 'warn' ? WarningGlyph : AlertGlyph}
          detail={copy?.detail}
          action={
            <Button size="xs" variant="ghost" onClick={props.onReload}>
              重试
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
          detail="没有收到答复，PR 可能已经建好。重试沿用同一请求，电脑会先按分支查找，不会建两个。放弃这次结果只在这个页面上放下它，电脑上的记录仍是结果未知；之后再创建 PR 时，电脑同样先按分支查找，找到就绑定它。"
          action={
            <>
              <Button
                size="xs"
                variant="outline"
                loading={creating}
                loadingLabel="核对中…"
                disabled={props.retryDisabled}
                onClick={props.onRetry}>
                重试同一请求
              </Button>
              <Button size="xs" variant="ghost" disabled={creating} onClick={props.onAbandon}>
                放弃这次结果
              </Button>
            </>
          }>
          PR 结果未知
        </Line>
      )}
      {failure && <PrFailureLine failure={failure} />}
      {pr && (
        <>
          <PrRow pr={pr} onReload={props.onReload} loading={loading} />
          <div className="delivery-subhead">
            <span>检查</span>
            {pr.headSha && <code className="delivery-sha">{shortSha(pr.headSha)}</code>}
            {stale && (
              <Badge tone="warn" title="检查对应的不是这里最新的提交">
                旧提交
              </Badge>
            )}
          </div>
          {state.checks.length === 0 ? (
            <p className="delivery-group-empty">没有检查</p>
          ) : (
            <div className="delivery-checks" role="list" aria-label="检查">
              {state.checks.map((check, index) => (
                <div role="listitem" key={`${check.name}\n${index}`}>
                  <CheckRow
                    check={check}
                    pr={pr}
                    log={check.job ? logs[check.job] : undefined}
                    onReadLog={props.onReadLog}
                    onCloseLog={props.onCloseLog}
                    onCompose={onCompose}
                  />
                </div>
              ))}
            </div>
          )}
          {state.discussion && (
            <>
              <div className="delivery-subhead">
                <span>评论</span>
                <span className="delivery-count">{state.discussion.length}</span>
                {state.discussionCapped && <span className="delivery-count">· 只显示最新 {state.discussion.length} 条</span>}
              </div>
              {state.discussion.length === 0 ? (
                <p className="delivery-group-empty">没有评论</p>
              ) : (
                <div className="delivery-comments">
                  {state.discussion.map((comment, index) => (
                    <Comment key={`${comment.kind}\n${comment.at ?? ''}\n${index}`} comment={comment} pr={pr} onCompose={onCompose} />
                  ))}
                </div>
              )}
            </>
          )}
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
            label="标题"
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
              label="合入"
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
            label="正文"
            className="delivery-pr-body"
            rows={3}
            value={form.body}
            disabled={disabled || !!unknown}
            onChange={event => {
              onForm({ ...form, body: event.target.value })
            }}
          />
          <label className="delivery-switch">
            <span>草稿</span>
            <Switch
              label="草稿"
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
      <section className="delivery-card" data-tone="red" aria-label="PR 没有创建">
        <header className="delivery-card-head">
          <AlertGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          <strong>PR 没有创建</strong>
        </header>
        <Output text={failure.tail} label="gh 输出" />
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
