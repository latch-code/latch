import { useLayoutEffect, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { ArrowUp, LockKeyhole, ShieldAlert, Square } from 'lucide-react'
import type { PlanEntry } from '../../shared/types.ts'
import type { PendingSubmission } from '../api.ts'
import { formatElapsed } from '../format.ts'
import { ICON_STROKE, Spinner } from '../icons.tsx'
import type { SendKey } from '../preferences.ts'
import { PlanCard } from './PlanCard.tsx'
import { InlineAlert } from './ui.tsx'

export interface RunState {
  label: string
  /** Milliseconds since this page saw the run start; absent when unknown. */
  elapsed?: number
  approvals: number
  onRevealApprovals: () => void
  cancel: 'idle' | 'cancelling' | 'uncertain'
  onCancel: () => void
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
  plan,
  readOnly,
  notice,
}: {
  textareaRef: RefObject<HTMLTextAreaElement>
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
  plan?: PlanEntry[]
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
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      {pending !== null && !sending && (
        <div className="pending-submission" role="status">
          <div>
            <strong>有一条待确认的提交</strong>
            <p>{pending.prompt}</p>
          </div>
          <button type="button" className="button secondary" onClick={onRetry}>
            重试这次提交
          </button>
        </div>
      )}
      {plan && plan.length > 0 && <PlanCard plan={plan} />}
      <form
        className={`composer ${run ? 'is-running' : ''}`}
        onSubmit={event => {
          event.preventDefault()
          if (sendable) onSubmit()
        }}>
        {run && (
          <div className={`run-bar ${run.approvals > 0 ? 'is-waiting' : ''}`}>
            {run.approvals > 0 ? (
              <>
                <ShieldAlert size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                <span role="status">{run.approvals} 项待批准</span>
                <button type="button" className="run-bar-action" onClick={run.onRevealApprovals}>
                  查看
                </button>
              </>
            ) : (
              <>
                <Spinner size={14} />
                <span role="status">
                  {run.cancel === 'cancelling'
                    ? '正在取消，等待执行端确认'
                    : run.cancel === 'uncertain'
                      ? '取消结果尚未确认，可重试'
                      : run.label}
                </span>
                {run.elapsed !== undefined && (
                  <span className="run-bar-time" aria-hidden="true">
                    {formatElapsed(run.elapsed)}
                  </span>
                )}
              </>
            )}
          </div>
        )}
        {readOnly !== undefined ? (
          <p className="composer-readonly" role="note">
            <LockKeyhole size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
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
              {run.cancel === 'cancelling' ? (
                <Spinner size={14} />
              ) : (
                <Square size={12} strokeWidth={2.5} fill="currentColor" aria-hidden="true" />
              )}
            </button>
          ) : (
            <button type="submit" className="send-button" aria-label="发送" title={blockReason ?? shortcut} disabled={!sendable}>
              {sending ? <Spinner size={16} /> : <ArrowUp size={18} strokeWidth={2} aria-hidden="true" />}
            </button>
          )}
        </div>
      </form>
      {notice && readOnly === undefined && (
        <p className="composer-notice" role="note">
          <ShieldAlert size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {notice}
        </p>
      )}
    </div>
  )
}
