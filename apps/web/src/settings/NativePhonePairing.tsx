import { useEffect, useRef, useState } from 'react'
import { pairingQr } from './pairingQr.ts'
import { QrCode } from 'lucide-react'
import type { NativeLinkInfo, NativePairingInvitation, NativePairingStatus } from '@latch/protocol'
import { Button, InlineNotice, Spinner } from '@latch/ui'
import { api, inlineError } from '../core/api.ts'
import { NATIVE_LINK_COPY as COPY } from '../core/securityCopy.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { SettingsGroup, SettingsRow } from './common.tsx'
import { WaitingEnrollments } from './WaitingEnrollments.tsx'

/** The QR changes without notice; the one before it stays valid until it expires, so a scan in progress still lands. */
const REFRESH_MS = 60_000
const POLL_MS = 1000

const revoke = (id: string) => {
  void api(`native/pairings/${id}`, { method: 'DELETE' }).catch(() => {})
}

/**
 * The pairing panel: a QR that refreshes itself, follows what the Host says about it, and dies with the panel. Its
 * payload is a secret: it only ever becomes the image. After Touch ID it stays until answered, because the phone in hand
 * showing 已连接 is the proof only that phone can give; leaving the page without an answer counts as done, and the device
 * is on this page either way.
 */
function NativeCode({ onClose }: { onClose(): void }) {
  const [invitation, setInvitation] = useState<NativePairingInvitation | null>(null),
    [qr, setQr] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [offNetwork, setOffNetwork] = useState(false),
    [waiting, setWaiting] = useState(false),
    [done, setDone] = useState<{ id: string; device: string; deviceId?: string } | null>(null),
    [removed, setRemoved] = useState(false)
  const issued = useRef<Array<{ id: string; at: number }>>([])
  const closing = useRef(false)
  const create = async (next = '') => {
    try {
      const answer = await api<{ invitation: NativePairingInvitation }>('native/pairings', { method: 'POST', body: {} })
      if (closing.current) {
        revoke(answer.invitation.id)
        return
      }
      issued.current = [...issued.current.slice(-1), { id: answer.invitation.id, at: Date.now() }]
      setError('')
      setNotice(next)
      setOffNetwork(false)
      setWaiting(false)
      setInvitation(answer.invitation)
    } catch (cause) {
      setError(inlineError(cause))
    }
  }
  useEffect(() => {
    void create()
    return () => {
      closing.current = true
      for (const item of issued.current) revoke(item.id)
    }
  }, [])
  useEffect(() => {
    if (!invitation) return
    let active = true
    // Dark modules on white in both themes: scanners need the contrast.
    void pairingQr(invitation.payload, {
      width: 600,
      margin: 2,
      errorCorrectionLevel: 'L',
      color: { dark: '#18181b', light: '#ffffff' },
    })
      .then(value => {
        if (active) setQr(value)
      })
      .catch(() => {
        if (active) setError(COPY.qrFailed)
      })
    return () => {
      active = false
    }
  }, [invitation])
  useEffect(() => {
    const timer = window.setInterval(() => {
      void (async () => {
        const answers = await Promise.all(
          issued.current.map(item => api<NativePairingStatus>(`native/pairings/${item.id}`).catch(() => null)),
        )
        if (closing.current) return
        const seen = answers.filter(value => value !== null)
        setOffNetwork(seen.some(value => value.offNetwork))
        if (seen.some(value => value.state === 'contended')) {
          // The Host ended every QR of this sheet, and removed any phone it paired, even during the question.
          issued.current = []
          setDone(null)
          await create(COPY.contended)
          return
        }
        // The question stays until answered, and this keeps asking so a burn can still reach it.
        if (done !== null) return
        const finished = answers.findIndex(value => value?.state === 'done')
        if (finished >= 0) {
          const answer = answers[finished]!
          setDone({
            id: issued.current[finished]!.id,
            device: answer.device ?? '',
            ...(answer.deviceId ? { deviceId: answer.deviceId } : {}),
          })
          return
        }
        const ended = answers.flatMap((value, index) =>
          value?.state === 'cancelled' || value?.state === 'timeout' ? [{ id: issued.current[index]!.id, state: value.state }] : [],
        )
        if (ended.length) {
          // Only the QR that was used: its sibling is still live, and closing the panel must still reach it.
          issued.current = issued.current.filter(item => !ended.some(value => value.id === item.id))
          await create(ended[0]!.state === 'timeout' ? COPY.timedOut : COPY.cancelled)
          return
        }
        // While a device is being confirmed the QR stands still, so a second phone scans the same one.
        const busy = seen.some(value => value.state === 'confirming' || value.state === 'approved')
        setWaiting(busy)
        const newest = issued.current.at(-1)
        const lapsed = answers.at(-1)?.state === 'expired'
        if (!busy && newest && (lapsed || Date.now() - newest.at >= REFRESH_MS)) await create()
      })()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [done])
  if (removed)
    return (
      <div className="pair-empty" role="status">
        <p>{COPY.removed}</p>
        <Button variant="primary" onClick={onClose}>
          {COPY.close}
        </Button>
      </div>
    )
  if (done !== null)
    return (
      <div className="pair-empty" role="status">
        <p>
          {COPY.connectedBefore}
          <VisibleText text={done.device} />
          {COPY.connectedAfter}
        </p>
        <p>{COPY.ask}</p>
        <div className="pair-actions">
          <Button variant="primary" onClick={onClose}>
            {COPY.yes}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              // No second dialog: removing only takes privilege away. The sheet may have outlived what the Host remembers of
              // it, so the device's own ID is the way back, and only a real removal says it is gone.
              void (async () => {
                setError('')
                try {
                  await api(`native/pairings/${done.id}/device`, { method: 'DELETE' })
                } catch {
                  try {
                    if (!done.deviceId) throw new Error('No device to remove')
                    await api(`devices/${done.deviceId}`, { method: 'DELETE' })
                  } catch {
                    setError(COPY.removeFailed)
                    return
                  }
                }
                issued.current = []
                setRemoved(true)
              })()
            }}>
            {COPY.no}
          </Button>
        </div>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
      </div>
    )
  return (
    <>
      {error ? (
        <InlineNotice tone="error">{error}</InlineNotice>
      ) : (
        <div className="pair-ready">
          <div className="pair-qr" style={waiting ? { opacity: 0.3 } : undefined}>
            {qr ? <img src={qr} alt={COPY.qrAlt} width={200} height={200} /> : <Spinner size={20} />}
          </div>
          <div className="pair-steps">
            <ol>
              {COPY.steps.map((step, index) => (
                <li key={step}>
                  <span className="pair-step-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
            {notice && <InlineNotice tone="neutral">{notice}</InlineNotice>}
            {offNetwork && <InlineNotice tone="neutral">{COPY.offNetwork}</InlineNotice>}
            <div className="pair-actions">
              <Button variant="ghost" onClick={onClose}>
                {COPY.close}
              </Button>
            </div>
          </div>
        </div>
      )}
      <WaitingEnrollments />
    </>
  )
}

/** 连接手机: nothing to set up. Opening the panel opens phone access, and a paired phone keeps it open. */
export function NativePairingSection() {
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState<NativeLinkInfo | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void api<NativeLinkInfo>('native/info').then(
      value => {
        if (active) setInfo(value)
      },
      () => {},
    )
    return () => {
      active = false
    }
  }, [])
  const remove = (path: string) => {
    setError('')
    void api<NativeLinkInfo>(path, { method: 'DELETE' }).then(setInfo, cause => setError(inlineError(cause)))
  }
  return (
    <SettingsGroup title={COPY.title} secure>
      <SettingsRow
        title={COPY.app}
        description={COPY.intro}
        trailing={
          open ? undefined : (
            <Button variant="primary" icon={QrCode} onClick={() => setOpen(true)}>
              {COPY.enable}
            </Button>
          )
        }
      />
      {open && (
        <div className="settings-card-body pair-section">
          <NativeCode onClose={() => setOpen(false)} />
        </div>
      )}
      {info?.relays.map(relay => (
        <SettingsRow
          key={relay.relayId}
          title={COPY.savedRelay}
          description={relay.url}
          trailing={<Button onClick={() => remove(`native/relays/${relay.relayId}`)}>{COPY.removeSaved}</Button>}
        />
      ))}
      {info?.directory && (
        <SettingsRow
          title={COPY.savedDirectory}
          trailing={<Button onClick={() => remove('native/directory')}>{COPY.removeSaved}</Button>}
        />
      )}
      {error && (
        <div className="settings-card-body">
          <InlineNotice tone="error">{error}</InlineNotice>
        </div>
      )}
    </SettingsGroup>
  )
}
