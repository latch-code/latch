import { useEffect, useRef, useState } from 'react'

import type { HarnessLogin, KeepWaitingResult, TaskDetail } from '@latch/protocol'
import { Button, ICON_STROKE, Icon, AlertGlyph, WarningGlyph } from '@latch/ui'
import { runEndLine, runStatus, type LivePhaseOptions, type RunMessageFacts, type RunStatus } from '../conversation.ts'
import { api } from '../core/api.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { HarnessLoginSteps } from '../components/HarnessLogin.tsx'
import { personStatus } from '../agents/personWords.ts'
import { silentWords } from '../sessions.ts'
import { VisibleText } from '../components/VisibleText.tsx'

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

/**
 * The same line as a helper says it: the plain line's words from the event that runs (在想, 在跑命令, 在用 …), silence as
 * 没有动静, and the rest (a request it does not support, a stop) as they are.
 */
export function personRunStatus(status: RunStatus, detail: TaskDetail, opts: LivePhaseOptions): RunStatus {
  if (status.tone === 'plain' || status.tone === 'quiet') return { ...status, text: personStatus(detail, opts).words }
  const live = detail.summary.live
  if (live?.silent) return { ...status, text: silentWords(live, opts.hostNow) }
  return status
}

export interface StatusLineProps {
  detail: TaskDetail
  harness: string
  /** A helper's conversation: what it is doing in a person's words (agents/personWords.ts), never the model. */
  person?: boolean
  cancelling: boolean
  approvals: number
  messageFacts?: RunMessageFacts
  fallbackElapsed?: number
  /** The connection is down: nothing is known to move, so the line says when it last knew. */
  frozenAt?: number
  onStop?: () => void
  onView?: (messageId: string) => void
  onError?: (error: unknown) => void
}

/**
 * The line under a running turn, drawn only for what the title row does not say: an agent that is starting, and a run
 * that has gone quiet with what can be done about it. Running and stopping are the title row's; waiting on the person
 * is the card's.
 */
export function StatusLine({
  detail,
  harness,
  person = false,
  cancelling,
  approvals,
  messageFacts,
  fallbackElapsed,
  frozenAt,
  onStop,
  onView,
  onError,
}: StatusLineProps) {
  useTicker(frozenAt === undefined ? 'second' : false)
  const now = hostNow()
  const said = runStatus(detail, {
    cancelling,
    approvals,
    hostNow: now,
    harness,
    ...(messageFacts ? { messageFacts } : {}),
    ...(fallbackElapsed !== undefined ? { fallbackElapsed } : {}),
  })
  const status = useHeldStatus(
    person ? personRunStatus(said, detail, { cancelling, approvals, hostNow: now, ...(messageFacts ? { messageFacts } : {}) }) : said,
  )
  const [waiting, setWaiting] = useState(false)
  // Offline, the banner says so and the sidebar row has 上次确认: nothing about the run is claimed here meanwhile.
  if (frozenAt !== undefined) return null
  // The title row says the running state once, with its clock; here it is only announced.
  // A helper's frame names what it does but not that it is stopping, so that stays here.
  const stoppingHelper = person && (cancelling || detail.activity?.phase === 'cancelling')
  if (status.tone === 'quiet' || (status.inHeader && !stoppingHelper)) {
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
  shown,
}: {
  summary: TaskDetail['summary']
  harness: string
  /** The IDs of the turn's rows: a call shown there is not listed again. */
  shown?: ReadonlySet<string>
  onRetry?: () => void
  onContinue?: () => void
  /** How to log in, when this run ended for want of it. */
  login?: { harnessId: string; login: HarnessLogin; terminal: boolean } | undefined
}) {
  const line = runEndLine(summary, harness, shown)
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
