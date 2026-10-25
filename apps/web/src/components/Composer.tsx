import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { ArrowUp, LockKeyhole } from 'lucide-react'
import type { PlanEntry, PromptTemplate, SessionCommand } from '@latch/protocol'
import type { PendingSubmission } from '../core/api.ts'
import type { SendKey } from '../preferences.ts'
import { DECISION_COPY } from '../core/securityCopy.ts'
import { SlashCommands } from './SlashCommands.tsx'
import { PlanChip } from './PlanCard.tsx'
import { VisibleText } from './VisibleText.tsx'
import { Button, Collapse, Comet, ICON_STROKE, InlineNotice, MOTION, Spinner, Swap, Tooltip, useLiveChange } from '@latch/ui'

/**
 * What a running session's bar above the input carries: only what can be acted on. What the run is doing and for how
 * long is said in the conversation (the latest turn's live line), so the bar has no running label.
 */
export interface RunState {
  approvals: number
  /** A waiting request's card is in view in the conversation, where it says so itself: the bar stays quiet. */
  approvalsInView?: boolean
  /** What the oldest waiting request would do, 「写入 docs/notes.md」. */
  approvalTitle?: string
  onRevealApprovals: () => void
  cancel: 'idle' | 'cancelling' | 'uncertain'
  onCancel: () => void
  /** The harness's latest plan, as a chip that opens the list. */
  plan?: PlanEntry[]
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** Ten lines of body text plus padding; the transcript keeps the remaining height. */
const MAX_TEXTAREA = 292

/**
 * The message input, on the new-session page and docked under a conversation. The input stays editable while a run
 * is active so the next message can be drafted; sending waits until the run settles because the Host has no queue.
 * Its ring turns line-strong with focus inside, never blue. The send slot is the one blue control: an arrow (a neutral
 * fill while there is nothing to send, still focusable with its reason as its tooltip), or, for a session that needs
 * the local confirmation to start, a button that says so. While a run is active the slot is the stop button, which is
 * never red. A device that may only watch sees a dashed, sunken frame with a lock and the reason instead of the
 * input; the bar above it and the stop button stay.
 */
export function Composer({
  textareaRef,
  commands,
  templates,
  variant,
  label,
  placeholder,
  draft,
  onDraft,
  pending,
  sending,
  error,
  onRetry,
  canSend,
  blockReason,
  onSubmit,
  sendKey,
  coarse,
  controls,
  run,
  readOnly,
  hint,
  answer,
  confirmStart,
  below,
  inline = false,
  confirmation,
}: {
  templates?: PromptTemplate[]
  commands?: SessionCommand[]
  textareaRef: RefObject<HTMLTextAreaElement | null>
  variant: 'new' | 'session' | 'sheet'
  label: string
  placeholder: string
  draft: string
  onDraft: (value: string) => void
  pending: PendingSubmission | null
  sending: boolean
  error: string
  onRetry: () => void
  canSend: boolean
  blockReason?: string
  onSubmit: () => void
  sendKey: SendKey
  coarse: boolean
  controls: ReactNode
  run?: RunState
  /** This device may watch, reject and cancel but not type: the text replaces the input. */
  readOnly?: string
  /** A plain line under the input, such as where the text will go after 拒绝. */
  hint?: string
  /**
   * The input answers an approval (「告诉 Agent 改做什么」 after 拒绝): sending works while the run waits and with no text,
   * the button reads `label`, and Esc leaves it without deciding.
   */
  answer?: { label: string; onSubmit: () => void; onCancel: () => void }
  /** Sending starts a session that the local confirmation must allow first: the slot says so in words. */
  confirmStart?: string
  /** Under the input, outside its frame: the context row and captions of a new session. */
  below?: ReactNode
  /** Phone session: input and action share a row; options sit above it. */
  inline?: boolean
  /** The local confirmation a send starts, shown above the input (InlineConfirm). */
  confirmation?: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  // The input grows with its content a line at a time, up to ten lines, its height moving over 120ms (composer.css).
  // Measuring needs the height let go for a moment; it is put back without a transition, so the move then starts from
  // the height the input had and not from the measurement.
  useLayoutEffect(() => {
    const element = textareaRef.current
    if (!element) return
    const from = element.style.height
    element.style.transition = 'none'
    element.style.height = 'auto'
    const next = `${Math.min(element.scrollHeight + 2, MAX_TEXTAREA)}px`
    element.style.height = from
    if (from && from !== next) element.getBoundingClientRect()
    element.style.removeProperty('transition')
    element.style.height = next
  }, [draft, textareaRef])

  const locked = sending || pending !== null
  const empty = draft.trim().length === 0
  const sendable = !locked && readOnly === undefined && (answer !== undefined || (canSend && !empty && !run))
  const submit = answer?.onSubmit ?? onSubmit
  const keydown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (answer && event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      answer.onCancel()
      return
    }
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return
    const explicit = event.metaKey || event.ctrlKey
    if (!explicit && (event.shiftKey || event.altKey || coarse || sendKey !== 'enter')) return
    event.preventDefault()
    if (sendable) submit()
  }
  const shortcut = sendKey === 'enter' && !coarse ? 'Enter' : `${isMac() ? '⌘' : 'Ctrl'} Enter`
  const sendTip = blockReason ?? (locked ? '等待这次提交完成' : empty ? '输入内容后发送' : undefined)

  // The slot's control swaps in (from 90%, fading in) when the page sees it change: a run starting or ending, or a
  // harness chosen that starts with the local confirmation.
  const slot = answer ? 'answer' : run ? 'stop' : readOnly !== undefined ? 'none' : confirmStart !== undefined ? 'start' : 'send'
  useLiveChange(slot, (_previous, live) => {
    const element = box.current?.querySelector<HTMLElement>('.composer-slot > *')
    if (live && element)
      element.animate(
        [
          { opacity: 0, transform: 'scale(0.9)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: MOTION.fast, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
      )
  })

  const input =
    readOnly !== undefined ? (
      <p className="composer-readonly" role="note">
        <LockKeyhole size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        <span>{readOnly}</span>
      </p>
    ) : (
      <textarea
        ref={textareaRef}
        aria-label={label}
        placeholder={placeholder}
        value={draft}
        rows={variant === 'sheet' ? 5 : variant === 'new' ? 3 : 1}
        disabled={locked}
        onChange={event => {
          onDraft(event.target.value)
        }}
        onKeyDown={keydown}
      />
    )
  const action = (
    <div className="composer-slot">
      {answer ? (
        <span className="composer-answer">
          <Button size="sm" variant="ghost" onClick={answer.onCancel}>
            {DECISION_COPY.noteCancel}
          </Button>
          <Button type="submit" size="sm" variant="secondary" disabled={!sendable}>
            {answer.label}
          </Button>
        </span>
      ) : run ? (
        <StopButton run={run} />
      ) : readOnly !== undefined ? null : confirmStart !== undefined ? (
        <Button
          type="submit"
          variant="primary"
          size="md"
          icon={LockKeyhole}
          className="start-button"
          loading={sending}
          disabled={!sendable}
          tooltip={sendTip}
          shortcut={sendTip === undefined ? shortcut : undefined}>
          {confirmStart}
        </Button>
      ) : (
        <Tooltip content={sendTip ?? '发送'} shortcut={sendTip === undefined ? shortcut : undefined} describe={sendTip !== undefined}>
          <button
            type="submit"
            className="send-button"
            aria-label="发送"
            aria-disabled={!sendable || undefined}
            aria-busy={sending || undefined}
            onClick={event => {
              if (!sendable) event.preventDefault()
            }}>
            <Swap value={sending ? 'sending' : 'idle'}>
              {sending ? <Spinner size={16} /> : <ArrowUp size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />}
            </Swap>
          </button>
        </Tooltip>
      )}
    </div>
  )

  return (
    <div className={`composer-stack composer-${variant}`} ref={box}>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {confirmation}
      {pending !== null && !sending && (
        <div className="pending-submission" data-tint="warn" role="status">
          <div>
            <strong>有一条待确认的提交</strong>
            <p>{pending.prompt}</p>
          </div>
          <Button onClick={onRetry}>重试这次提交</Button>
        </div>
      )}
      {inline && <div className="composer-above">{controls}</div>}
      <form
        className={`composer ${run ? 'is-running' : ''}`}
        data-inline={inline ? '' : undefined}
        data-variant={readOnly !== undefined ? 'read-only' : undefined}
        onSubmit={event => {
          event.preventDefault()
          if (sendable) submit()
        }}>
        <RunBar run={run} />
        {((commands?.length ?? 0) > 0 || (templates?.length ?? 0) > 0) && !locked && readOnly === undefined && (
          <SlashCommands
            draft={draft}
            commands={commands ?? []}
            templates={templates}
            onDraft={value => {
              onDraft(value)
              textareaRef.current?.focus({ preventScroll: true })
            }}
          />
        )}
        {inline ? (
          <div className="composer-row">
            {input}
            {action}
          </div>
        ) : (
          input
        )}
        {!inline && variant !== 'sheet' && (
          <div className="composer-toolbar">
            <div className="composer-controls">{controls}</div>
            {action}
          </div>
        )}
      </form>
      {below}
      {hint && readOnly === undefined && (
        <p className="composer-hint" role="note">
          {hint}
        </p>
      )}
    </div>
  )
}

/**
 * Stop, in the send slot while a run is active: a raised circle with a line-strong edge and a filled square. While
 * the stop is being confirmed it turns and takes no presses. When its outcome is unknown it stays the square and stops
 * again when pressed; the bar above says so, with 重试, once.
 */
function StopButton({ run }: { run: RunState }) {
  const cancelling = run.cancel === 'cancelling'
  return (
    <Tooltip content={cancelling ? '正在停止…' : '停止'} describe={false}>
      <button
        type="button"
        className="send-button stop-button"
        aria-label="停止"
        aria-disabled={cancelling || undefined}
        aria-busy={cancelling || undefined}
        onClick={() => {
          if (!cancelling) run.onCancel()
        }}>
        <Swap value={cancelling ? 'cancelling' : 'idle'}>
          {cancelling ? <Spinner size={14} /> : <span className="stop-glyph" aria-hidden="true" />}
        </Swap>
      </button>
    </Tooltip>
  )
}

/**
 * The bar on top of the input while a session runs, when it has something to act on: approvals waiting while none of
 * their cards is in view (amber, 「1 项待批准 · 写入 docs/notes.md」 and 查看), the stop's own states (正在停止… with the
 * running comet; 尚未确认 with 重试) and the plan chip. With nothing to say it folds away (its height animates with the
 * disclosure, which the reading position follows as a resize).
 */
function RunBar({ run }: { run?: RunState }) {
  const approvals = run?.approvals ?? 0
  const stopping = run?.cancel === 'cancelling'
  const uncertain = run?.cancel === 'uncertain'
  const waiting = approvals > 0 && run?.approvalsInView !== true && !stopping && !uncertain
  const plan = run?.plan?.length ? run.plan : undefined
  const shown = run !== undefined && (waiting || stopping || uncertain || plan !== undefined)
  return (
    <Collapse open={shown} className="run-bar-collapse">
      <div className={`run-bar ${waiting ? 'is-waiting' : ''}`}>
        {waiting ? (
          <>
            <span className="run-bar-what">
              <span role="status" className="run-bar-status">
                {approvals} 项待批准
              </span>
              {run?.approvalTitle && (
                <>
                  <span className="run-bar-dot" aria-hidden="true">
                    ·
                  </span>
                  <span className="run-bar-detail">
                    <VisibleText text={run.approvalTitle} />
                  </span>
                </>
              )}
            </span>
            <button type="button" className="run-bar-action" onClick={run?.onRevealApprovals}>
              查看
            </button>
          </>
        ) : stopping ? (
          <span className="run-bar-what">
            <Comet size={12} />
            <span role="status" className="run-bar-status">
              正在停止…
            </span>
          </span>
        ) : uncertain ? (
          <span className="run-bar-what">
            <span role="status" className="run-bar-status">
              <span className="sr-only">停止</span>
              尚未确认
            </span>
            <span className="run-bar-dot" aria-hidden="true">
              ·
            </span>
            <button type="button" className="run-bar-action" onClick={run?.onCancel}>
              重试
            </button>
          </span>
        ) : null}
        {plan && (
          <span className="run-bar-end">
            <PlanChip plan={plan} />
          </span>
        )}
      </div>
    </Collapse>
  )
}
