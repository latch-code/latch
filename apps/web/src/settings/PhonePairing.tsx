import { useEffect, useId, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { ChevronRight, Link, QrCode, RefreshCw, Share2 } from 'lucide-react'
import type { AppSnapshot, InvitationView, NativeLinkInfo } from '@latch/protocol'
import { Button, Collapse, ICON_STROKE, InlineNotice, Spinner } from '@latch/ui'
import { api, ApiError, errorMessage, inlineError } from '../core/api.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { PAIRING_COPY } from '../core/securityCopy.ts'
import { formatElapsed } from '../format.ts'
import { CopyButton, useCopy } from '../components/ui.tsx'
import { IconTile, SettingsGroup, SettingsRow } from './common.tsx'
import { PairingBlocked } from './PairingBlocked.tsx'
import { WaitingEnrollments } from './WaitingEnrollments.tsx'
import { NativePairingSection } from './NativePhonePairing.tsx'

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
        <WaitingEnrollments />
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
        <WaitingEnrollments />
      </div>
    </div>
  )
}

/**
 * A Host without its HTTPS entry: one plain sentence that phone access is not set up, an honest line that direct
 * pairing on the same network is not built yet, and the start options for an own certificate folded under a
 * disclosure with a copy button, so no command-line flag sits in the body.
 */
function PhoneAccessSetup({ native = false }: { native?: boolean } = {}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="settings-card-body pair-section pair-setup">
      <p>{PAIRING_COPY.notConfigured}</p>
      <p className="pair-pending">{native ? PAIRING_COPY.browserHttpsOnly : PAIRING_COPY.directPending}</p>
      <button
        type="button"
        className="pair-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open)
        }}>
        <ChevronRight className="chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        {PAIRING_COPY.tlsDisclosure}
      </button>
      <Collapse id={id} open={open}>
        <div className="pair-tls">
          <p>{PAIRING_COPY.tlsSteps}</p>
          <div className="pair-flags">
            {/* One flag with its value per line, so a narrow screen breaks between flags and never inside one. */}
            <code>{PAIRING_COPY.tlsFlags.split(/ (?=--)/u).join('\n')}</code>
            <CopyButton text={PAIRING_COPY.tlsFlags} label={PAIRING_COPY.copyFlags} size="xs" />
          </div>
          <p className="pair-pending">{PAIRING_COPY.tlsNote}</p>
        </div>
      </Collapse>
    </div>
  )
}

/**
 * 设置 › 设备 › 手机配对, a security surface: the invitation where this device may create one (the desktop app, an HTTPS
 * entry and 管理此 Host), how to set up phone access when the Host has no HTTPS entry, else a row with the reason and
 * where to do it, in words.
 */
export function PairingSection({
  tls,
  access,
  phone,
  snapshot,
}: {
  tls: boolean
  access: DeviceAccess
  phone: boolean
  /** Names a full-access session that would hold the phone's enrollment back. */
  snapshot?: AppSnapshot
}) {
  const [nativeInfo, setNativeInfo] = useState<NativeLinkInfo | null | undefined>(undefined)
  const [nativeError, setNativeError] = useState('')
  const nativeLoad = useRef(0)
  useEffect(() => {
    if (!access.local || !access.admin) return
    let active = true
    const load = async () => {
      const generation = ++nativeLoad.current
      try {
        const info = await api<Partial<NativeLinkInfo>>('native/info')
        if (active && generation === nativeLoad.current) {
          setNativeInfo(info.version === 1 ? (info as NativeLinkInfo) : null)
          setNativeError('')
        }
      } catch (cause) {
        if (active && generation === nativeLoad.current) {
          if (cause instanceof ApiError && cause.status === 404) setNativeInfo(null)
          else setNativeError(inlineError(cause))
        }
      }
    }
    void load()
    const timer = window.setInterval(() => {
      void load()
    }, 5000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [access.local, access.admin])
  if (access.local && access.admin && nativeInfo)
    return (
      <NativePairingSection
        info={nativeInfo}
        phone={phone}
        onChanged={next => {
          nativeLoad.current++
          setNativeInfo(next)
        }}>
        {tls ? (
          <div className="settings-card-body pair-section">
            {snapshot && <PairingBlocked snapshot={snapshot} />}
            <PhonePairing phone={phone} />
          </div>
        ) : (
          <PhoneAccessSetup native />
        )}
      </NativePairingSection>
    )
  if (access.local && access.admin && nativeInfo === undefined)
    return (
      <SettingsGroup title="连接手机" secure>
        <div className="settings-card-body">
          {nativeError ? <InlineNotice tone="error">{nativeError}</InlineNotice> : <Spinner size={14} />}
        </div>
      </SettingsGroup>
    )
  if (!tls)
    return (
      <SettingsGroup title="手机配对" secure>
        <PhoneAccessSetup />
      </SettingsGroup>
    )
  const reason = !access.local ? PAIRING_COPY.needsDesktop : !access.admin ? PAIRING_COPY.needsAdmin : null
  return (
    <SettingsGroup title="手机配对" secure>
      {reason === null ? (
        <div className="settings-card-body pair-section">
          {snapshot && <PairingBlocked snapshot={snapshot} />}
          <PhonePairing phone={phone} />
        </div>
      ) : (
        <SettingsRow leading={<IconTile icon={QrCode} />} title="配对二维码" description={reason} />
      )}
    </SettingsGroup>
  )
}
