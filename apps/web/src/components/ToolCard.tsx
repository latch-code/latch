import { memo, useId, useState } from 'react'
import { ChevronRight, LockKeyhole, ShieldAlert } from 'lucide-react'
import type { Approval, FileDiff, Message, ToolDetail } from '@latch/protocol'
import { previousState } from '../diff.ts'
import { argumentView, relativeTime } from '../format.ts'
import { toolKind, toolKindIcons, toolStateIcons } from '../icons.tsx'
import { approvalActions, type ApprovalGate } from '../core/permissions.ts'
import { DiffView, PREVIOUS_NOTES } from './DiffView.tsx'
import { Button, ICON_STROKE, StatusGlyph, StatusPill, StatusWords, WaitingPill } from '@latch/ui'
import { hasHiddenCharacters, VisibleText } from './VisibleText.tsx'

type ToolState = NonNullable<Message['state']>
const stateLabels: Record<ToolState, string> = {
  queued: '等待执行',
  'awaiting-approval': '待批准',
  running: '执行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
}

export type DecideHandler = (approval: Approval, decision: 'allow' | 'reject', optionId: string | undefined) => void
/** This device's buttons for an approval; the default keeps every offered option (a Host without device scopes). */
export type ApprovalGateFor = (approval: Approval) => ApprovalGate
const plainGate: ApprovalGateFor = approval => approvalActions(approval, null, null)

/** `covered`: argument values another view already shows in full, such as a diff's new file text. */
export function ArgumentList({ text, covered = [] }: { text?: string; covered?: string[] }) {
  const view = argumentView(text)
  if (view.kind === 'empty') return <p className="muted-line">无参数</p>
  if (view.kind === 'text')
    return (
      <pre className="tool-pre">
        <VisibleText text={view.text} />
      </pre>
    )
  const entries = view.entries.filter(([, value]) => !covered.includes(value))
  if (entries.length === 0) return <p className="muted-line">内容见变更</p>
  return (
    <dl className="argument-list">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>
            <VisibleText text={key} />
          </dt>
          <dd>
            <pre>
              <VisibleText text={value} />
            </pre>
          </dd>
        </div>
      ))}
    </dl>
  )
}

export const HIDDEN_CHARACTERS_TEXT = '内容包含不可见或改变显示方向的字符，已用 \\u{…} 标出。请仔细核对后再决定。'

/** Whether any text the approver reviews hides characters (see VisibleText). */
function approvalHidesText(approval: Approval, title: string, diffs: FileDiff[]): boolean {
  return (
    [title, approval.toolName, approval.reason, approval.tool?.input ?? approval.arguments].some(text => hasHiddenCharacters(text))
    || diffs.some(diff => hasHiddenCharacters(diff.path) || hasHiddenCharacters(diff.newText) || hasHiddenCharacters(diff.oldText))
  )
}

function ApprovalPanel({
  approval,
  gate,
  title,
  diffs,
  busy,
  onDecide,
}: {
  approval: Approval
  gate: ApprovalGate
  title: string
  diffs: FileDiff[]
  busy: string | undefined
  onDecide: DecideHandler
}) {
  const options = [...gate.options].sort(
    (a, b) =>
      Number(a.kind.startsWith('allow')) - Number(b.kind.startsWith('allow'))
      || Number(a.kind === 'allow_once') - Number(b.kind === 'allow_once'),
  )
  const hidden = approvalHidesText(approval, title, diffs)
  // The gate's high-risk path (R2, or a current Host that sent no risk). Its card carries no blue: allowing opens the
  // local confirmation, which is where the strong visual belongs.
  const highRisk = gate.badge?.tone === 'err'
  // One line per kind of previous content the reviewer cannot see.
  const previousNotes = (['unavailable', 'unknown'] as const)
    .filter(state => diffs.some(diff => previousState(diff) === state))
    .map(state => PREVIOUS_NOTES[state]!)
  return (
    <section
      className="approval-panel"
      data-approval-id={approval.id}
      data-risk={approval.advisory ? 'advisory' : approval.risk}
      aria-label="待批准操作">
      <div className="approval-heading">
        <ShieldAlert size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
        <span>需要你批准</span>
        {gate.badge && <StatusPill tone={gate.badge.tone}>{gate.badge.label}</StatusPill>}
        <time dateTime={approval.requestedAt}>{relativeTime(approval.requestedAt)}</time>
      </div>
      {gate.note && <p className="approval-note">{gate.note}</p>}
      {hidden && (
        <p className="approval-warning" role="note">
          {HIDDEN_CHARACTERS_TEXT}
        </p>
      )}
      {previousNotes.map(note => (
        <p key={note} className="approval-warning" role="note">
          {note}
        </p>
      ))}
      {approval.reason && approval.reason !== title && (
        <p className="approval-reason">
          <VisibleText text={approval.reason} />
        </p>
      )}
      <ArgumentList text={approval.tool?.input ?? approval.arguments} covered={diffs.map(diff => diff.newText)} />
      <DiffView diffs={diffs} />
      {gate.hint && (
        <p className="approval-hint">
          <LockKeyhole size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          {gate.hint}
        </p>
      )}
      <div className="approval-actions">
        {options.map(option => {
          const allow = option.kind.startsWith('allow')
          const pressed = busy === option.id
          // Hidden characters leave no allow option as the default-looking choice.
          return (
            <Button
              key={option.id}
              variant={option.kind === 'allow_once' && !hidden && !highRisk ? 'primary' : 'secondary'}
              icon={highRisk && allow ? LockKeyhole : undefined}
              loading={pressed}
              disabled={busy !== undefined && !pressed}
              onClick={() => {
                onDecide(approval, allow ? 'allow' : 'reject', gate.explicit ? option.id : undefined)
              }}>
              {option.label}
            </Button>
          )
        })}
      </div>
    </section>
  )
}

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
    && sameDiffs(a.diffs, b.diffs))

/**
 * One tool call. A pending approval for this call grows the same card instead of
 * repeating the tool, so the decision sits next to what it authorizes.
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
    const [expanded, setExpanded] = useState(false)
    const bodyId = useId()
    const state: ToolState = message?.state ?? (approval ? 'awaiting-approval' : 'completed')
    const tool = message?.tool ?? approval?.tool
    const toolName = message?.toolName ?? approval?.toolName ?? ''
    const title = tool?.title || toolName || '工具调用'
    const KindIcon = toolKindIcons[toolKind({ tool, toolName })]
    const StateIcon = toolStateIcons[state]
    const diffs = tool?.diffs ?? approval?.tool?.diffs ?? []
    const output = message?.tool?.output ?? message?.text ?? ''
    // While an approval is open its panel shows the arguments and diff; the body adds only output.
    const showOutput = message !== null && state !== 'awaiting-approval' && state !== 'queued'
    const hasBody = !approval || showOutput
    // A state change the page saw happen: the comet and the result icon cross-fade and the state's words rise in.
    const heading = (
      <>
        <StatusGlyph className="tool-card-icon" running={state === 'running'} size={14}>
          <KindIcon size={16} strokeWidth={ICON_STROKE[16]} />
        </StatusGlyph>
        <span className="tool-card-title">
          <VisibleText text={title} />
        </span>
        {toolName && toolName !== title && (
          <code className="tool-card-name">
            <VisibleText text={toolName} />
          </code>
        )}
        <StatusWords state={state} className={`tool-card-state state-${state}`}>
          {state === 'awaiting-approval' ? (
            <WaitingPill className="tool-card-waiting">{stateLabels[state]}</WaitingPill>
          ) : (
            <>
              {state !== 'running' && state !== 'completed' && <StateIcon size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />}
              {stateLabels[state]}
            </>
          )}
        </StatusWords>
      </>
    )
    const risk =
      approval === undefined
        ? ''
        : approval.advisory
          ? ' is-advisory'
          : approval.risk === 'R1'
            ? ''
            : approval.risk === 'R2'
              ? ' is-r2'
              : ''
    return (
      <article
        className={`tool-card tool-${state} ${approval ? 'has-approval' : ''}${risk}`}
        data-tint={risk === ' is-r2' ? 'err' : undefined}
        {...(message ? { 'data-message-id': message.id } : {})}>
        {hasBody ? (
          <button
            type="button"
            className="tool-card-header"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => {
              setExpanded(!expanded)
            }}>
            {heading}
            <ChevronRight className="chevron" size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
          </button>
        ) : (
          <div className="tool-card-header">{heading}</div>
        )}
        {expanded && hasBody && (
          <div className="tool-card-body" id={bodyId}>
            {!approval && (
              <section>
                <h4>参数</h4>
                <ArgumentList text={tool?.input} covered={diffs.map(diff => diff.newText)} />
              </section>
            )}
            {!approval && diffs.length > 0 && (
              <section>
                <h4>变更</h4>
                <DiffView diffs={diffs} />
              </section>
            )}
            {showOutput && (
              <section>
                <h4>输出</h4>
                {output ? (
                  <pre className="tool-pre tool-output">
                    <VisibleText text={output} />
                  </pre>
                ) : (
                  <p className="muted-line">{state === 'running' ? '执行中，结果返回后显示。' : '没有输出'}</p>
                )}
              </section>
            )}
          </div>
        )}
        {approval && (
          <ApprovalPanel approval={approval} gate={gateFor(approval)} title={title} diffs={diffs} busy={busy} onDecide={onDecide} />
        )}
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
        && sameTool(a.message.tool, b.message.tool))),
)
