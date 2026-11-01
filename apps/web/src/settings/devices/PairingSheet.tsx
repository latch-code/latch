import { useEffect, useRef, useState, type ReactNode } from 'react'
import { WifiOff } from 'lucide-react'
import type { AppSnapshot, NativePairingInvitation, NativePairingStatus } from '@latch/protocol'
import { Button, Icon, InlineNotice, Modal, ModalHeader, Spinner } from '@latch/ui'
import { useViewport } from '../../breakpoints.ts'
import { VisibleText } from '../../components/VisibleText.tsx'
import { activeFullAccess } from '../../core/blocking.ts'
import { api, ApiError, inlineError } from '../../core/api.ts'
import { BLOCKED_COPY, NATIVE_LINK_COPY as COPY, presenceUnavailableText } from '../../core/securityCopy.ts'
import { hostView } from '../../core/permissions.ts'
import { PairingBlocked } from '../PairingBlocked.tsx'
import { pairingQr } from '../pairingQr.ts'
import { WaitingDevices } from './WaitingDevices.tsx'
import { deviceIcon } from './deviceIcon.ts'
import { readPairing, type IssuedQr } from './pairingFlow.ts'

const POLL_MS = 1000
/** How often a sheet with no QR asks again: the network coming back or a session ending opens it by itself. */
const RETRY_MS = 3000

const revoke = (id: string) => {
  void api(`native/pairings/${id}`, { method: 'DELETE' }).catch(() => {})
}

type Stop = { kind: 'none' } | { kind: 'no-network' } | { kind: 'blocked' } | { kind: 'failed'; message: string }

function Center({ children }: { children: ReactNode }) {
  return (
    <div className="pair-center" role="status">
      {children}
    </div>
  )
}

/**
 * 连接手机: a QR that refreshes itself, follows what the Host says about it, and dies with the sheet. Its payload is a
 * secret: it only ever becomes the image. After the Mac's confirmation the sheet stays until answered, with no close and Esc doing
 * nothing, because the phone in hand showing 已连接 is the proof only that phone can give; quitting without an answer
 * counts as done, and the device is on the page either way.
 */
export function PairingSheet({ snapshot, onClose, onChanged }: { snapshot: AppSnapshot; onClose: () => void; onChanged: () => void }) {
  const phone = useViewport() === 'phone'
  const [invitation, setInvitation] = useState<NativePairingInvitation | null>(null),
    [qr, setQr] = useState(''),
    [stop, setStop] = useState<Stop>({ kind: 'none' }),
    [line, setLine] = useState(''),
    [offNetwork, setOffNetwork] = useState(false),
    [busy, setBusy] = useState<{ state: 'confirming' | 'approved'; device?: string } | null>(null),
    [done, setDone] = useState<{ id: string; device: string; deviceId?: string } | null>(null),
    [removed, setRemoved] = useState<string | null>(null),
    [removeError, setRemoveError] = useState('')
  const issued = useRef<IssuedQr[]>([])
  const closing = useRef(false)
  // One POST at a time: every one the Host answers writes to the audit log, and the third retires the oldest live QR.
  const creating = useRef(false)
  // With nothing to refresh to, the poll leaves asking again to the retry timer or the person.
  const stopped = useRef(false)
  const polling = useRef(false)
  const presenceDown = hostView(snapshot)?.presence.status === 'unavailable'
  const presenceMessage = hostView(snapshot)?.presence.message
  const holding = activeFullAccess(snapshot).length > 0

  const create = async () => {
    if (creating.current) return
    creating.current = true
    try {
      const answer = await api<{ invitation: NativePairingInvitation }>('native/pairings', { method: 'POST', body: {} })
      if (closing.current) {
        revoke(answer.invitation.id)
        return
      }
      issued.current = [...issued.current.slice(-1), { id: answer.invitation.id, at: Date.now() }]
      stopped.current = false
      setStop({ kind: 'none' })
      setBusy(null)
      setInvitation(answer.invitation)
    } catch (cause) {
      if (closing.current) return
      stopped.current = true
      setBusy(null)
      if (cause instanceof ApiError && cause.code === 'native-no-lan') setStop({ kind: 'no-network' })
      else if (cause instanceof ApiError && cause.code === 'presence-blocked') setStop({ kind: 'blocked' })
      else setStop({ kind: 'failed', message: inlineError(cause) })
    } finally {
      creating.current = false
    }
  }

  /** The QR the Host ended is gone from the sheet at once, and what happened stays said whether or not a new one comes. */
  const replaceQr = (said: string) => {
    setLine(said)
    setBusy(null)
    setInvitation(null)
    setQr('')
    return create()
  }

  useEffect(() => {
    closing.current = false
    return () => {
      closing.current = true
      for (const item of issued.current) revoke(item.id)
    }
  }, [])

  // Also when this Mac can confirm again after the sheet opened without a QR.
  useEffect(() => {
    if (!presenceDown && issued.current.length === 0) void create()
  }, [presenceDown])

  useEffect(() => {
    if (stop.kind !== 'no-network' && stop.kind !== 'blocked') return undefined
    const timer = window.setInterval(() => {
      void create()
    }, RETRY_MS)
    return () => {
      clearInterval(timer)
    }
  }, [stop.kind])

  useEffect(() => {
    if (!invitation) return undefined
    let active = true
    // Dark modules on white in both themes: scanners need the contrast. The white padding around it is the quiet zone.
    void pairingQr(invitation.payload, {
      width: 600,
      margin: 0,
      errorCorrectionLevel: 'L',
      color: { dark: '#18181b', light: '#ffffff' },
    })
      .then(value => {
        if (active) setQr(value)
      })
      .catch(() => {
        if (active) setStop({ kind: 'failed', message: COPY.qrFailed })
      })
    return () => {
      active = false
    }
  }, [invitation])

  useEffect(() => {
    const tick = async () => {
      const asked = [...issued.current]
      const answers = await Promise.all(asked.map(item => api<NativePairingStatus>(`native/pairings/${item.id}`).catch(() => null)))
      if (closing.current) return
      if (answers.some(value => value?.offNetwork)) setOffNetwork(true)
      const read = readPairing(asked, answers, Date.now())
      if (read.kind === 'contended') {
        issued.current = []
        setDone(null)
        setOffNetwork(false)
        onChanged()
        await replaceQr(COPY.contended)
        return
      }
      // The question stays until answered, and this keeps asking so a burn can still reach it.
      if (done !== null) return
      if (read.kind === 'done') {
        setDone({ id: read.id, device: read.device, ...(read.deviceId ? { deviceId: read.deviceId } : {}) })
        setOffNetwork(false)
        onChanged()
      } else if (read.kind === 'ended') {
        issued.current = issued.current.filter(item => !read.ids.includes(item.id))
        await replaceQr(read.state === 'timeout' ? COPY.timedOut : COPY.cancelled)
      } else if (read.kind === 'busy') {
        setBusy({ state: read.state, ...(read.device ? { device: read.device } : {}) })
      } else {
        setBusy(null)
        if (read.kind === 'refresh' && !stopped.current) await create()
      }
    }
    const timer = window.setInterval(() => {
      // A tick reading older answers must not undo what a newer one did about them.
      if (polling.current) return
      polling.current = true
      void tick().finally(() => {
        polling.current = false
      })
    }, POLL_MS)
    return () => {
      clearInterval(timer)
    }
  }, [done])

  /** No second dialog: removing only takes privilege away. Only a real removal says it is gone. */
  const reject = async (target: NonNullable<typeof done>) => {
    setRemoveError('')
    try {
      await api(`native/pairings/${target.id}/device`, { method: 'DELETE' })
    } catch {
      // The sheet may have outlived what the Host remembers of it, so the device's own ID is the way back.
      try {
        if (!target.deviceId) throw new Error('No device to remove')
        await api(`devices/${target.deviceId}`, { method: 'DELETE' })
      } catch {
        setRemoveError(COPY.removeFailed)
        return
      }
    }
    issued.current = []
    setRemoved(target.device)
    onChanged()
  }

  const answering = done !== null && removed === null
  const said = line && <p className="pair-line">{line}</p>
  // A chip with no name yet: the phone has claimed the QR and no confirmation is on this Mac's screen.
  const confirmingOnMac = busy?.state === 'confirming' && busy.device !== undefined
  let body: ReactNode
  if (removed !== null)
    body = (
      <Center>
        <span className="pair-glyph" aria-hidden="true">
          <Icon icon={deviceIcon({ listener: 'native-direct', name: removed })} size={20} />
        </span>
        <p className="pair-title">
          {COPY.removedBefore}
          <VisibleText text={removed} />
          {COPY.closingQuote}
        </p>
        <p className="pair-note">{COPY.removed}</p>
        <Button className="pair-center-action" onClick={onClose}>
          {COPY.done}
        </Button>
      </Center>
    )
  else if (done !== null)
    body = (
      <Center>
        <svg className="pair-check" viewBox="0 0 76 76" aria-hidden="true">
          <circle cx="38" cy="38" r="35" />
          <path d="M24 39l9.5 9.5L53 29" />
        </svg>
        <p className="pair-title">
          {COPY.connectedBefore}
          <VisibleText text={done.device} />
          {COPY.closingQuote}
        </p>
        <p className="pair-note">{COPY.ask}</p>
        <div className="pair-actions">
          <Button
            variant="danger"
            onClick={() => {
              void reject(done)
            }}>
            {COPY.no}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {COPY.yes}
          </Button>
        </div>
        {removeError && <InlineNotice tone="error">{removeError}</InlineNotice>}
      </Center>
    )
  else if (presenceDown)
    body = (
      <>
        {said}
        <InlineNotice tone="warn">{presenceUnavailableText(presenceMessage)}</InlineNotice>
      </>
    )
  else if (stop.kind === 'no-network')
    body = (
      <>
        {said}
        <Center>
          <span className="pair-glyph" aria-hidden="true">
            <Icon icon={WifiOff} size={20} />
          </span>
          <p className="pair-note">{COPY.noNetwork}</p>
        </Center>
      </>
    )
  else if (stop.kind === 'failed')
    body = (
      <>
        {said}
        <Center>
          <InlineNotice tone="error">{stop.message}</InlineNotice>
          <Button
            className="pair-center-action"
            onClick={() => {
              setStop({ kind: 'none' })
              void create()
            }}>
            {COPY.retry}
          </Button>
        </Center>
      </>
    )
  else if (stop.kind === 'blocked')
    // No QR exists yet, so nothing here asks for a scan. The snapshot can lag the Host, which still gets to say why.
    body = (
      <>
        {said}
        {holding ? (
          <PairingBlocked snapshot={snapshot} />
        ) : (
          <InlineNotice tone="warn">{BLOCKED_COPY.line([], 'device.enroll')}</InlineNotice>
        )}
      </>
    )
  else
    body = (
      <>
        {holding && <PairingBlocked snapshot={snapshot} />}
        {said}
        {offNetwork && <p className="pair-line">{COPY.offNetwork}</p>}
        <div className="pair-code" data-dim={busy ? '' : undefined}>
          <div className="pair-qr">{qr ? <img src={qr} alt={COPY.qrAlt} /> : <Spinner size={20} />}</div>
          {busy && (
            <div className="pair-chip" role="status">
              <span className="pair-chip-glyph" aria-hidden="true">
                <Icon icon={deviceIcon({ listener: 'native-direct', name: busy.device ?? '' })} size={16} />
              </span>
              <span className="pair-chip-text">
                <b>{busy.device ? <VisibleText text={busy.device} /> : COPY.someDevice}</b>
                <span>
                  {!confirmingOnMac && <Spinner size={12} />}
                  {confirmingOnMac ? COPY.confirming : COPY.connecting}
                </span>
              </span>
            </div>
          )}
        </div>
        <div className="pair-foot" data-dim={busy ? '' : undefined}>
          <p className="pair-foot-title">{COPY.scan}</p>
          <p className="pair-foot-note">{COPY.sameWifi}</p>
          <p className="pair-foot-note">{COPY.drivesAgents}</p>
        </div>
        <WaitingDevices place="sheet" />
      </>
    )

  return (
    <Modal label={COPY.title} secure variant={phone ? 'sheet' : 'dialog'} className="pair-sheet" dismissible={!answering} onClose={onClose}>
      {answering ? (
        <header className="ui-modal-header">
          <h2>{COPY.title}</h2>
        </header>
      ) : (
        <ModalHeader title={COPY.title} onClose={onClose} />
      )}
      <div className="pair-body">{body}</div>
    </Modal>
  )
}
