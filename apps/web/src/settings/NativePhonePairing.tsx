import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { pairingQr } from './pairingQr.ts'
import { Ban, ChevronDown, Plus, QrCode, RefreshCw, Settings2, Trash2 } from 'lucide-react'
import type { NativeLinkInfo, NativePairingInvitation } from '@latch/protocol'
import { Button, Checkbox, Collapse, InlineNotice, Spinner, TextAreaField, TextField, ValuePicker } from '@latch/ui'
import { api, inlineError, isUncertain } from '../core/api.ts'
import { withConfirmation } from '../core/confirmations.ts'
import { NATIVE_LINK_COPY as COPY, PAIRING_COPY } from '../core/securityCopy.ts'
import { CopyButton } from '../components/ui.tsx'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { Modal, ModalHeader } from '../components/overlays.tsx'
import { formatElapsed } from '../format.ts'
import { SettingsGroup, SettingsRow } from './common.tsx'
import { WaitingEnrollments } from './WaitingEnrollments.tsx'

type RelayDraft = { relayId: string; url: string; spkiHash: string; registrationKey: string; clearKey: boolean; hasKey: boolean }
function NativeConnectionForm({
  info,
  phone,
  onClose,
  onSaved,
}: {
  info: NativeLinkInfo
  phone: boolean
  onClose(): void
  onSaved(info: NativeLinkInfo): void
}) {
  const [direct, setDirect] = useState(info.direct !== null)
  const [baseHash] = useState(info.configHash)
  const [address, setAddress] = useState(info.direct?.host ?? info.addresses[0]?.address ?? '')
  const [port, setPort] = useState(String(info.direct?.port ?? 0))
  const [directoryEnabled, setDirectoryEnabled] = useState(Boolean(info.directory))
  const [directoryAnchors, setDirectoryAnchors] = useState(info.directory?.anchors.join('\n') ?? '')
  const [directoryMirrors, setDirectoryMirrors] = useState(info.directory?.mirrors.join('\n') ?? '')
  const [relays, setRelays] = useState<RelayDraft[]>(() =>
    info.relays.map(node => ({ ...node, registrationKey: '', clearKey: false, hasKey: node.hasRegistrationKey })),
  )
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const pending = useRef<{ fingerprint: string; body: object } | undefined>(undefined)
  const edit = (index: number, patch: Partial<RelayDraft>) =>
    setRelays(previous => previous.map((item, position) => (position === index ? { ...item, ...patch } : item)))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    const fields = {
      configHash: baseHash,
      direct: direct ? { host: address, port: Number(port) } : null,
      ...('directory' in info
        ? {
            directory: directoryEnabled
              ? {
                  anchors: directoryAnchors
                    .split(/\r?\n/u)
                    .map(value => value.trim().toLowerCase())
                    .filter(Boolean),
                  mirrors: directoryMirrors
                    .split(/\r?\n/u)
                    .map(value => value.trim())
                    .filter(Boolean),
                }
              : null,
          }
        : {}),
      relays: relays.map(node => ({
        relayId: node.relayId.trim().toLowerCase(),
        url: (() => {
          try {
            return new URL(node.url.trim()).href
          } catch {
            return node.url.trim()
          }
        })(),
        spkiHash: node.spkiHash.replace(/[:\s]/gu, '').toLowerCase(),
        ...(node.clearKey
          ? { registrationKey: null }
          : node.registrationKey.trim()
            ? { registrationKey: node.registrationKey.trim() }
            : {}),
      })),
    }
    const fingerprint = JSON.stringify(fields)
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, body: { ...fields, requestId: crypto.randomUUID() } }
    const body = pending.current.body
    try {
      const next = await withConfirmation(confirmation =>
        api<NativeLinkInfo>('native/config', { method: 'PUT', body, ...(confirmation ? { confirmation } : {}) }),
      )
      onSaved(next)
      onClose()
    } catch (cause) {
      setError(inlineError(cause))
      setBusy(false)
    }
  }
  return (
    <Modal
      label={COPY.configure}
      className="native-connect-dialog"
      secure
      variant={phone ? 'sheet' : 'dialog'}
      onClose={() => {
        if (!busy) onClose()
      }}>
      <ModalHeader
        title={COPY.configure}
        onClose={() => {
          if (!busy) onClose()
        }}
      />
      <form
        onSubmit={event => {
          void submit(event)
        }}>
        <div className="ui-modal-body native-config-body" data-secure="">
          <fieldset className="native-config-group" disabled={busy}>
            <Checkbox
              label={COPY.direct}
              checked={direct}
              disabled={info.directManaged || (!direct && info.addresses.length === 0)}
              onChange={event => setDirect(event.target.checked)}
            />
            {info.directManaged ? (
              <p className="settings-hint">{COPY.managed}</p>
            ) : (
              direct && (
                <>
                  <ValuePicker
                    label={COPY.address}
                    value={address}
                    options={[
                      { value: 'auto', label: '自动选择网络' },
                      ...info.addresses.map(item => ({ value: item.address, label: item.address, description: item.interface })),
                    ]}
                    onValueChange={value => setAddress(value)}
                  />
                  <TextField
                    label={COPY.port}
                    type="number"
                    min={0}
                    max={65535}
                    step={1}
                    value={port}
                    onChange={event => setPort(event.target.value)}
                    hint={COPY.portHint}
                  />
                </>
              )
            )}
            {!info.directManaged && info.addresses.length === 0 && <p className="settings-hint">{COPY.noAddress}</p>}
          </fieldset>
          {'directory' in info && (
            <fieldset className="native-config-group" disabled={busy}>
              <Checkbox label={COPY.directory} checked={directoryEnabled} onChange={event => setDirectoryEnabled(event.target.checked)} />
              <p className="settings-hint">{COPY.directoryHint}</p>
              {directoryEnabled && (
                <>
                  <TextAreaField
                    label={COPY.directoryAnchors}
                    hint={COPY.directoryAnchorsHint}
                    rows={2}
                    maxLength={160}
                    value={directoryAnchors}
                    onChange={event => setDirectoryAnchors(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                  <TextAreaField
                    label={COPY.directoryMirrors}
                    hint={COPY.directoryMirrorsHint}
                    rows={4}
                    maxLength={8400}
                    value={directoryMirrors}
                    onChange={event => setDirectoryMirrors(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                </>
              )}
            </fieldset>
          )}
          {relays.map((node, index) => (
            <fieldset key={index} className="native-config-group" disabled={busy}>
              <div className="native-config-heading">
                <strong>{COPY.relay(index + 1)}</strong>
                <Button
                  variant="ghost"
                  icon={Trash2}
                  aria-label={COPY.removeRelay(index + 1)}
                  onClick={() => setRelays(previous => previous.filter((_, position) => position !== index))}>
                  {COPY.remove}
                </Button>
              </div>
              <TextField
                label={COPY.relayUrl}
                placeholder="https://relay.example/"
                value={node.url}
                autoComplete="off"
                required
                onChange={event => edit(index, { url: event.target.value })}
              />
              <TextField
                label={COPY.relayId}
                value={node.relayId}
                maxLength={32}
                autoComplete="off"
                required
                onChange={event => edit(index, { relayId: event.target.value })}
                hint={COPY.providedByOperator}
              />
              <TextField
                label={COPY.spki}
                value={node.spkiHash}
                maxLength={95}
                autoComplete="off"
                required
                onChange={event => edit(index, { spkiHash: event.target.value })}
              />
              <TextField
                label={COPY.registrationKey}
                type="password"
                value={node.registrationKey}
                autoComplete="new-password"
                maxLength={48}
                disabled={node.clearKey}
                onChange={event => edit(index, { registrationKey: event.target.value })}
                hint={node.hasKey ? COPY.keyKept : COPY.keyOptional}
              />
              <Checkbox label={COPY.noKey} checked={node.clearKey} onChange={event => edit(index, { clearKey: event.target.checked })} />
            </fieldset>
          ))}
          {relays.length < 4 && (
            <Button
              icon={Plus}
              disabled={busy}
              onClick={() =>
                setRelays(previous => [
                  ...previous,
                  { relayId: '', url: '', spkiHash: '', registrationKey: '', clearKey: false, hasKey: false },
                ])
              }>
              {COPY.addRelay}
            </Button>
          )}
          <p className="settings-hint">{COPY.relayPrivacy}</p>
          {error && <InlineNotice tone="error">{error}</InlineNotice>}
          <InlineConfirm active={busy} />
        </div>
        <footer className="ui-modal-footer">
          <Button size="md" disabled={busy} onClick={onClose}>
            {COPY.cancel}
          </Button>
          <Button
            size="md"
            variant="primary"
            type="submit"
            loading={busy}
            disabled={busy || (direct && !address) || !Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535}>
            {COPY.save}
          </Button>
        </footer>
      </form>
    </Modal>
  )
}

function NativeCode({ autoStart = false, scopeSelection = false }: { autoStart?: boolean; scopeSelection?: boolean }) {
  const [invitation, setInvitation] = useState<NativePairingInvitation | null>(null),
    [qr, setQr] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [now, setNow] = useState(Date.now)
  const [includePersonal, setIncludePersonal] = useState(true)
  const remaining = invitation ? Date.parse(invitation.expiresAt) - now : 0
  const started = useRef(false)
  useEffect(() => {
    if (!invitation) return
    let active = true
    void pairingQr(invitation.payload, {
      width: 600,
      margin: 2,
      errorCorrectionLevel: 'L',
      color: { dark: '#1d1c1a', light: '#ffffff' },
    })
      .then(value => {
        if (active) setQr(value)
      })
      .catch(() => {
        if (active) setError(COPY.qrFailed)
      })
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [invitation])
  const create = async () => {
    setBusy(true)
    setError('')
    try {
      const dataScope = includePersonal ? 'all' : 'work'
      const answer = await api<{ invitation: NativePairingInvitation }>('native/pairings', {
        method: 'POST',
        body: scopeSelection ? { dataScope } : {},
      })
      if (scopeSelection && answer.invitation.dataScope !== dataScope) throw new Error(COPY.scopeUnconfirmed)
      setQr('')
      setInvitation(answer.invitation)
      setNow(Date.now())
    } catch (cause) {
      setError(inlineError(cause))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (autoStart && !started.current) {
      started.current = true
      void create()
    }
  }, [autoStart])
  return (
    <>
      {scopeSelection && (
        <Checkbox
          label={COPY.personalAccess}
          description={COPY.personalHint}
          checked={includePersonal}
          disabled={busy}
          onChange={event => {
            setIncludePersonal(event.target.checked)
            setInvitation(null)
            setQr('')
          }}
        />
      )}
      {!invitation || remaining <= 0 ? (
        <div className="pair-empty">
          <p>{COPY.intro}</p>
          {invitation && <InlineNotice>{PAIRING_COPY.expired}</InlineNotice>}
          <Button
            variant="primary"
            icon={QrCode}
            loading={busy}
            onClick={() => {
              void create()
            }}>
            {PAIRING_COPY.create}
          </Button>
        </div>
      ) : (
        <div className="pair-ready">
          <div className="pair-qr">{qr ? <img src={qr} alt={COPY.qrAlt} width={200} height={200} /> : <Spinner size={20} />}</div>
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
            <p className="pair-expiry" role="timer">
              {PAIRING_COPY.remaining(formatElapsed(remaining))}
            </p>
            {invitation.dataScope && (
              <p className="settings-hint">{invitation.dataScope === 'all' ? COPY.personalScope : COPY.workScope}</p>
            )}
            <div className="pair-actions">
              <CopyButton text={invitation.payload} label={COPY.copy} />
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
          </div>
        </div>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <WaitingEnrollments />
    </>
  )
}

export function NativePairingSection({
  info,
  phone,
  onChanged,
  children,
  scopeSelection = false,
}: {
  info: NativeLinkInfo
  phone: boolean
  onChanged(info: NativeLinkInfo): void
  children?: ReactNode
  scopeSelection?: boolean
}) {
  const [editing, setEditing] = useState(false),
    [legacy, setLegacy] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [autoStart, setAutoStart] = useState(false)
  const enableRequest = useRef<object | undefined>(undefined)
  const enableFlight = useRef(false)
  const enable = async () => {
    if (enableFlight.current) return
    enableFlight.current = true
    setBusy(true)
    setError('')
    enableRequest.current ??= {
      requestId: crypto.randomUUID(),
      configHash: info.configHash,
      direct: { host: 'auto', port: 0 },
      relays: info.relays.map(({ relayId, url, spkiHash }) => ({ relayId, url, spkiHash })),
    }
    try {
      const next = await withConfirmation(confirmation =>
        api<NativeLinkInfo>('native/config', {
          method: 'PUT',
          body: enableRequest.current,
          ...(confirmation ? { confirmation } : {}),
        }),
      )
      setAutoStart(true)
      onChanged(next)
    } catch (cause) {
      setError(inlineError(cause))
      if (!isUncertain(cause)) enableRequest.current = undefined
    } finally {
      enableFlight.current = false
      setBusy(false)
    }
  }
  const pause = async () => {
    setBusy(true)
    setError('')
    try {
      await withConfirmation(confirmation =>
        api(`native/input/${info.inputsPaused ? 'resume' : 'pause'}`, {
          method: 'POST',
          body: {},
          ...(confirmation ? { confirmation } : {}),
        }),
      )
      onChanged(await api<NativeLinkInfo>('native/info'))
    } catch (cause) {
      setError(inlineError(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <SettingsGroup title={COPY.title} secure>
        <SettingsRow
          title={COPY.app}
          description={info.enabled ? COPY.configured : COPY.disabled}
          trailing={
            !info.enabled ? (
              <Button
                variant="primary"
                loading={busy}
                onClick={() => {
                  void enable()
                }}>
                {COPY.enable}
              </Button>
            ) : undefined
          }
        />
        {info.direct && !info.listening && (
          <div className="settings-card-body">
            <InlineNotice tone="warn">{COPY.addressChanged}</InlineNotice>
          </div>
        )}
        {info.enabled && (
          <div className="settings-card-body pair-section">
            <NativeCode autoStart={autoStart} scopeSelection={scopeSelection} />
          </div>
        )}
        <SettingsRow
          title={COPY.inputs}
          description={info.inputsPaused ? COPY.paused : COPY.inputsReady}
          trailing={
            <Button
              disabled={busy}
              loading={busy}
              icon={Ban}
              onClick={() => {
                void pause()
              }}>
              {info.inputsPaused ? COPY.resume : COPY.pause}
            </Button>
          }
        />
        <InlineConfirm active={busy} />
        <SettingsRow
          title={COPY.options}
          description={COPY.optionsHint}
          trailing={
            <Button icon={Settings2} onClick={() => setEditing(true)}>
              {COPY.configure}
            </Button>
          }
        />
        {error && (
          <div className="settings-card-body">
            <InlineNotice tone="error">{error}</InlineNotice>
          </div>
        )}
        {children && (
          <>
            <SettingsRow
              title={COPY.browser}
              trailing={
                <Button variant="ghost" icon={ChevronDown} aria-expanded={legacy} onClick={() => setLegacy(!legacy)}>
                  {legacy ? COPY.collapse : COPY.expand}
                </Button>
              }
            />
            <Collapse open={legacy}>{children}</Collapse>
          </>
        )}
      </SettingsGroup>
      {editing && <NativeConnectionForm info={info} phone={phone} onClose={() => setEditing(false)} onSaved={onChanged} />}
    </>
  )
}
