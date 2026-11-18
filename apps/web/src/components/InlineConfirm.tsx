import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { BlockingTask, ConfirmationTicket } from '@latch/protocol'
import { Button, Collapse, InlineNotice, MOTION, StatusWord } from '@latch/ui'
import {
  useInlineConfirmation,
  type Blocked,
  type ConfirmationActions,
  type ConfirmationFlow,
  type ConfirmationView,
} from '../core/confirmations.ts'
import { BLOCKED_COPY, BLOCKED_VERBS, CONFIRMATION_COPY as COPY, CONFIRMATION_VERBS, waitText } from '../core/securityCopy.ts'
import { useSessionLinks } from '../core/sessionLinks.ts'
import { defineCopy } from '../core/i18n.ts'
import { namedSession, stillBlocking } from '../core/blocking.ts'
import { errorMessage, isUncertain } from '../core/api.ts'
import { useCountdown } from '../hooks/useCountdown.ts'
import { MarkTile } from './BrandTile.tsx'
import { VisibleText } from './VisibleText.tsx'

/** The fold's own transition before the content is dropped. */
const EXIT_MS = 240

/** Keeps the last flow on screen while its line folds away. `open` drives the fold; the flow stays until it has closed. */
function useHeldFlow(live: ConfirmationFlow | null): { shown: ConfirmationFlow | null; open: boolean } {
  const [shown, setShown] = useState<ConfirmationFlow | null>(live)
  const [open, setOpen] = useState(live !== null)
  if (live !== null && live !== shown) {
    setShown(live)
    setOpen(true)
  }
  const closing = live === null && shown !== null
  useEffect(() => {
    if (!closing) return undefined
    setOpen(false)
    const drop = setTimeout(() => {
      setShown(null)
    }, EXIT_MS)
    return () => {
      clearTimeout(drop)
    }
  }, [closing])
  return { shown, open }
}

/** The Host's warnings for this request: the system sheet shows one sentence and leaves them out, so they stay in view. */
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

/**
 * What a system form's one sentence leaves out. A start names the program there, not its folder or what the project can
 * change; a slot the Host cut carries 「…」, its only mark, and a slot's own 「…」 merely shows these too. The system
 * sheet shows that one sentence and nothing else, so what it leaves out is listed here. Hashes bind the request and
 * are nothing to read.
 */
export function detailsLeftOut(ticket: ConfirmationTicket) {
  // A login's authorization server and scopes come from the server, not from anything the person typed, and the
  // sentence has no room for them: they are always listed, every scope, before the person confirms.
  const login = (ticket.lines ?? []).some(line => line.label === '授权服务器')
  if (!ticket.reason?.includes('…') && !login) return []
  return (ticket.lines ?? []).filter(line => !/指纹|哈希|首条输入/u.test(line.label))
}

function DetailsList({ lines }: { lines: ReturnType<typeof detailsLeftOut> }) {
  return (
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
  )
}

function DetailsLeftOut({ ticket }: { ticket: ConfirmationTicket }) {
  const lines = detailsLeftOut(ticket)
  if (lines.length === 0) return null
  return (
    <div className="confirm-details">
      <span className="confirm-details-title">{COPY.details}</span>
      <DetailsList lines={lines} />
    </div>
  )
}

function CooldownWait({ until }: { until: number }) {
  const { seconds } = useCountdown(new Date(until).toISOString(), 300)
  return <>{seconds > 0 ? COPY.cooldownWait(waitText(seconds)) : COPY.cooldownOver}</>
}

/** 「Codex 正在运行「…」，结束后才能配对新设备。」 with the ways out, or the plain sentence when the sessions are not named. */
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
      <InlineNotice tone="neutral" secure {...dismiss}>
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

/** One session holding the confirmation back: its Harness, title and state, and the ways to open or stop it. */
function BlockedRow({ task }: { task: BlockingTask }) {
  const links = useSessionLinks()
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<{ text: string; uncertain: boolean } | null>(null)
  const snapshot = links?.snapshot ?? null
  const session = namedSession(task, snapshot)
  const mark = snapshot?.catalog?.harnesses.find(harness => harness.id === task.harnessId)?.capabilities.display.mark
  const halt = async () => {
    if (!links) return
    setStopping(true)
    setError(null)
    try {
      await links.stop(task.id)
    } catch (cause) {
      setError({ text: errorMessage(cause), uncertain: isUncertain(cause) })
      setStopping(false)
    }
  }
  return (
    <li className="blocked-row" data-session-id={task.id}>
      <MarkTile mark={mark} size={16} />
      <span className="blocked-row-text">
        <span className="blocked-row-title">{session.title}</span>
        {session.agent && <span className="blocked-row-agent">{session.agent}</span>}
      </span>
      <StatusWord tone={stopping ? 'neutral' : session.waiting ? 'waiting' : 'running'}>
        {stopping ? BLOCKED_COPY.stopping : session.waiting ? BLOCKED_COPY.waiting : BLOCKED_COPY.running}
      </StatusWord>
      {links && (
        <span className="blocked-row-actions">
          <Button size="xs" variant="ghost" onClick={() => links.open(task.id)}>
            {BLOCKED_COPY.view}
          </Button>
          <Button
            size="xs"
            disabled={stopping}
            onClick={() => {
              void halt()
            }}>
            {BLOCKED_COPY.stop}
          </Button>
        </span>
      )}
      {error && (
        <InlineNotice tone={error.uncertain ? 'neutral' : 'error'} className="blocked-row-error">
          {error.text}
        </InlineNotice>
      )}
    </li>
  )
}

/**
 * Every session the Host named as holding the confirmation back, one row each, the ones waiting for the person first (the
 * Host's order). A stopped session leaves the list once the snapshot shows it settled; when none is left the line says
 * the person can try again. Without names (an older Host) it is the one general sentence.
 */
export function BlockedList({ blocked, onDismiss }: { blocked: Blocked | undefined; onDismiss?: () => void }) {
  const links = useSessionLinks()
  const named = blocked?.tasks ?? []
  const remaining = stillBlocking(named, links?.snapshot ?? null)
  const action = blocked?.action && Object.hasOwn(BLOCKED_VERBS, blocked.action) ? blocked.action : undefined
  if (remaining.length === 0 || action === undefined) return <BlockedLine blocked={blocked} onDismiss={onDismiss} />
  return (
    <InlineNotice
      tone="neutral"
      secure
      className="blocked-list"
      title={BLOCKED_COPY.headline(action)}
      {...(onDismiss ? { onClose: onDismiss, closeLabel: COPY.close } : {})}>
      <ul className="blocked-rows">
        {remaining.map(task => (
          <BlockedRow key={task.id} task={task} />
        ))}
      </ul>
    </InlineNotice>
  )
}

/** Whether a state has anything to read: a line where the person acted, or what the sheet leaves out while it is open. */
const hasLine = (view: ConfirmationView) =>
  view.phase === 'failed'
  || view.phase === 'paused'
  || (view.phase === 'waiting' && ((view.ticket.warnings ?? []).length > 0 || detailsLeftOut(view.ticket).length > 0))

/**
 * What one state shows. Waiting and sending have no line of their own: the button that asked shows them. With `list` a
 * refusal while sessions run names every one of them, one row each, instead of the first and a count.
 */
export function ConfirmationContent({
  view,
  actions,
  list = false,
}: {
  view: ConfirmationView
  actions: ConfirmationActions
  list?: boolean
}): ReactNode {
  if (view.phase === 'failed')
    return (
      <InlineNotice tone="error" secure onClose={actions.dismiss} closeLabel={COPY.close}>
        {view.message}
      </InlineNotice>
    )
  if (view.phase === 'paused') {
    if (view.reason === 'blocked')
      return list ? (
        <BlockedList blocked={view.blocked} onDismiss={actions.dismiss} />
      ) : (
        <BlockedLine blocked={view.blocked} onDismiss={actions.dismiss} />
      )
    return (
      <InlineNotice tone={view.reason === 'cooldown' ? 'warn' : 'neutral'} secure onClose={actions.dismiss} closeLabel={COPY.close}>
        {view.reason === 'cooldown' ? COPY.cooldown : COPY.busyShort}
        {view.until !== undefined && (
          <>
            {' · '}
            <CooldownWait until={view.until} />
          </>
        )}
      </InlineNotice>
    )
  }
  if (view.phase !== 'waiting') return null
  return (
    <>
      <ConfirmationWarnings ticket={view.ticket} />
      <DetailsLeftOut ticket={view.ticket} />
    </>
  )
}

const INLINE_CONFIRM_COPY = defineCopy({ proceed: '继续' }, { proceed: 'continuing' })

/** Told to a screen reader only, since a pending button says nothing by itself. Outside the fold, which hides its content. */
function ConfirmationStatus({ view }: { view: ConfirmationView | undefined }) {
  let text = ''
  if (view?.phase === 'waiting') text = COPY.waiting
  else if (view?.phase === 'sending') {
    const { action } = view.ticket
    text = `${COPY.confirmed}${Object.hasOwn(CONFIRMATION_VERBS, action) ? CONFIRMATION_VERBS[action] : INLINE_CONFIRM_COPY.proceed}…`
  }
  return (
    <p className="sr-only" role="status">
      {text}
    </p>
  )
}

/**
 * The local confirmation where the action happened, with nothing of its own to look at: the button that asked shows
 * pending and the system sheet is the only window. While `active` (the place has a request in flight) it takes the
 * confirmation that request starts. A request that did not run, or could not start, leaves one line here. The gate is
 * the Host and the system sheet, never this element.
 */
export function InlineConfirm({
  active,
  rank,
  className,
  list = false,
}: {
  active: boolean
  rank?: number
  className?: string
  /** Name every session that holds a refused confirmation back, one row each (设置 › 设备). */
  list?: boolean
}) {
  const id = useId()
  const line = useRef<HTMLElement>(null)
  const live = useInlineConfirmation(id, active, rank)
  const { shown, open } = useHeldFlow(live)
  const flowId = live?.id
  const visible = live !== null && hasLine(live.view)
  useEffect(() => {
    if (flowId === undefined || !visible || !line.current?.closest('.ui-popover')) return undefined
    // A new line can grow below the visible part of a picker. Reveal it after the fold opens.
    const timer = setTimeout(() => line.current?.scrollIntoView({ block: 'start' }), MOTION.panel)
    return () => {
      clearTimeout(timer)
    }
  }, [flowId, visible])
  return (
    <>
      <ConfirmationStatus view={live?.view} />
      <Collapse open={open && shown !== null && hasLine(shown.view)} className={className}>
        {shown && (
          <section
            ref={line}
            className="inline-confirm"
            data-secure=""
            data-confirmation-phase={shown.view.phase}
            data-paused-reason={shown.view.phase === 'paused' ? shown.view.reason : undefined}
            aria-label={COPY.label}>
            <ConfirmationContent view={shown.view} actions={shown.actions} list={list} />
          </section>
        )}
      </Collapse>
    </>
  )
}
