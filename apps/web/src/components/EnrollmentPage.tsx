import { useState, type FormEvent, type ReactNode } from 'react'
import { Check, Fingerprint as FingerprintGlyph, KeyRound, RefreshCw } from 'lucide-react'
import { acceptableName, enrollmentName, pendingInvitation, useEnrollment, type EnrolledResult } from '../core/enrollment.ts'
import { useViewport } from '../breakpoints.ts'
import { useCountdown } from '../hooks/useCountdown.ts'
import { BROWSER_SCOPES, DESKTOP_SCOPES, DEVICE_NAME_INVALID_TEXT, ENROLLMENT_COPY, ENROLLMENT_REASON_TEXT } from '../core/securityCopy.ts'
import type { AuthState } from '../core/useHarness.ts'
import { Button, Checkbox, ICON_STROKE, InlineNotice, Loading, TextField, type ButtonSize } from '@latch/ui'
import { BrandMark } from './ui.tsx'

const COPY = ENROLLMENT_COPY

/** The Host's reason, without the full stop the sentence around it supplies. */
function unavailableText(message: string | undefined): string {
  return COPY.unavailable((message ?? '').trim().replace(/[。.]+$/, ''))
}

/** Buttons on this page: lg (44) on phones, md (32) from 768 up. */
function useButtonSize(): ButtonSize {
  return useViewport() === 'phone' ? 'lg' : 'md'
}

function Shell({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="enroll-page">
      <main className="enroll-card" data-secure="" aria-labelledby="enroll-title">
        <header className="enroll-header">
          <BrandMark size={44} />
          <h1 id="enroll-title">{title}</h1>
          {description && <p className="enroll-description">{description}</p>}
        </header>
        {children}
      </main>
    </div>
  )
}

/** The workspace failed to render; the device stays signed in and a new session view avoids the failing one. */
export function CrashScreen({ onNewSession }: { onNewSession: () => void }) {
  return (
    <Shell title="Latch">
      <InlineNotice
        tone="error"
        action={
          <span className="banner-actions">
            <Button variant="link" onClick={onNewSession}>
              回到新会话
            </Button>
            <Button
              variant="link"
              onClick={() => {
                location.reload()
              }}>
              重新加载
            </Button>
          </span>
        }>
        界面出错，当前内容无法显示。
      </InlineNotice>
    </Shell>
  )
}

/** Before the Host has answered: a quiet loading state, or the network error with a retry. */
export function ConnectScreen({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <Shell title={COPY.title}>
      {error ? (
        <InlineNotice
          tone="warn"
          action={
            <Button variant="link" onClick={onRetry}>
              {COPY.retry}
            </Button>
          }>
          {error}
        </InlineNotice>
      ) : (
        <Loading className="enroll-loading" label={COPY.connecting} />
      )}
    </Shell>
  )
}

function Fingerprint({ value, hash }: { value: string; hash?: string }) {
  return (
    <div className="fingerprint-block">
      <span className="fingerprint-label">{COPY.fingerprint}</span>
      {/* Groups are separate boxes so they wrap whole; the spaces between them keep the copied and read text exact. */}
      <code className="fingerprint" aria-label={`${COPY.fingerprint} ${value}`}>
        {value
          .split(' ')
          .flatMap((group, index) => (index === 0 ? [<span key={index}>{group}</span>] : [' ', <span key={index}>{group}</span>]))}
      </code>
      {hash && (
        <span className="fingerprint-hash">
          {COPY.hash} <code>{hash}</code>
        </span>
      )}
    </div>
  )
}

function Waiting({
  fingerprint,
  hash,
  expiresAt,
  onCancel,
}: {
  fingerprint: string
  hash?: string
  expiresAt: string
  onCancel: () => void
}) {
  const { seconds, fraction } = useCountdown(expiresAt, 120)
  const size = useButtonSize()
  return (
    <section className="enroll-waiting" aria-labelledby="enroll-waiting-title">
      <div className="enroll-status">
        <span className="presence-icon" data-tone="warn" aria-hidden="true">
          <FingerprintGlyph size={20} strokeWidth={ICON_STROKE[20]} />
        </span>
        <h2 id="enroll-waiting-title">{COPY.waiting}</h2>
        <span className="enroll-timer" role="timer">
          {COPY.remaining(seconds)}
        </span>
      </div>
      <p className="enroll-compare">{COPY.compare}</p>
      <Fingerprint value={fingerprint} hash={hash} />
      <span className="presence-track" aria-hidden="true">
        <i style={{ '--fraction': String(fraction) }} />
      </span>
      <Button size={size} block onClick={onCancel}>
        {COPY.cancel}
      </Button>
    </section>
  )
}

export function EnrollmentPage({ auth, onEnrolled }: { auth: AuthState; onEnrolled: () => Promise<EnrolledResult> }) {
  const enrollment = useEnrollment(onEnrolled)
  const { info, step, error, electron } = enrollment
  const legacyName = auth.legacyName ?? info?.legacy?.name
  const legacy = auth.reason === 'legacy-reconfirm' || legacyName !== undefined
  const invited = pendingInvitation() !== null
  const [name, setName] = useState('')
  const [admin, setAdmin] = useState<boolean | null>(null)
  const [offlineCode, setOfflineCode] = useState('')
  const [showOffline, setShowOffline] = useState(false)
  const size = useButtonSize()
  const reason = ENROLLMENT_REASON_TEXT[auth.reason]
  const title = legacy ? COPY.legacyTitle : COPY.title
  const presenceDown = info?.presence.status === 'unavailable'
  // Without local confirmation the offline code is the way in, so the intro does not promise Touch ID.
  const description = legacy ? COPY.legacyBody : invited ? COPY.invited : presenceDown ? COPY.offline : COPY.local

  if (step.kind === 'loading')
    return (
      <Shell title={title}>
        <Loading className="enroll-loading" label={COPY.connecting} />
      </Shell>
    )
  if (step.kind === 'old-host')
    return (
      <Shell title={COPY.title}>
        <InlineNotice tone="neutral">{COPY.oldHost}</InlineNotice>
      </Shell>
    )
  if (step.kind === 'load-failed')
    return (
      <Shell title={title}>
        <InlineNotice
          tone="warn"
          action={
            <Button
              variant="link"
              onClick={() => {
                void enrollment.reload()
              }}>
              {COPY.retry}
            </Button>
          }>
          {step.message}
        </InlineNotice>
      </Shell>
    )
  if (step.kind === 'unsupported')
    return (
      <Shell title={title}>
        <InlineNotice tone="error">{COPY.unsupported}</InlineNotice>
      </Shell>
    )
  if (step.kind === 'invitation-required')
    return (
      <Shell title={COPY.title}>
        <InlineNotice tone="neutral">{COPY.invitationRequired}</InlineNotice>
      </Shell>
    )
  if (step.kind === 'waiting')
    return (
      <Shell title={title}>
        <Waiting
          fingerprint={step.enrollment.fingerprint}
          hash={step.enrollment.hashDisplay}
          expiresAt={step.enrollment.expiresAt}
          onCancel={enrollment.cancel}
        />
      </Shell>
    )
  if (step.kind === 'completing')
    return (
      <Shell title={title}>
        <Loading className="enroll-loading" label={COPY.completing} />
      </Shell>
    )
  if (step.kind === 'confirm-failed')
    return (
      <Shell title={title}>
        <InlineNotice
          tone="warn"
          action={
            <Button
              variant="link"
              onClick={() => {
                void enrollment.retryConfirm()
              }}>
              {COPY.retry}
            </Button>
          }>
          {COPY.confirmFailed}
          {step.message}
        </InlineNotice>
      </Shell>
    )

  const offlineOffered = presenceDown || info?.offlineCodeAccepted === true
  const offlineOnly = presenceDown
  const adminChecked = admin ?? (info?.firstDevice === true && !invited)
  const outcome =
    step.kind === 'denied' ? COPY.denied : step.kind === 'expired' ? COPY.expired : step.kind === 'mismatch' ? COPY.mismatch : ''
  const busy = step.kind === 'submitting'
  const chosenName = enrollmentName(name, legacyName)
  const send = (event: FormEvent, useOffline: boolean) => {
    event.preventDefault()
    if (busy || chosenName === null || (useOffline && !offlineCode.trim())) return
    void enrollment.submit({ name: chosenName, admin: adminChecked, ...(useOffline ? { offlineCode: offlineCode.trim() } : {}) })
  }

  return (
    <Shell title={title} description={description}>
      {reason && !legacy && <InlineNotice tone={auth.reason === 'device-revoked' ? 'error' : 'warn'}>{reason}</InlineNotice>}
      {outcome && <InlineNotice tone="error">{outcome}</InlineNotice>}
      {presenceDown && <InlineNotice tone="warn">{unavailableText(info?.presence.message)}</InlineNotice>}
      <form
        className="enroll-form"
        onSubmit={event => {
          send(event, offlineOnly)
        }}>
        <TextField
          label={COPY.name}
          value={name}
          onChange={event => {
            setName(event.target.value)
          }}
          placeholder={acceptableName(legacyName) ?? COPY.namePlaceholder}
          autoComplete="off"
          maxLength={80}
          disabled={busy}
          error={chosenName === null ? DEVICE_NAME_INVALID_TEXT : undefined}
        />
        <fieldset className="enroll-scopes" disabled={busy}>
          <legend>{COPY.scopes}</legend>
          {(electron ? DESKTOP_SCOPES : BROWSER_SCOPES).map(label => (
            <div key={label} className="enroll-scope">
              <span className="scope-check" aria-hidden="true">
                <Check size={12} strokeWidth={ICON_STROKE[12]} />
              </span>
              <span>{label}</span>
            </div>
          ))}
          {!electron && (
            <Checkbox
              className="enroll-scope is-choice"
              label={COPY.admin}
              checked={adminChecked}
              onChange={event => {
                setAdmin(event.target.checked)
              }}
            />
          )}
        </fieldset>
        {offlineOffered && (offlineOnly || showOffline) && (
          <TextField
            label={COPY.offlineField}
            value={offlineCode}
            onChange={event => {
              setOfflineCode(event.target.value)
            }}
            placeholder="lpo1-…"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
        )}
        {offlineOnly ? (
          <Button
            type="submit"
            variant="primary"
            size={size}
            block
            icon={KeyRound}
            loading={busy}
            disabled={chosenName === null || !offlineCode.trim()}>
            {COPY.offlineSubmit}
          </Button>
        ) : (
          <>
            <Button
              type="submit"
              variant="primary"
              size={size}
              block
              icon={outcome ? RefreshCw : undefined}
              loading={busy}
              disabled={chosenName === null}>
              {legacy ? COPY.legacySubmit : COPY.submit}
            </Button>
            {offlineOffered
              && (showOffline ? (
                <Button
                  size={size}
                  block
                  disabled={busy || chosenName === null || !offlineCode.trim()}
                  onClick={event => {
                    send(event, true)
                  }}>
                  {COPY.offlineSubmit}
                </Button>
              ) : (
                <Button
                  variant="link"
                  size={size}
                  className="enroll-offline-toggle"
                  onClick={() => {
                    setShowOffline(true)
                  }}>
                  {COPY.offlineSubmit}
                </Button>
              ))}
          </>
        )}
      </form>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </Shell>
  )
}
