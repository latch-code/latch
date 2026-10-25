import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Link, QrCode, RefreshCw, Share2 } from 'lucide-react'
import type { InvitationView } from '@latch/protocol'
import { Button, InlineNotice, Spinner } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { PAIRING_COPY } from '../core/securityCopy.ts'
import { formatElapsed } from '../format.ts'
import { useCopy } from '../components/ui.tsx'
import { IconTile, SettingsGroup, SettingsRow } from './common.tsx'

/** A one-time invitation for a phone over the Host's HTTPS entry; it grants nothing until confirmed on this computer. */
function PhonePairing({ phone }: { phone: boolean }) {
  const [invitation, setInvitation] = useState<InvitationView | null>(null)
  const [qr, setQr] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const { state: copyState, copy } = useCopy(2500)
  const remaining = invitation === null ? 0 : Date.parse(invitation.expiresAt) - now
  const expired = invitation !== null && remaining <= 0
  useEffect(() => {
    if (invitation === null) return undefined
    let active = true
    // Dark modules on white in both themes: scanners need the contrast.
    void QRCode.toDataURL(invitation.url, { width: 400, margin: 1, color: { dark: '#1d1c1a', light: '#ffffff' } })
      .then(value => {
        if (active) setQr(value)
      })
      .catch(() => {
        if (active) setError(PAIRING_COPY.qrFailed)
      })
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [invitation])
  const create = async () => {
    setBusy(true)
    setError('')
    try {
      const created = (await api<{ invitation: InvitationView }>('pairings', { method: 'POST', body: {} })).invitation
      setQr('')
      setInvitation(created)
      setNow(Date.now())
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const share = async (url: string) => {
    try {
      await navigator.share({ title: PAIRING_COPY.shareTitle, url })
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) void copy(url)
    }
  }
  if (invitation === null || expired)
    return (
      <div className="pair-empty">
        <p>{PAIRING_COPY.intro}</p>
        {expired && <InlineNotice tone="neutral">{PAIRING_COPY.expired}</InlineNotice>}
        <Button
          variant="primary"
          icon={QrCode}
          loading={busy}
          onClick={() => {
            void create()
          }}>
          {PAIRING_COPY.create}
        </Button>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
      </div>
    )
  return (
    <div className="pair-ready">
      <div className="pair-qr">{qr ? <img src={qr} alt={PAIRING_COPY.qrAlt} width={200} height={200} /> : <Spinner size={20} />}</div>
      <div className="pair-steps">
        <ol>
          {PAIRING_COPY.steps.map((step, index) => (
            <li key={step}>
              <span className="pair-step-number" aria-hidden="true">
                {index + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
        <p className="pair-expiry" role="timer">
          {PAIRING_COPY.remaining(formatElapsed(remaining))}
        </p>
        <div className="pair-actions">
          {phone && typeof navigator.share === 'function' ? (
            <Button
              variant="primary"
              onClick={() => {
                void share(invitation.url)
              }}
              icon={Share2}>
              {PAIRING_COPY.share}
            </Button>
          ) : (
            <Button
              onClick={() => {
                void copy(invitation.url)
              }}
              icon={Link}>
              {copyState === 'copied' ? PAIRING_COPY.copied : PAIRING_COPY.copy}
            </Button>
          )}
          <Button
            variant="ghost"
            icon={RefreshCw}
            loading={busy}
            onClick={() => {
              void create()
            }}>
            {PAIRING_COPY.regenerate}
          </Button>
        </div>
        {copyState === 'failed' && <InlineNotice tone="warn">{PAIRING_COPY.copyBlocked}</InlineNotice>}
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
      </div>
    </div>
  )
}

/**
 * 设置 › 设备 › 手机配对, a security surface: the invitation where this device may create one (the desktop app, an HTTPS
 * entry and 管理此 Host), else a row with the reason.
 */
export function PairingSection({ tls, access, phone }: { tls: boolean; access: DeviceAccess; phone: boolean }) {
  const reason = !tls ? PAIRING_COPY.needsTls : !access.local ? PAIRING_COPY.needsDesktop : !access.admin ? PAIRING_COPY.needsAdmin : null
  return (
    <SettingsGroup title="手机配对" secure>
      {reason === null ? (
        <div className="settings-card-body pair-section">
          <PhonePairing phone={phone} />
        </div>
      ) : (
        <SettingsRow leading={<IconTile icon={QrCode} />} title="配对二维码" description={reason} />
      )}
    </SettingsGroup>
  )
}
