import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronRight, Fingerprint, LockKeyhole } from 'lucide-react'
import type { BlockingTask, ConfirmationTicket } from '@latch/protocol'
import { Button, Collapse, ICON_STROKE, InlineNotice, MOTION } from '@latch/ui'
import {
  useInlineConfirmation,
  type Blocked,
  type ConfirmationActions,
  type ConfirmationFlow,
  type ConfirmationView,
} from '../core/confirmations.ts'
import { BLOCKED_COPY, BLOCKED_VERBS, CONFIRMATION_COPY as COPY, CONFIRMATION_VERBS, waitText } from '../core/securityCopy.ts'
import { useSessionLinks } from '../core/sessionLinks.ts'
import { namedSession, stillBlocking } from '../core/blocking.ts'
import { errorMessage, isUncertain } from '../core/api.ts'
import { currentShell } from '../core/shell.ts'
import { useCountdown } from '../hooks/useCountdown.ts'
import { VisibleText } from './VisibleText.tsx'

/** A confirmed request stays on screen this long, so 已在本机确认 can be read before the card folds away. */
const SUCCESS_HOLD_MS = 400
/** The fold's own transition before the content is dropped. */
const EXIT_MS = 240

/** Starts of a command the owner has not confirmed in this form before: their details open at once. */
const NEW_COMMAND = new Set<string>([
  'start.first',
  'start.first-custom',
  'start.changed',
  'start.changed-custom',
  'start.project-config',
  'start.first-plugin',
  'start.changed-plugin',
])
/** The sheet's sentence ends like this when a slot was cut: the rest is in the details. */
const CUT_SHORT = /；完整(?:命令|参数)见 Latch 里的确认详情$/u

/** Whether a ticket's details open by themselves: a new or changed command, or a sentence the Host had to cut. */
export function detailsOpenAtFirst(ticket: Pick<ConfirmationTicket, 'form' | 'reason'>): boolean {
  return (ticket.form !== undefined && NEW_COMMAND.has(ticket.form)) || CUT_SHORT.test(ticket.reason ?? '')
}

/**
 * Keeps the last flow on screen while its card folds away, and a confirmed one a moment longer. `open` drives the
 * fold; the flow stays rendered until the fold has closed.
 */
export function useHeldFlow(live: ConfirmationFlow | null): { shown: ConfirmationFlow | null; open: boolean } {
  const [shown, setShown] = useState<ConfirmationFlow | null>(live)
  const [open, setOpen] = useState(live !== null)
  if (live !== null && live !== shown) {
    setShown(live)
    setOpen(true)
  }
  const closing = live === null && shown !== null
  const confirmed = shown?.view.phase === 'sending'
  useEffect(() => {
    if (!closing) return undefined
    const hold = setTimeout(
      () => {
        setOpen(false)
      },
      confirmed ? SUCCESS_HOLD_MS : 0,
    )
    const drop = setTimeout(
      () => {
        setShown(null)
      },
      (confirmed ? SUCCESS_HOLD_MS : 0) + EXIT_MS,
    )
    return () => {
      clearTimeout(hold)
      clearTimeout(drop)
    }
  }, [closing, confirmed])
  return { shown, open }
}

/** The one sentence the macOS system sheet shows, which is what the person checks there. */
export function SheetSentence({ reason }: { reason: string }) {
  const browser = currentShell() === null
  return (
    <div className="confirm-sheet">
      <span className="confirm-sheet-label">{browser ? COPY.browser : COPY.sheet}</span>
      <p className="confirm-sheet-text">
        <VisibleText text={reason} />
      </p>
      <span className="confirm-sheet-check">{COPY.check}</span>
    </div>
  )
}

/** The facts behind the sentence, from the Host, in a disclosure: command, arguments, folders, hashes. */
export function ConfirmationDetails({ ticket }: { ticket: ConfirmationTicket }) {
  const id = useId()
  const [open, setOpen] = useState(() => detailsOpenAtFirst(ticket))
  const lines = ticket.lines ?? []
  if (lines.length === 0) return null
  return (
    <div className="confirm-details">
      <button
        type="button"
        className="confirm-details-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open)
        }}>
        <ChevronRight className="chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        {COPY.details}
      </button>
      <Collapse id={id} open={open}>
        <dl className="confirm-details-list">
          {lines.map((line, index) => (
            <div key={`${index}-${line.label}`} className="confirm-details-row">
              <dt>{line.label}</dt>
              <dd>
                <VisibleText text={line.value} />
              </dd>
            </div>
          ))}
        </dl>
        <p className="confirm-details-note">{COPY.detailsNote}</p>
      </Collapse>
    </div>
  )
}

/** The Host's warnings for this request, always in view while it waits: they say what the person is allowing. */
function ConfirmationWarnings({ ticket }: { ticket: ConfirmationTicket }) {
  const warnings = ticket.warnings ?? []
  if (warnings.length === 0) return null
  return (
    <ul className="confirm-warnings">
      {warnings.map(warning => (
        <li key={warning}>
          <VisibleText text={warning} />
        </li>
      ))}
    </ul>
  )
}

function CooldownWait({ until }: { until: number }) {
  const { seconds } = useCountdown(new Date(until).toISOString(), 300)
  return <>{seconds > 0 ? COPY.cooldownWait(waitText(seconds)) : COPY.cooldownOver}</>
}

/** 「要等「…」结束，才能配对新设备。」 with the ways out, or the plain sentence when the sessions are not named. */
export function BlockedLine({ blocked, onDismiss }: { blocked: Blocked | undefined; onDismiss?: () => void }) {
  const links = useSessionLinks()
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<{ text: string; uncertain: boolean } | null>(null)
  const named = blocked?.tasks ?? []
  const remaining = stillBlocking(named, links?.snapshot ?? null)
  const first: BlockingTask | undefined = remaining[0]
  const valid = blocked?.action && Object.hasOwn(BLOCKED_VERBS, blocked.action)
  const dismiss = onDismiss ? { onClose: onDismiss, closeLabel: COPY.close } : {}
  if (named.length > 0 && remaining.length === 0)
    return (
      <InlineNotice
        tone="neutral"
        secure
        title={BLOCKED_COPY.endedTitle}
        action={
          onDismiss && (
            <Button size="xs" onClick={onDismiss}>
              {BLOCKED_COPY.ok}
            </Button>
          )
        }>
        {BLOCKED_COPY.ended(named.map(task => namedSession(task, links?.snapshot ?? null)))}
      </InlineNotice>
    )
  if (!first || !valid)
    return (
      <InlineNotice tone="neutral" secure title={COPY.blockedTitle} {...dismiss}>
        {COPY.blocked}
      </InlineNotice>
    )
  const halt = async () => {
    if (!links) return
    setStopping(true)
    setError(null)
    try {
      await links.stop(first.id)
    } catch (cause) {
      setError({ text: errorMessage(cause), uncertain: isUncertain(cause) })
    } finally {
      setStopping(false)
    }
  }
  return (
    <>
      <InlineNotice
        tone="neutral"
        secure
        {...dismiss}
        action={
          links && (
            <span className="confirm-blocked-actions">
              <Button size="xs" onClick={() => links.open(first.id)}>
                {COPY.openSession}
              </Button>
              <Button
                size="xs"
                loading={stopping}
                onClick={() => {
                  void halt()
                }}>
                {COPY.stopSession}
              </Button>
            </span>
          )
        }>
        {BLOCKED_COPY.line(
          remaining.map(task => namedSession(task, links?.snapshot ?? null)),
          blocked?.action,
        )}
      </InlineNotice>
      {error && <InlineNotice tone={error.uncertain ? 'neutral' : 'error'}>{error.text}</InlineNotice>}
    </>
  )
}

/** What the card says in one state; the dock shows the same parts. */
export function ConfirmationContent({ view, actions }: { view: ConfirmationView; actions: ConfirmationActions }): ReactNode {
  if (view.phase === 'failed')
    return (
      <InlineNotice tone="error" secure title={view.ticket.title} onClose={actions.dismiss} closeLabel={COPY.close}>
        {view.message}
      </InlineNotice>
    )
  if (view.phase === 'paused') {
    if (view.reason === 'blocked') return <BlockedLine blocked={view.blocked} onDismiss={actions.dismiss} />
    return (
      <InlineNotice
        tone={view.reason === 'cooldown' ? 'warn' : 'neutral'}
        secure
        title={view.reason === 'cooldown' ? COPY.cooldownTitle : COPY.busyTitle}
        onClose={actions.dismiss}
        closeLabel={COPY.close}>
        {view.reason === 'cooldown' ? COPY.cooldown : COPY.busy}
        {view.until !== undefined && (
          <>
            {' '}
            <CooldownWait until={view.until} />
          </>
        )}
      </InlineNotice>
    )
  }
  const { ticket } = view
  const waiting = view.phase === 'waiting'
  const verb = Object.hasOwn(CONFIRMATION_VERBS, ticket.action) ? CONFIRMATION_VERBS[ticket.action] : CONFIRMATION_VERBS['approval.r2']
  return (
    <>
      <div className="confirm-status">
        <span className="presence-icon" data-tone={waiting ? 'warn' : 'ok'} aria-hidden="true">
          {waiting ? (
            ticket.confirmationMethod === 'shell-local' ? (
              <LockKeyhole size={20} strokeWidth={ICON_STROKE[20]} />
            ) : (
              <Fingerprint size={20} strokeWidth={ICON_STROKE[20]} />
            )
          ) : (
            <Check size={20} strokeWidth={ICON_STROKE[20]} />
          )}
        </span>
        <div className="confirm-status-text">
          <strong className="confirm-title">{ticket.title}</strong>
          <span className="confirm-line" aria-live="polite">
            {waiting ? (ticket.confirmationMethod === 'shell-local' ? COPY.waitingShell : COPY.waiting) : `${COPY.confirmed}${verb}…`}
          </span>
        </div>
        <Button size="sm" disabled={!waiting} onClick={actions.cancel}>
          {COPY.cancel}
        </Button>
      </div>
      {ticket.reason && <SheetSentence reason={ticket.reason} />}
      <ConfirmationWarnings ticket={ticket} />
      <ConfirmationDetails ticket={ticket} />
    </>
  )
}

/**
 * The local confirmation where the action happened: a card in the page, never a window of its own. While `active` (the
 * place has a request in flight) it takes the confirmation that request starts; it then shows waiting for Touch ID
 * with 取消, the sentence the system sheet shows, the Host's warnings and the details, then folds into nothing once the
 * request went through, or leaves one line on why it did not. The gate is the Host and the system sheet, never this card.
 */
export function InlineConfirm({ active, rank, className }: { active: boolean; rank?: number; className?: string }) {
  const id = useId()
  const card = useRef<HTMLElement>(null)
  const live = useInlineConfirmation(id, active, rank)
  const { shown, open } = useHeldFlow(live)
  const flowId = live?.id
  useEffect(() => {
    if (flowId === undefined || !card.current?.closest('.ui-popover')) return undefined
    // A new card can grow below the visible part of a picker. Reveal it after the fold opens;
    // polling the same flow must not pull the reader back while they inspect its details.
    const timer = setTimeout(() => card.current?.scrollIntoView({ block: 'start' }), MOTION.panel)
    return () => {
      clearTimeout(timer)
    }
  }, [flowId])
  return (
    <Collapse open={open} className={className}>
      {shown && (
        <section
          ref={card}
          className="inline-confirm"
          data-secure=""
          data-confirmation-phase={shown.view.phase}
          data-paused-reason={shown.view.phase === 'paused' ? shown.view.reason : undefined}
          aria-label={COPY.label}>
          <ConfirmationContent view={shown.view} actions={shown.actions} />
        </section>
      )}
    </Collapse>
  )
}
