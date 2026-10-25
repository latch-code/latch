import { useEffect, useState, type ReactNode } from 'react'
import { Check, CircleX, Clock, Fingerprint, Info } from 'lucide-react'
import { Button, Dialog, ICON_STROKE, InlineNotice } from '@latch/ui'
import { useConfirmationState, type ConfirmationView } from '../core/confirmations.ts'
import { CONFIRMATION_COPY, CONFIRMATION_VERBS, waitText } from '../core/securityCopy.ts'
import { currentShell } from '../core/shell.ts'
import { useCountdown } from '../hooks/useCountdown.ts'

/** A confirmed request that went through stays on screen this long, so the change to 已确认 can be read. */
const SUCCESS_HOLD_MS = 400
/** The dock's exit (the dialog's own transition) before its content is dropped. */
const EXIT_MS = 240

type Shown = NonNullable<ReturnType<typeof useConfirmationState>>

/** Keeps the last state on screen while the dock closes, and a confirmed one a moment longer. */
function useHeld(live: Shown | null): { shown: Shown | null; open: boolean } {
  const [shown, setShown] = useState<Shown | null>(live)
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

function Tile({ tone, children }: { tone: 'warn' | 'ok' | 'err' | 'neutral'; children: ReactNode }) {
  return (
    <span className="presence-icon" data-tone={tone}>
      {children}
    </span>
  )
}

function CooldownWait({ until }: { until: number }) {
  const { seconds } = useCountdown(new Date(until).toISOString(), 300)
  return (
    <InlineNotice tone="warn">
      {seconds > 0 ? CONFIRMATION_COPY.cooldownWait(waitText(seconds)) : CONFIRMATION_COPY.cooldownOver}
    </InlineNotice>
  )
}

const PAUSED = {
  cooldown: { title: CONFIRMATION_COPY.cooldownTitle, line: CONFIRMATION_COPY.cooldown, tone: 'warn', icon: Clock },
  busy: { title: CONFIRMATION_COPY.busyTitle, line: CONFIRMATION_COPY.busy, tone: 'neutral', icon: Info },
  blocked: { title: CONFIRMATION_COPY.blockedTitle, line: CONFIRMATION_COPY.blocked, tone: 'neutral', icon: Info },
} as const

/** Title, tile, the line under them and what follows for one state of the dock. */
function content(view: ConfirmationView, browser: boolean) {
  if (view.phase === 'paused') {
    const paused = PAUSED[view.reason]
    const Glyph = paused.icon
    return {
      title: paused.title,
      icon: (
        <Tile tone={paused.tone}>
          <Glyph size={20} strokeWidth={ICON_STROKE[20]} aria-hidden="true" />
        </Tile>
      ),
      line: paused.line,
      body: view.until !== undefined ? <CooldownWait until={view.until} /> : null,
    }
  }
  const { ticket } = view
  if (view.phase === 'sending')
    return {
      title: ticket.title,
      icon: (
        <Tile tone="ok">
          <Check size={20} strokeWidth={ICON_STROKE[20]} aria-hidden="true" />
        </Tile>
      ),
      line: `${CONFIRMATION_COPY.confirmed}${Object.hasOwn(CONFIRMATION_VERBS, ticket.action) ? CONFIRMATION_VERBS[ticket.action] : CONFIRMATION_VERBS['approval.r2']}…`,
      body: null,
    }
  if (view.phase === 'failed')
    return {
      title: ticket.title,
      icon: (
        <Tile tone="err">
          <CircleX size={20} strokeWidth={ICON_STROKE[20]} aria-hidden="true" />
        </Tile>
      ),
      line: view.message,
      body: null,
    }
  return {
    title: ticket.title,
    icon: (
      <Tile tone="warn">
        <Fingerprint size={20} strokeWidth={ICON_STROKE[20]} aria-hidden="true" />
      </Tile>
    ),
    line: browser ? CONFIRMATION_COPY.browser : CONFIRMATION_COPY.waiting,
    // Another computer's window is compared by its check code; on this one, the confirmation window is the one to read.
    body: browser ? (
      <div className="presence-code">
        <span>{CONFIRMATION_COPY.code}</span>
        <code>{ticket.hashDisplay}</code>
      </div>
    ) : null,
  }
}

/**
 * The page-wide local confirmation, docked at the bottom of the window, for the actions that do not show it in place
 * (an approval card does: its button waits and the card says why a confirmation did not pass). `withConfirmation`
 * drives it. While it waits, the confirmation window on this computer is the trusted one: the dock says what to do
 * there and offers 取消; it has no countdown, since the window times out on its own. It then shows the request going
 * through, or why it did not run with 关闭 alone (the action is asked for again from where it started), or why no
 * confirmation could start.
 */
export function ConfirmationDialog() {
  const live = useConfirmationState()
  const { shown, open } = useHeld(live)
  if (shown === null) return null
  const { view, actions } = shown
  const browser = currentShell() === null
  const { title, icon, line, body } = content(view, browser)
  const close = () => {
    if (!open) return
    if (view.phase === 'waiting') actions.cancel()
    else if (view.phase !== 'sending') actions.dismiss()
  }
  const footer =
    view.phase === 'failed' || view.phase === 'paused' ? (
      <Button size="md" onClick={actions.dismiss}>
        {view.phase === 'failed' ? CONFIRMATION_COPY.close : CONFIRMATION_COPY.ok}
      </Button>
    ) : (
      <Button size="md" disabled={view.phase === 'sending'} onClick={actions.cancel}>
        {CONFIRMATION_COPY.cancel}
      </Button>
    )
  return (
    <Dialog
      open={open}
      onClose={close}
      placement="dock"
      bare
      dismissible={view.phase !== 'sending'}
      secure
      className="presence-dock"
      title={title}
      icon={icon}
      footer={footer}>
      <div className="presence-body" data-confirmation-phase={view.phase}>
        <p className="presence-line" aria-live="polite">
          {line}
        </p>
        {body}
      </div>
    </Dialog>
  )
}
