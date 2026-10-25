import { memo, useId, useState } from 'react'
import { ChevronRight, CircleDashed, CircleSlash, TriangleAlert } from 'lucide-react'
import type { Approval, FileDiff, Message, ToolDetail } from '@latch/protocol'
import { hasDiffs, toolDuration, toolLabel } from '../conversation.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { formatDuration } from '../format.ts'
import { toolKind, toolKindIcons } from '../icons.tsx'
import { approvalActions, type ApprovalGate } from '../core/permissions.ts'
import { ApprovalPill, ApprovalSlot, approvalHidesText, type DecideHandler } from './ApprovalCard.tsx'
import { ArgumentList } from './ArgumentList.tsx'
import { DiffView } from './DiffView.tsx'
import { CopyButton } from './ui.tsx'
import { Collapse, ICON_STROKE, StatusGlyph, StatusWords, WaitingPill } from '@latch/ui'
import { VisibleText } from './VisibleText.tsx'

type ToolState = NonNullable<Message['state']>
/** Words for the states a row names; a running or finished tool says it through its verb and duration instead. */
const stateWords: Partial<Record<ToolState, string>> = {
  'awaiting-approval': '待批准',
  failed: '失败',
  cancelled: '已取消',
}

export type { DecideHandler } from './ApprovalCard.tsx'
/** This device's buttons for an approval; the default keeps every offered option (a Host without device scopes). */
export type ApprovalGateFor = (approval: Approval) => ApprovalGate
const plainGate: ApprovalGateFor = approval => approvalActions(approval, null, null)

const sameDiffs = (a: FileDiff[] | undefined, b: FileDiff[] | undefined) =>
  a === b
  || (a?.length === b?.length
    && (a ?? []).every((diff, index) => {
      const other = b![index]!
      return (
        diff.path === other.path && diff.oldText === other.oldText && diff.newText === other.newText && diff.previous === other.previous
      )
    }))
const sameTool = (a: ToolDetail | undefined, b: ToolDetail | undefined) =>
  a === b
  || (a !== undefined
    && b !== undefined
    && a.kind === b.kind
    && a.title === b.title
    && a.input === b.input
    && a.output === b.output
    && a.locations?.join('\n') === b.locations?.join('\n')
    && sameDiffs(a.diffs, b.diffs))

/** How long the tool ran, ticking every second while it runs and frozen once it settles; nothing under a second. */
function ToolTime({ message }: { message: Message }) {
  useTicker(message.state === 'running' ? 'second' : false)
  const duration = toolDuration(message, hostNow())
  const text = duration ? formatDuration(duration.ms, duration.live) : undefined
  if (!text) return null
  return <span className="process-time">{text}</span>
}

/**
 * Live output keeps its newest lines in view while it streams without writing a scroll position: the box is laid out
 * from its end (column-reverse), so it stays at the bottom until the reader scrolls up inside it, and stays where the
 * reader left it after that.
 */
function ToolOutput({ text, running }: { text: string; running: boolean }) {
  return (
    <div className={`tool-output-scroll ${running ? 'is-live' : ''}`}>
      <pre className="tool-pre tool-output">
        <VisibleText text={text} />
      </pre>
    </div>
  )
}

/**
 * One tool call. At rest it is a quiet row of the process: the kind's icon (the comet while it runs), what it does in
 * the tense of its state with its object, the tool's ID, how long it ran and, when it did not simply finish, its
 * state. Opening it (or a failure with output, which opens by itself) turns the row into a card on the column's edges,
 * a tray holding a sheet of paper with its arguments, its changes and its output. A pending approval for the call
 * grows the same card, so the decision sits next to what it authorizes. While the card is closed, a tool's file changes
 * stay in view under its row as evidence, never inside another tray.
 */
export const ToolCard = memo(
  function ToolCard({
    message,
    approval,
    busy,
    onDecide,
    gateFor = plainGate,
  }: {
    message: Message | null
    approval?: Approval
    busy?: string
    onDecide: DecideHandler
    gateFor?: ApprovalGateFor
  }) {
    const bodyId = useId()
    const state: ToolState = message?.state ?? (approval ? 'awaiting-approval' : 'completed')
    const tool = message?.tool ?? approval?.tool
    const toolName = message?.toolName ?? approval?.toolName ?? ''
    const title = tool?.title || toolName || '工具调用'
    const label = toolLabel({ tool, toolName, state })
    const KindIcon = toolKindIcons[toolKind({ tool, toolName })]
    const diffs = tool?.diffs ?? approval?.tool?.diffs ?? []
    const output = message?.tool?.output ?? message?.text ?? ''
    const failedWithOutput = state === 'failed' && output.trim().length > 0
    const [choice, setChoice] = useState<boolean | null>(null)
    const open = approval ? true : (choice ?? failedWithOutput)
    // While an approval is open its panel shows the arguments and diff; otherwise the diff stays under the row.
    const evidence = !approval && message !== null && hasDiffs(message)
    const showOutput = message !== null && state !== 'awaiting-approval' && state !== 'queued'
    const gate = approval ? gateFor(approval) : undefined
    const hidden = approval !== undefined && approvalHidesText(approval, title, diffs)
    const glyph =
      state === 'failed' ? (
        <TriangleAlert className="process-failed" size={14} strokeWidth={ICON_STROKE[14]} />
      ) : state === 'cancelled' ? (
        <CircleSlash size={14} strokeWidth={ICON_STROKE[14]} />
      ) : state === 'queued' ? (
        <CircleDashed size={14} strokeWidth={ICON_STROKE[14]} />
      ) : (
        <KindIcon size={14} strokeWidth={ICON_STROKE[14]} />
      )
    // A state change the page saw happen: the comet and the result icon cross-fade and the new words rise in.
    const heading = (
      <>
        <StatusGlyph className="tool-card-icon process-slot" running={state === 'running'} state={state}>
          {glyph}
        </StatusGlyph>
        {/* An approval card names the call by the tool's own title, the text the approver weighs; a row says what it does. */}
        {approval ? (
          <span className="tool-card-title">
            <VisibleText text={title} />
          </span>
        ) : (
          <StatusWords state={label.verb ? state : 'title'} className="process-label">
            {label.verb && <span className="process-verb">{label.verb}</span>}
            <span className={label.mono ? 'process-object is-mono' : 'process-object'}>
              <VisibleText text={label.object} />
            </span>
          </StatusWords>
        )}
        {toolName && toolName !== (approval ? title : label.object) && (
          <code className="tool-card-name">
            <VisibleText text={toolName} />
          </code>
        )}
        <span className="process-fill" />
        <span className="process-end">
          {message && <ToolTime message={message} />}
          <StatusWords state={state} className={`tool-card-state state-${state}`}>
            {state === 'awaiting-approval' ? (
              gate ? (
                <ApprovalPill gate={gate} hidden={hidden} className="tool-card-waiting" />
              ) : (
                <WaitingPill className="tool-card-waiting">{stateWords[state]}</WaitingPill>
              )
            ) : (
              stateWords[state]
            )}
          </StatusWords>
        </span>
      </>
    )
    // The tray turns red only for a high-risk request, a current Host's request without a risk included.
    const risk = gate === undefined ? '' : gate.kind === 'advisory' ? ' is-advisory' : gate.badge?.tone === 'err' ? ' is-r2' : ''
    return (
      <article
        className={`tool-card tool-${state} ${approval ? 'has-approval' : ''}${risk}`}
        data-open={open ? '' : undefined}
        data-tint={risk === ' is-r2' ? 'err' : undefined}
        data-secure={approval ? '' : undefined}
        data-approval-id={approval?.id}
        data-risk={approval?.advisory ? 'advisory' : approval?.risk}
        {...(message ? { 'data-message-id': message.id } : {})}>
        {approval ? (
          <div className="tool-card-header">{heading}</div>
        ) : (
          <div className="tool-tray">
            <button
              type="button"
              className="tool-card-header"
              aria-expanded={open}
              aria-controls={bodyId}
              title={title !== label.object ? title : undefined}
              onClick={() => {
                setChoice(!open)
              }}>
              {heading}
              <ChevronRight className="process-chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
            </button>
            <Collapse
              id={bodyId}
              open={open}
              lazy
              onReveal={() => {
                setChoice(true)
              }}>
              <div className="tool-card-body">
                <section>
                  <h4>参数</h4>
                  <ArgumentList text={tool?.input} covered={diffs.map(diff => diff.newText)} />
                </section>
                {evidence && (
                  <section>
                    <h4>变更</h4>
                    <DiffView diffs={diffs} />
                  </section>
                )}
                {showOutput && (
                  <section>
                    <div className="tool-section-head">
                      <h4>输出</h4>
                      {output && <CopyButton text={output} label="复制输出" size="xs" />}
                    </div>
                    {output ? (
                      <ToolOutput text={output} running={state === 'running'} />
                    ) : (
                      <p className="muted-line">{state === 'running' ? '执行中，结果返回后显示。' : '没有输出'}</p>
                    )}
                  </section>
                )}
              </div>
            </Collapse>
          </div>
        )}
        {/* Closed, the changes stay in view under the row; open, they are the paper's 变更 and this one folds away. */}
        {evidence && (
          <Collapse
            open={!open}
            lazy
            onReveal={() => {
              setChoice(false)
            }}>
            <DiffView diffs={diffs} />
          </Collapse>
        )}
        <ApprovalSlot approval={approval} gate={gate} title={title} diffs={diffs} hidden={hidden} busy={busy} onDecide={onDecide} />
      </article>
    )
  },
  (a, b) =>
    a.busy === b.busy
    && a.approval === b.approval
    && a.onDecide === b.onDecide
    && a.gateFor === b.gateFor
    && (a.message === b.message
      || (a.message !== null
        && b.message !== null
        && a.message.id === b.message.id
        && a.message.text === b.message.text
        && a.message.state === b.message.state
        && a.message.toolName === b.message.toolName
        && a.message.createdAt === b.message.createdAt
        && a.message.startedAt === b.message.startedAt
        && a.message.completedAt === b.message.completedAt
        && sameTool(a.message.tool, b.message.tool))),
)
