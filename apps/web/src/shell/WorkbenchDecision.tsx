import type { AgentAvatar as AgentAvatarValue, TaskSummary } from '@latch/protocol'
import { useState, type ReactNode } from 'react'
import {
  AlertGlyph,
  Button,
  ChevronRightGlyph,
  FileGlyph,
  FolderGlyph,
  Icon,
  InlineNotice,
  Skeleton,
  StatusWord,
  UnknownGlyph,
  WaitingGlyph,
} from '@latch/ui'
import { ApprovalDrawer } from '../composer/ApprovalDrawer.tsx'
import { QuestionDrawer, useQuestionDrawer } from '../composer/QuestionDrawer.tsx'
import { escapeHiddenCharacters, hasHiddenCharacters, VisibleText } from '../components/VisibleText.tsx'
import { AgentAvatar } from '../agents/AgentAvatar.tsx'
import { HarnessTile } from '../components/BrandTile.tsx'
import { harnessName } from '../composerChoice.ts'
import { composerGate } from '../core/permissions.ts'
import { APPROVAL_COPY } from '../core/securityCopy.ts'
import { projectOf, workStatus } from '../sessions.ts'
import { hostNow } from '../core/hostClock.ts'
import { useWorkbenchSession } from './useWorkbenchEvidence.ts'
import type { ShellState } from './useShellLayout.tsx'
import { failureAction } from '../conversation/failureAction.ts'
import { toolHeading, toolRowId } from '../conversation.ts'
import { basename } from '../format.ts'
import { previousState } from '../diff.ts'
import { renderMarkdown } from '../MessageContent.tsx'
import remarkGfm from 'remark-gfm'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    excerpt: '拟写内容 · 摘录',
    proposed: '拟写内容',
    fullContent: '完整内容见原请求',
    original: '核对材料 · 原文件内容',
    fullDiff: '完整差异见原请求',
    check: '核对',
    retry: '重试',
    view: '查看',
    untitled: '未命名会话',
    allowFile: (action: string, name: string) => `允许${action} ${name}？`,
    write: '写入',
    update: '更新',
    checkOutcome: '核对结果',
    viewRequest: '查看原请求',
    viewQuestion: '查看问题',
    viewFailure: '查看失败',
    viewSession: '查看会话',
    unknown: '结果未知',
    awaiting: '等待审批',
    loadFailed: '读取失败',
    requestDetails: '请求说明',
    questionContext: '问题背景',
    reason: '失败原因',
    loading: '正在读取请求',
    noProject: '无项目',
    answerUnknown: '回答结果未知',
    answerOffline: '连接恢复后可以回答',
    readOnly: '这台设备只能看',
    decideOffline: '连接恢复后可以处理',
    unconfirmed: '执行结果尚未确认',
    topicFailure: '这一轮失败了，打开话题看原因',
    sessionFailure: '本轮失败，打开会话查看原因',
    viewTopic: '查看话题',
  },
  {
    excerpt: 'Proposed content · excerpt',
    proposed: 'Proposed content',
    fullContent: 'See the original request for the full content',
    original: 'Review material · original file contents',
    fullDiff: 'See the original request for the full diff',
    check: 'Check',
    retry: 'Retry',
    view: 'View',
    untitled: 'Untitled session',
    allowFile: (action: string, name: string) => `Allow ${action} to ${name}?`,
    write: 'writes',
    update: 'updates',
    checkOutcome: 'Check outcome',
    viewRequest: 'View original request',
    viewQuestion: 'View question',
    viewFailure: 'View failure',
    viewSession: 'View session',
    unknown: 'Outcome unknown',
    awaiting: 'Awaiting approval',
    loadFailed: 'Couldn’t load',
    requestDetails: 'Request details',
    questionContext: 'Question context',
    reason: 'Reason for failure',
    loading: 'Loading request',
    noProject: 'No project',
    answerUnknown: 'Answer outcome unknown',
    answerOffline: 'Answer when connected',
    readOnly: 'This device can only view',
    decideOffline: 'Respond when connected',
    unconfirmed: 'Execution outcome is still unknown',
    topicFailure: 'This turn failed. Open the topic for details.',
    sessionFailure: 'This turn failed. Open the session for details.',
    viewTopic: 'View topic',
  },
)

function DraftExcerpt({ path, text, previous }: { path: string; text: string; previous: string | undefined }) {
  const excerpt = text.slice(0, 900).split(/\r?\n/u).slice(0, 7).join('\n').trimEnd()
  const incomplete = excerpt !== text.trimEnd()
  const markdown = /\.(?:md|markdown)$/iu.test(path)
    ? renderMarkdown({
        children: excerpt,
        // A table is drawn as one: its pipes would otherwise read as the text.
        remarkPlugins: [remarkGfm],
        allowedElements: [
          ...['h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'pre'],
          ...['table', 'thead', 'tbody', 'tr', 'th', 'td'],
        ],
        skipHtml: true,
        unwrapDisallowed: true,
      })
    : null
  return (
    <div className="work-feature-material" data-secure="">
      <header>
        <Icon icon={FileGlyph} size={14} />
        <code>
          <VisibleText text={path} />
        </code>
        <span>{incomplete ? COPY.excerpt : COPY.proposed}</span>
      </header>
      <div className="work-feature-material-body" role="region" aria-label={COPY.proposed} tabIndex={0}>
        {markdown ?? (
          <pre>
            <VisibleText text={excerpt} />
          </pre>
        )}
      </div>
      {incomplete && <p className="work-feature-excerpt-note">{COPY.fullContent}</p>}
      {previous?.trim() && (
        <details className="work-feature-reference">
          <summary>{COPY.original}</summary>
          <pre>
            <VisibleText text={previous.slice(0, 900)} />
          </pre>
          {previous.length > 900 && <p>{COPY.fullDiff}</p>}
        </details>
      )}
    </div>
  )
}

/** The same requests and decision controller as the conversation, presented where the person finds their work. */
export function WorkbenchDecision({
  task,
  shell,
  emphasis = false,
  expanded = true,
  onExpand,
  featured = false,
  navigation,
  person,
}: {
  task: TaskSummary
  shell: ShellState
  /**
   * A topic of 我的 Agent: the card is the helper's. Its title carries the name (「小满想改 …」), the source line is the face
   * and the name, and no project, Harness or model is said.
   */
  person?: { name: string; avatar: AgentAvatarValue | 'general' } | undefined
  emphasis?: boolean
  expanded?: boolean
  onExpand?: () => void
  featured?: boolean
  navigation?: ReactNode
}) {
  const enabled = shell.connection === 'connected' && shell.access.scopes.has('view')
  const scope = `${shell.snapshot.device.id}:${shell.snapshot.device.dataScope}:${shell.snapshot.device.scopes.join(',')}`
  const read = useWorkbenchSession(task, scope, enabled)
  const detail = read.detail
  const harness = shell.catalog?.harnesses.find(item => item.id === task.harnessId)
  const project = projectOf(task, shell.catalog?.workspaces ?? [])
  const gate = composerGate({ summary: detail?.summary ?? task, permission: detail?.permission, access: shell.access, stopped: false })
  const canAnswer = enabled && gate.kind === 'open'
  const asked = useQuestionDrawer(detail?.questions?.[0], task.id, {
    deviceId: shell.snapshot.device.id,
    canAnswer,
    onChanged: async () => {
      await shell.refresh()
      read.retry()
    },
    onSettledElsewhere: text => shell.setToast({ text, tone: 'ok' }),
  })
  const status = workStatus(task, { connected: enabled, now: hostNow() })
  const [index, setIndex] = useState<number>()
  const unknownIndex = detail?.approvals.findIndex(item => shell.statuses.get(item.id)?.uncertain) ?? -1
  const position = index ?? Math.max(0, unknownIndex)
  const approval = detail?.approvals[Math.min(position, detail.approvals.length - 1)]
  const approvalUnknown =
    unknownIndex >= 0 || shell.snapshot.approvals.some(item => item.sessionId === task.id && shell.statuses.get(item.id)?.uncertain)
  const toolMessage = approval ? detail?.messages.find(message => message.id === toolRowId(approval)) : undefined
  const action = approval
    ? toolHeading(toolMessage?.tool ?? approval.tool, toolMessage?.toolName ?? approval.toolName, detail?.summary.harnessId !== 'standard')
    : undefined
  const failure = detail?.messages.findLast(message => message.role === 'system' && message.state === 'failed')
  const retryable =
    enabled
    && canAnswer
    && detail
    && status.tone === 'failed'
    && !task.runEnd?.unknownResultCount
    && failureAction(failure?.errorCode) === 'retry'
    && shell.submission.pending === null
    && !shell.submission.sending
  // A failed or unconfirmed run is titled by what the person does about it: the verb, then its object. The Host names no
  // object for either, so the object is the session, and its title is then not said a second time under it.
  const resultUnknown = !!task.runEnd?.unknownResultCount
  const resultVerb = resultUnknown ? COPY.check : status.tone === 'failed' ? (retryable ? COPY.retry : COPY.view) : undefined
  const resultIcon = status.tone === 'failed' ? AlertGlyph : resultUnknown ? UnknownGlyph : WaitingGlyph
  const sessionTitle = task.title || COPY.untitled
  const asker = person?.name ?? (harness ? harnessName(harness) : 'Agent')
  if (featured) {
    const original = approvalUnknown
      ? (detail?.approvals[unknownIndex]
        ?? shell.snapshot.approvals.find(item => item.sessionId === task.id && shell.statuses.get(item.id)?.uncertain))
      : approval
    const tool = toolMessage?.tool ?? approval?.tool
    const diffs = tool?.diffs ?? approval?.tool?.diffs ?? []
    const diff = diffs.length === 1 ? diffs[0] : undefined
    const approvalGate = approval ? shell.gateFor(approval) : undefined
    const draft =
      diff
      && diff.newText.trim()
      && (previousState(diff) === 'text' || previousState(diff) === 'none')
      && tool?.kind === 'edit'
      && approval?.risk === 'R1'
      && !approval.advisory
      && approvalGate?.kind === 'R1'
      && !approvalGate.hint
      && !approvalGate.note
      && !approvalUnknown
      && ![action, diff.path, diff.oldText, diff.newText, approval.reason, approval.arguments, tool.input].some(hasHiddenCharacters)
        ? diff
        : undefined
    const question = asked?.question
    const failed = status.tone === 'failed'
    const title = approvalUnknown
      ? APPROVAL_COPY.uncertainApproval
      : draft
        ? COPY.allowFile(previousState(draft) === 'none' ? COPY.write : COPY.update, basename(draft.path))
        : (action ?? (question ? question.questions[0]?.label || question.prompt : undefined) ?? sessionTitle)
    const detailText = read.error ?? (approvalUnknown ? undefined : approval ? approval.reason : question?.prompt || failure?.text)
    const link =
      approvalUnknown || resultUnknown
        ? COPY.checkOutcome
        : approval
          ? COPY.viewRequest
          : question
            ? COPY.viewQuestion
            : failed
              ? COPY.viewFailure
              : COPY.viewSession
    const showText = !draft && detailText && detailText !== title
    // Keep approval material out of layout snapshots before and after the authorized detail arrives.
    const secureRequest = !!approval || approvalUnknown || task.status === 'waiting-approval' || !!question || !!task.pendingQuestions
    return (
      <article className="work-feature" ref={read.element} data-work-session={task.id}>
        <div className="work-feature-summary" data-secure={secureRequest && !draft && !showText ? '' : undefined}>
          <h3 title={escapeHiddenCharacters(title)}>
            <VisibleText text={title} />
          </h3>
          <div className="work-feature-meta">
            {harness && (
              <span>
                <HarnessTile harness={harness} size={16} />
                <VisibleText text={asker} />
              </span>
            )}
            {project && (
              <span>
                <Icon icon={FolderGlyph} size={12} />
                <VisibleText text={project.name} />
              </span>
            )}
            <StatusWord tone={approvalUnknown ? 'warn' : status.tone}>
              {approvalUnknown
                ? COPY.unknown
                : approval && enabled
                  ? approvalGate?.options.length
                    ? APPROVAL_COPY.waiting
                    : COPY.awaiting
                  : status.words}
            </StatusWord>
            {approval?.risk === 'R2' && !approvalUnknown && <StatusWord tone="failed">{APPROVAL_COPY.highRisk}</StatusWord>}
            {approval?.advisory && !approvalUnknown && <StatusWord tone="warn">{APPROVAL_COPY.advisory}</StatusWord>}
          </div>
        </div>
        {navigation}
        {draft ? (
          <DraftExcerpt key={original?.id} path={draft.path} text={draft.newText} previous={draft.oldText} />
        ) : showText ? (
          <div
            className="work-feature-material"
            data-secure={secureRequest ? '' : undefined}
            data-tone={read.error || failed ? 'failed' : undefined}>
            <header>{read.error ? COPY.loadFailed : approval ? COPY.requestDetails : question ? COPY.questionContext : COPY.reason}</header>
            <div className="work-feature-material-body" tabIndex={0}>
              <p>
                <VisibleText text={detailText} />
              </p>
            </div>
          </div>
        ) : read.loading ? (
          <div className="work-feature-material" role="status" aria-label={COPY.loading}>
            <div className="work-feature-material-body">
              <Skeleton width="65%" height={16} />
            </div>
          </div>
        ) : null}
        <div className="work-feature-action">
          <Button variant="primary" size="sm" onClick={() => (original ? shell.openApproval(task.id, original.id) : shell.choose(task.id))}>
            {link}
            <Icon icon={ChevronRightGlyph} size={14} />
          </Button>
        </div>
      </article>
    )
  }
  const source = person ? (
    <span className="work-decision-person">
      <AgentAvatar avatar={person.avatar} size={16} />
      <VisibleText text={person.name} />
    </span>
  ) : (
    <span>
      <Icon icon={FolderGlyph} size={12} />
      <VisibleText text={project?.name ?? COPY.noProject} />
    </span>
  )
  const context = (
    <div className="work-decision-context">
      {/* An approval's title already names the helper (「小满 想改 …」): the source line does not say it again. */}
      {!(person && approval) && source}
      {!(resultVerb && !approval && !asked) && (
        <Button
          variant="ghost"
          size="xs"
          className="work-decision-session"
          title={escapeHiddenCharacters(sessionTitle)}
          onClick={() => shell.choose(task.id)}>
          <span className="work-decision-session-title">
            <VisibleText text={sessionTitle} />
          </span>
        </Button>
      )}
      {harness && !person && (
        <span className="work-decision-harness">
          <HarnessTile harness={harness} size={14} />
          {harnessName(harness)}
        </span>
      )}
      {approval && approvalUnknown && !shell.statuses.get(approval.id)?.uncertain && (
        <StatusWord tone="warn">{APPROVAL_COPY.uncertainApproval}</StatusWord>
      )}
    </div>
  )
  const unknown = approvalUnknown ? APPROVAL_COPY.uncertainApproval : asked?.draft.pending ? COPY.answerUnknown : undefined
  return (
    <article
      ref={read.element}
      className="work-decision"
      data-work-session={task.id}
      data-expanded={expanded ? '' : undefined}
      data-kind={approval ? 'approval' : asked ? 'question' : status.tone}>
      {!expanded && asked && !approvalUnknown ? (
        <QuestionDrawer
          presentation="workbench"
          compact
          context={context}
          state={asked}
          asker={asker}
          canAnswer={canAnswer}
          disabledReason={!enabled ? COPY.answerOffline : COPY.readOnly}
          onOther={() => shell.choose(task.id)}
        />
      ) : !expanded ? (
        <div className="work-decision-compact-row">
          <Button variant="ghost" className="work-decision-compact" aria-expanded={false} onClick={onExpand}>
            <span className="work-decision-compact-title">
              {!action && resultVerb ? (
                <>
                  <span className="work-decision-kind" data-tone={status.tone}>
                    <Icon icon={resultIcon} size={14} />
                  </span>
                  <span className="work-decision-verb">{resultVerb}</span>
                  <VisibleText text={sessionTitle} />
                </>
              ) : (
                <VisibleText text={action ?? sessionTitle} />
              )}
            </span>
            <span className="work-decision-compact-meta">
              {person ? (
                <>
                  <AgentAvatar avatar={person.avatar} size={16} />
                  <VisibleText text={person.name} />
                </>
              ) : (
                <>
                  <Icon icon={FolderGlyph} size={12} />
                  <VisibleText text={project?.name ?? COPY.noProject} />
                </>
              )}
              {/* The title's verb and icon already say a failure; how many results are unconfirmed is still said. */}
              {(action || status.tone !== 'failed' || unknown) && (
                <StatusWord tone={unknown ? 'warn' : status.tone}>{unknown ?? status.words}</StatusWord>
              )}
            </span>
            {!retryable && <Icon icon={ChevronRightGlyph} size={14} />}
          </Button>
          {retryable && (
            <Button size="xs" variant="outline" onClick={() => shell.retryFromWorkbench(detail)}>
              {COPY.retry}
            </Button>
          )}
        </div>
      ) : approval ? (
        <ApprovalDrawer
          presentation="workbench"
          builtin={detail.summary.harnessId === 'standard'}
          emphasis={emphasis}
          context={context}
          {...(person ? { requester: person.name } : {})}
          approvals={detail.approvals}
          messages={detail.messages}
          index={position}
          onIndex={setIndex}
          gateFor={approval => (enabled ? shell.gateFor(approval) : { ...shell.gateFor(approval), options: [], hint: COPY.decideOffline })}
          busy={shell.approvalBusy}
          statuses={shell.statuses}
          onDecide={shell.onDecide}
          canRetry={shell.canRetryApproval}
          onCheck={shell.checkApproval}
        />
      ) : asked ? (
        <QuestionDrawer
          presentation="workbench"
          context={context}
          state={asked}
          asker={asker}
          canAnswer={canAnswer}
          disabledReason={!enabled ? COPY.answerOffline : COPY.readOnly}
          onOther={() => shell.choose(task.id)}
        />
      ) : (
        <div className="work-decision-result">
          <strong data-tone={approvalUnknown ? 'warn' : status.tone}>
            <Icon icon={resultIcon} size={16} />
            {resultVerb ? (
              <>
                <span className="work-decision-verb">{resultVerb}</span>
                <Button variant="ghost" size="xs" className="work-decision-object" onClick={() => shell.choose(task.id)}>
                  <VisibleText text={sessionTitle} />
                </Button>
              </>
            ) : approvalUnknown ? (
              APPROVAL_COPY.uncertainApproval
            ) : (
              status.words
            )}
          </strong>
          {context}
          {read.error ? (
            <InlineNotice
              tone="error"
              action={
                <Button variant="outline" size="xs" onClick={read.retry}>
                  {COPY.retry}
                </Button>
              }>
              {read.error}
            </InlineNotice>
          ) : !detail && enabled ? (
            <div className="work-decision-placeholder" aria-label={read.loading ? COPY.loading : undefined}>
              {read.loading && (
                <>
                  <Skeleton width="80%" height={16} />
                  <Skeleton width="60%" height={16} />
                </>
              )}
            </div>
          ) : (
            <p data-lock={task.runEnd?.unknownResultCount ? '' : undefined}>
              <VisibleText
                text={
                  detail?.messages.findLast(message => message.role === 'system')?.text
                  ?? (task.runEnd?.unknownResultCount
                    ? COPY.unconfirmed
                    : task.status === 'failed' || task.runOutcome === 'failed'
                      ? person
                        ? COPY.topicFailure
                        : COPY.sessionFailure
                      : status.words)
                }
              />
            </p>
          )}
          <div className="work-decision-result-actions">
            <Button size="sm" variant="outline" onClick={() => shell.choose(task.id)}>
              {task.runEnd?.unknownResultCount ? COPY.checkOutcome : person ? COPY.viewTopic : COPY.viewSession}
            </Button>
            {retryable && (
              <Button size="sm" variant="outline" onClick={() => shell.retryFromWorkbench(detail)}>
                {COPY.retry}
              </Button>
            )}
          </div>
        </div>
      )}
    </article>
  )
}
