import type { AgentAvatar as AgentAvatarValue, TaskSummary } from '@latch/protocol'
import { useState } from 'react'
import {
  AlertGlyph,
  Button,
  ChevronRightGlyph,
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
import { VisibleText } from '../components/VisibleText.tsx'
import { AgentAvatar } from '../agents/AgentAvatar.tsx'
import { HarnessTile } from '../components/BrandTile.tsx'
import { harnessName } from '../composerChoice.ts'
import { composerGate } from '../core/permissions.ts'
import { projectOf } from '../sessions.ts'
import { workStatus } from './workOverview.ts'
import { hostNow } from '../core/hostClock.ts'
import { useWorkbenchSession } from './useWorkbenchEvidence.ts'
import type { ShellState } from './useShellLayout.tsx'
import { failureAction } from '../conversation/failureAction.ts'
import { toolHeading, toolRowId } from '../conversation.ts'

/** The same requests and decision controller as the conversation, presented where the person finds their work. */
export function WorkbenchDecision({
  task,
  shell,
  emphasis = false,
  expanded = true,
  onExpand,
  firstKeys = false,
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
  firstKeys?: boolean
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
  })
  const status = workStatus(task, { connected: enabled, now: hostNow() })
  const [index, setIndex] = useState(0)
  const approval = detail?.approvals[0]
  const toolMessage = approval ? detail?.messages.find(message => message.id === toolRowId(approval)) : undefined
  const action = approval ? toolHeading(toolMessage?.tool ?? approval.tool, toolMessage?.toolName ?? approval.toolName) : undefined
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
  const resultVerb = resultUnknown ? '核对' : status.tone === 'failed' ? (retryable ? '重试' : '查看') : undefined
  const resultIcon = status.tone === 'failed' ? AlertGlyph : resultUnknown ? UnknownGlyph : WaitingGlyph
  const sessionTitle = task.title || '未命名会话'
  const asker = person?.name ?? (harness ? harnessName(harness) : 'Agent')
  const source = person ? (
    <span className="work-decision-person">
      <AgentAvatar avatar={person.avatar} size={16} />
      <VisibleText text={person.name} />
    </span>
  ) : (
    <span>
      <Icon icon={FolderGlyph} size={12} />
      <VisibleText text={project?.name ?? '无项目'} />
    </span>
  )
  const context = (
    <div className="work-decision-context">
      {/* An approval's title already names the helper (「小满 想改 …」): the source line does not say it again. */}
      {!(person && approval) && source}
      {!(resultVerb && !approval && !asked) && (
        <Button variant="ghost" size="xs" className="work-decision-session" onClick={() => shell.choose(task.id)}>
          <VisibleText text={sessionTitle} />
        </Button>
      )}
      {harness && !person && (
        <span className="work-decision-harness">
          <HarnessTile harness={harness} size={14} />
          {harnessName(harness)}
        </span>
      )}
    </div>
  )
  const unknown = detail?.approvals.some(item => shell.statuses.get(item.id)?.uncertain)
    ? '决定结果未知'
    : asked?.draft.pending
      ? '回答结果未知'
      : undefined
  return (
    <article
      ref={read.element}
      className="work-decision"
      data-work-session={task.id}
      data-expanded={expanded ? '' : undefined}
      data-kind={approval ? 'approval' : asked ? 'question' : status.tone}>
      {!expanded && asked ? (
        <QuestionDrawer
          presentation="workbench"
          compact
          context={context}
          state={asked}
          asker={asker}
          canAnswer={canAnswer}
          disabledReason={!enabled ? '连接恢复后可以回答' : '这台设备只能看'}
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
                  <VisibleText text={project?.name ?? '无项目'} />
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
              重试
            </Button>
          )}
        </div>
      ) : approval ? (
        <ApprovalDrawer
          presentation="workbench"
          emphasis={emphasis}
          context={context}
          numberKeys={firstKeys}
          {...(person ? { requester: person.name } : {})}
          approvals={detail.approvals}
          messages={detail.messages}
          index={index}
          onIndex={setIndex}
          gateFor={approval =>
            enabled ? shell.gateFor(approval) : { ...shell.gateFor(approval), options: [], hint: '连接恢复后可以处理' }
          }
          busy={shell.approvalBusy}
          statuses={shell.statuses}
          onDecide={shell.onDecide}
        />
      ) : asked ? (
        <QuestionDrawer
          presentation="workbench"
          context={context}
          firstKeys={firstKeys}
          state={asked}
          asker={asker}
          canAnswer={canAnswer}
          disabledReason={!enabled ? '连接恢复后可以回答' : '这台设备只能看'}
          onOther={() => shell.choose(task.id)}
        />
      ) : (
        <div className="work-decision-result">
          <strong data-tone={status.tone}>
            <Icon icon={resultIcon} size={16} />
            {resultVerb ? (
              <>
                <span className="work-decision-verb">{resultVerb}</span>
                <Button variant="ghost" size="xs" className="work-decision-object" onClick={() => shell.choose(task.id)}>
                  <VisibleText text={sessionTitle} />
                </Button>
              </>
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
                  重试
                </Button>
              }>
              {read.error}
            </InlineNotice>
          ) : !detail && enabled ? (
            <div className="work-decision-placeholder" aria-label={read.loading ? '正在读取请求' : undefined}>
              {read.loading && (
                <>
                  <Skeleton width="80%" height={16} />
                  <Skeleton width="60%" height={16} />
                </>
              )}
            </div>
          ) : (
            <p>
              <VisibleText
                text={
                  detail?.messages.findLast(message => message.role === 'system')?.text
                  ?? (task.runEnd?.unknownResultCount
                    ? '执行结果尚未确认'
                    : task.status === 'failed' || task.runOutcome === 'failed'
                      ? person
                        ? '这一轮失败了，打开话题看原因'
                        : '本轮失败，打开会话查看原因'
                      : status.words)
                }
              />
            </p>
          )}
          <div className="work-decision-result-actions">
            <Button size="sm" variant="outline" onClick={() => shell.choose(task.id)}>
              {task.runEnd?.unknownResultCount ? '核对结果' : person ? '查看话题' : '查看会话'}
            </Button>
            {retryable && (
              <Button size="sm" variant="outline" onClick={() => shell.retryFromWorkbench(detail)}>
                重试
              </Button>
            )}
          </div>
        </div>
      )}
    </article>
  )
}
