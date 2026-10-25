import { useLayoutEffect, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { ArrowUp, LockKeyhole, RotateCcw, ShieldAlert } from 'lucide-react'
import type { PlanEntry } from '@latch/protocol'
import type { PendingSubmission } from '../core/api.ts'
import type { SendKey } from '../preferences.ts'
import { PlanChip } from './PlanCard.tsx'
import { Button, Collapse, ICON_STROKE, InlineNotice, Spinner } from '@latch/ui'

/**
 * What a running session's bar above the input carries: only what can be acted on. What the run is doing and for how
 * long is said in the conversation (the latest turn's live line), so the bar has no running label.
 */
export interface RunState {
  approvals: number
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
 * The input stays editable while a run is active so the next message can be
 * drafted; sending waits until the run settles because the Host has no queue.
 */
export function Composer({
  textareaRef,
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
  notice,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  variant: 'new' | 'session'
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
  /** A note under the input about what sending will involve, such as a local confirmation. */
  notice?: string
}) {
  useLayoutEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight + 2, MAX_TEXTAREA)}px`
  }, [draft, textareaRef])

  const locked = sending || pending !== null
  const sendable = canSend && !locked && draft.trim().length > 0 && !run && readOnly === undefined
  const keydown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return
    const explicit = event.metaKey || event.ctrlKey
    if (!explicit && (event.shiftKey || event.altKey || coarse || sendKey !== 'enter')) return
    event.preventDefault()
    if (sendable) onSubmit()
  }
  const shortcut = sendKey === 'enter' && !coarse ? 'Enter 发送 · Shift+Enter 换行' : `${isMac() ? '⌘' : 'Ctrl'} Enter 发送`
  return (
    <div className={`composer-stack composer-${variant}`}>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {pending !== null && !sending && (
        <div className="pending-submission" data-tint="warn" role="status">
          <div>
            <strong>有一条待确认的提交</strong>
            <p>{pending.prompt}</p>
          </div>
          <Button onClick={onRetry}>重试这次提交</Button>
        </div>
      )}
      <form
        className={`composer ${run ? 'is-running' : ''}`}
        onSubmit={event => {
          event.preventDefault()
          if (sendable) onSubmit()
        }}>
        <RunBar run={run} />
        {readOnly !== undefined ? (
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
            rows={variant === 'new' ? 3 : 1}
            disabled={locked}
            onChange={event => {
              onDraft(event.target.value)
            }}
            onKeyDown={keydown}
          />
        )}
        <div className="composer-toolbar">
          <div className="composer-controls">{controls}</div>
          {readOnly !== undefined && !run ? null : run ? (
            <button
              type="button"
              className="send-button stop-button"
              aria-label="取消任务"
              title={run.cancel === 'uncertain' ? '重试取消' : run.cancel === 'cancelling' ? '正在取消…' : '停止'}
              disabled={run.cancel === 'cancelling'}
              onClick={run.onCancel}>
              {run.cancel === 'cancelling' ? <Spinner size={14} /> : <span className="stop-glyph" aria-hidden="true" />}
            </button>
          ) : (
            <button type="submit" className="send-button" aria-label="发送" title={blockReason ?? shortcut} disabled={!sendable}>
              {sending ? <Spinner size={16} /> : <ArrowUp size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />}
            </button>
          )}
        </div>
      </form>
      {notice && readOnly === undefined && (
        <p className="composer-notice" role="note">
          <ShieldAlert size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          {notice}
        </p>
      )}
    </div>
  )
}

/**
 * The bar on top of the input while a session runs, when it has something to act on: the plan chip, approvals out of
 * view (amber, 「1 项待批准 · 查看」) and the stop's own states. With nothing to say it folds away (its height animates
 * with the disclosure, which the reading position follows as a resize).
 */
function RunBar({ run }: { run?: RunState }) {
  const approvals = run?.approvals ?? 0
  const stopping = run?.cancel === 'cancelling'
  const uncertain = run?.cancel === 'uncertain'
  const plan = run?.plan?.length ? run.plan : undefined
  const shown = run !== undefined && (approvals > 0 || stopping || uncertain || plan !== undefined)
  return (
    <Collapse open={shown} className="run-bar-collapse">
      <div className={`run-bar ${approvals > 0 && !stopping && !uncertain ? 'is-waiting' : ''}`}>
        {approvals > 0 && !stopping && !uncertain ? (
          <>
            <ShieldAlert size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            <span role="status">{approvals} 项待批准</span>
            <button type="button" className="run-bar-action" onClick={run?.onRevealApprovals}>
              查看
            </button>
          </>
        ) : stopping ? (
          <span role="status" className="run-bar-status">
            正在停止…
          </span>
        ) : uncertain ? (
          <>
            <span role="status" className="run-bar-status">
              停止结果尚未确认
            </span>
            <button type="button" className="run-bar-action" onClick={run?.onCancel}>
              <RotateCcw size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
              重试
            </button>
          </>
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
