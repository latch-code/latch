import { useEffect, useRef, useState } from 'react'

import type { HarnessLogin, KeepWaitingResult, TaskDetail } from '@latch/protocol'
import { Button, ICON_STROKE, Icon, AlertGlyph, WarningGlyph } from '@latch/ui'
import { runEndLine, runStatus, type RunStatus } from '../conversation.ts'
import { api } from '../core/api.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { HarnessLoginSteps } from '../components/HarnessLogin.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { messageTime } from '../format.ts'

/** The words change at most once a second; waiting on a person and stopping do not wait for that. */
function useHeldStatus(status: RunStatus): RunStatus {
  const [shown, setShown] = useState(status)
  const latest = useRef(status)
  latest.current = status
  const key = `${status.tone}\n${status.text}`
  const shownKey = `${shown.tone}\n${shown.text}`
  const urgent = status.tone !== 'plain' || status.text === '正在停止…'
  useEffect(() => {
    if (key === shownKey) return undefined
    const timer = setTimeout(
      () => {
        setShown(latest.current)
      },
      urgent ? 0 : 1000,
    )
    return () => {
      clearTimeout(timer)
    }
  }, [key, shownKey, urgent])
  return key === shownKey ? status : shown
}

export interface StatusLineProps {
  detail: TaskDetail
  harness: string
  cancelling: boolean
  approvals: number
  fallbackElapsed?: number
  /** The connection is down: nothing is known to move, so the line says when it last knew. */
  frozenAt?: number
  onStop?: () => void
  onView?: (messageId: string) => void
  onError?: (error: unknown) => void
}

/**
 * The line under a running turn. It names what really runs, and asks only when the run has gone quiet; waiting on the
 * person it says nothing, because the card that waits already does.
 */
export function StatusLine({
  detail,
  harness,
  cancelling,
  approvals,
  fallbackElapsed,
  frozenAt,
  onStop,
  onView,
  onError,
}: StatusLineProps) {
  useTicker(frozenAt === undefined ? 'second' : false)
  const status = useHeldStatus(
    runStatus(detail, {
      cancelling,
      approvals,
      hostNow: hostNow(),
      harness,
      ...(fallbackElapsed !== undefined ? { fallbackElapsed } : {}),
    }),
  )
  const [waiting, setWaiting] = useState(false)
  if (frozenAt !== undefined) return <p className="status-line is-frozen">上次确认 {messageTime(frozenAt, frozenAt)}</p>
  if (status.tone === 'quiet') {
    return (
      <p role="status" aria-live="polite" className="sr-only">
        {status.text}
      </p>
    )
  }
  const live = detail.summary.live
  return (
    <div className={`status-line is-${status.tone}`}>
      {status.tone === 'amber' && <Icon icon={WarningGlyph} size={14} />}
      <span role="status" aria-live="polite">
        <VisibleText text={status.text} />
      </span>
      {status.clock && (
        <span className="status-clock" aria-hidden="true">
          · {status.clock}
        </span>
      )}
      {status.viewMessageId && (
        <button
          type="button"
          className="status-view"
          onClick={() => {
            onView?.(status.viewMessageId!)
          }}>
          查看
        </button>
      )}
      {status.actions?.includes('keep-waiting') && live && live.silenceThresholdMs !== undefined && (
        <Button
          size="xs"
          variant="secondary"
          loading={waiting}
          onClick={() => {
            setWaiting(true)
            // A retry is safe: the Host answers `unchanged` once the threshold has moved.
            void api<KeepWaitingResult>(`tasks/${encodeURIComponent(detail.summary.id)}/keep-waiting`, {
              method: 'POST',
              body: { runId: live.runId, thresholdMs: live.silenceThresholdMs },
            })
              .catch((error: unknown) => {
                onError?.(error)
              })
              .finally(() => {
                setWaiting(false)
              })
          }}>
          继续等
        </Button>
      )}
      {status.actions?.includes('stop') && onStop && (
        <Button size="xs" variant="secondary" onClick={onStop}>
          停止
        </Button>
      )}
    </div>
  )
}

/**
 * The line that stays under a turn whose run ended without a plain answer: what happened, what nobody can vouch for, and
 * what to do about it.
 */
export function RunEndNote({
  summary,
  harness,
  onRetry,
  onContinue,
  login,
}: {
  summary: TaskDetail['summary']
  harness: string
  onRetry?: () => void
  onContinue?: () => void
  /** How to log in, when this run ended for want of it. */
  login?: { harnessId: string; login: HarnessLogin; terminal: boolean } | undefined
}) {
  const line = runEndLine(summary, harness)
  if (!line) return null
  return (
    <div className={`run-end is-${line.tone}`}>
      <div className="run-end-line">
        <AlertGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        <span>{line.text}</span>
        {line.retry && onRetry && (
          <Button size="xs" variant="secondary" onClick={onRetry}>
            重试
          </Button>
        )}
        {onContinue && summary.runEnd?.reason !== 'login-required' && (
          <Button size="xs" variant="secondary" onClick={onContinue}>
            在新会话中继续
          </Button>
        )}
      </div>
      {/* Without a command the turn's own note already says how to sign in. */}
      {summary.runEnd?.reason === 'login-required' && login && (login.login.command !== undefined || login.login.methods) && (
        <HarnessLoginSteps {...login} />
      )}
      {line.unknown.length > 0 && (
        <ul className="run-end-list">
          {line.unknown.map(name => (
            <li key={name}>
              <VisibleText text={name} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
