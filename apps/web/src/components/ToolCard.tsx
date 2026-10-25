import { memo, useId, useRef, useState } from 'react'
import { ChevronRight, CircleDashed, CircleSlash, TimerOff, TriangleAlert } from 'lucide-react'
import type { Approval, FileDiff, Message, ToolDecision, ToolDetail } from '@latch/protocol'
import {
  decisionLine,
  hasDiffs,
  ranDespite,
  shownToolOutput,
  shownToolState,
  toolDuration,
  toolHeading,
  toolLabel,
  unrunOutcome,
  type ShownToolState,
} from '../conversation.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { argumentView, formatDuration } from '../format.ts'
import { toolKind, toolKindIcons } from '../icons.tsx'
import { approvalActions, type ApprovalGate } from '../core/permissions.ts'
import { ApprovalPill, ApprovalSlot, approvalHidesText, type DecideHandler } from './ApprovalCard.tsx'
import { ArgumentList } from './ArgumentList.tsx'
import { DiffView } from './DiffView.tsx'
import { FileChip, FileRootContext } from './FileChip.tsx'
import { toolFileTargets, useKnownFiles } from './FileReferences.tsx'
import { CopyButton } from './ui.tsx'
import { DecisionRecord, DecisionWords } from './DecisionRecord.tsx'
import { Collapse, ICON_STROKE, StatusGlyph, StatusWords, WaitingPill } from '@latch/ui'
import { VisibleText } from './VisibleText.tsx'
import { useReportApprovalVisibility } from '../hooks/useApprovalsInView.ts'

type ToolState = NonNullable<Message['state']>
/**
 * Words for the states a row names; a running or finished tool says it through its verb and duration instead. A call
 * its approval kept from running is not a failure: it reads by its record (「已拒绝 · 14:32」) in the hint ink, never red.
 */
const stateWords: Partial<Record<ShownToolState, string>> = {
  'awaiting-approval': '待批准',
  failed: '失败',
  cancelled: '已取消',
  rejected: '已拒绝',
  expired: '已过期',
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
const sameDecision = (a: ToolDecision | undefined, b: ToolDecision | undefined) =>
  a === b || (a?.outcome === b?.outcome && a?.at === b?.at && a?.via === b?.via)
const sameTool = (a: ToolDetail | undefined, b: ToolDetail | undefined) =>
  a === b
  || (a !== undefined
    && b !== undefined
    && a.kind === b.kind
    && a.title === b.title
    && a.toolTitle === b.toolTitle
    && a.input === b.input
    && a.output === b.output
    && a.locations?.join('\n') === b.locations?.join('\n')
    && sameDiffs(a.diffs, b.diffs)
    && sameDecision(a.decision, b.decision))

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
 * the tense of its state with its object, the tool's ID when it has no title of its own, how long it ran and, when it
 * did not simply finish, its state. A decided approval folds into the row: a call its approval kept from running says
 * the record in the state slot, an allowed one keeps it in the tooltip, and a call an agent reports as run after a
 * rejection keeps its own state with one line that says so. Opening it (or a failure with output, which opens by itself) turns the row into a card on the column's edges,
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
    const card = useRef<HTMLElement>(null)
    // A waiting card says whether it is in view, so the bar above the input stays quiet while it is.
    useReportApprovalVisibility(card, approval?.id)
    const state: ToolState = message?.state ?? (approval ? 'awaiting-approval' : 'completed')
    const facts = message ? { ...message, state } : undefined
    // What the row says: a call its approval kept from running reads by how the approval ended. A call that started
    // keeps its own state whatever its record says (an agent's ask is advisory).
    const shown: ShownToolState = facts ? shownToolState(facts) : state
    const unrun = facts ? unrunOutcome(facts) : undefined
    const contradicted = facts ? ranDespite(facts) : undefined
    const decision = message?.tool?.decision
    const tool = message?.tool ?? approval?.tool
    const toolName = message?.toolName ?? approval?.toolName ?? ''
    const title = toolHeading(tool, toolName)
    const label = toolLabel({ tool, toolName, state })
    const KindIcon = toolKindIcons[toolKind({ tool, toolName })]
    const diffs = tool?.diffs ?? approval?.tool?.diffs ?? []
    const output = facts ? shownToolOutput(facts) : ''
    const failedWithOutput = shown === 'failed' && output.trim().length > 0
    const [choice, setChoice] = useState<boolean | null>(null)
    const open = approval ? true : (choice ?? failedWithOutput)
    // While an approval is open its panel shows the arguments and diff; otherwise the diff stays under the row. The diff
    // of a call its approval kept from running is no evidence of a change.
    const evidence = !approval && message !== null && hasDiffs(message) && unrun === undefined
    const showOutput = message !== null && state !== 'awaiting-approval' && state !== 'queued'
    const gate = approval ? gateFor(approval) : undefined
    // In the desktop app, the files a finished tool read or wrote become path chips once the Host says they are files.
    const input = argumentView(tool?.input)
    const folder = input.kind === 'entries' ? input.entries.find(([key]) => key === 'folder')?.[1] : undefined
    const rootId = folder && /^[A-Za-z0-9_-]{1,32}$/u.test(folder) ? folder : undefined
    const files = useKnownFiles(message ? toolFileTargets(message) : [], state === 'completed' || state === 'failed', rootId)
    const hidden = approval !== undefined && approvalHidesText(approval, title, diffs)
    const glyph =
      shown === 'failed' ? (
        <TriangleAlert className="process-failed" size={14} strokeWidth={ICON_STROKE[14]} />
      ) : shown === 'cancelled' || shown === 'rejected' ? (
        <CircleSlash size={14} strokeWidth={ICON_STROKE[14]} />
      ) : shown === 'expired' ? (
        <TimerOff size={14} strokeWidth={ICON_STROKE[14]} />
      ) : state === 'queued' ? (
        <CircleDashed size={14} strokeWidth={ICON_STROKE[14]} />
      ) : (
        <KindIcon size={14} strokeWidth={ICON_STROKE[14]} />
      )
    // A state change the page saw happen: the comet and the result icon cross-fade and the new words rise in.
    const heading = (
      <>
        <StatusGlyph className="tool-card-icon process-slot" running={state === 'running'} state={shown}>
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
        {/* The approver weighs a tool's own title against its ID; a row of a titled tool keeps the ID in its tooltip. */}
        {toolName && toolName !== (approval ? title : label.object) && (approval || !tool?.toolTitle) && (
          <code className="tool-card-name">
            <VisibleText text={toolName} />
          </code>
        )}
        <span className="process-fill" />
        <span className="process-end">
          {message && <ToolTime message={message} />}
          <StatusWords state={shown} className={`tool-card-state state-${shown}`}>
            {state === 'awaiting-approval' ? (
              gate ? (
                <ApprovalPill gate={gate} hidden={hidden} className="tool-card-waiting" />
              ) : (
                <WaitingPill className="tool-card-waiting">{stateWords[state]}</WaitingPill>
              )
            ) : unrun && decision ? (
              <DecisionWords decision={decision} />
            ) : (
              stateWords[shown]
            )}
          </StatusWords>
        </span>
      </>
    )
    // The row's tooltip: the call's full heading when the row shortens it, a titled tool's ID, and an allowance's record.
    const tooltip = [
      title !== label.object ? title : undefined,
      tool?.toolTitle && toolName && toolName !== label.object ? toolName : undefined,
      decision?.outcome === 'allowed' ? decisionLine(decision, 0).full : undefined,
    ]
      .filter(Boolean)
      .join('\n')
    // The tray turns red only for a high-risk request, a current Host's request without a risk included.
    const risk = gate === undefined ? '' : gate.kind === 'advisory' ? ' is-advisory' : gate.badge?.tone === 'err' ? ' is-r2' : ''
    return (
      <FileRootContext.Provider value={rootId}>
        <article
          ref={card}
          className={`tool-card tool-${shown} ${approval ? 'has-approval' : ''}${risk}`}
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
                title={tooltip || undefined}
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
                  {files.length > 0 && (
                    <section>
                      <h4>文件</h4>
                      <p className="tool-files">
                        {files.map(path => (
                          <FileChip key={path} path={path} />
                        ))}
                      </p>
                    </section>
                  )}
                  <section>
                    <h4>参数</h4>
                    <ArgumentList text={tool?.input} covered={evidence ? diffs.map(diff => diff.newText) : []} />
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
          {/* A call the agent reports as run after it was not allowed: one line under the row says so. */}
          {contradicted && <DecisionRecord decision={contradicted} />}
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
      </FileRootContext.Provider>
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
