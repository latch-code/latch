import { useState, type FormEvent, type ReactNode } from 'react'
import { Laptop, KeyRound, RefreshCw } from 'lucide-react'
import { isLocalListener, type EnrollmentView } from '@latch/protocol'
import {
  acceptableName,
  enrollmentName,
  pendingInvitation,
  requestedScopes,
  useEnrollment,
  type EnrolledResult,
} from '../core/enrollment.ts'
import { useViewport } from '../breakpoints.ts'
import { CONNECTION_DETAILS_COPY, DEVICE_NAME_INVALID_TEXT, ENROLLMENT_COPY, ENROLLMENT_REASON_TEXT } from '../core/securityCopy.ts'
import type { AuthState } from '../core/useHarness.ts'
import { Button, ICON_STROKE, InlineNotice, Loading, TextField, type ButtonSize } from '@latch/ui'
import { ConnectionDetails } from './ConnectionDetails.tsx'
import { BrandMark } from './ui.tsx'

const COPY = ENROLLMENT_COPY

/**
 * The Host's reason, without the full stop the sentence around it supplies. Offline codes work only where the Host
 * takes them, the desktop app's socket; elsewhere the page can only wait.
 */
function unavailableText(message: string | undefined, offline: boolean): string {
  const reason = (message ?? '').trim().replace(/[。.]+$/, '')
  return offline ? COPY.unavailable(reason) : COPY.unavailableRemote(reason)
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

/** The Mac's system sheet names this device; no clock to watch, and the code to compare stays folded unless wanted. */
function Waiting({ enrollment, compare, onCancel }: { enrollment: EnrollmentView; compare: boolean; onCancel: () => void }) {
  const size = useButtonSize()
  return (
    <section className="enroll-waiting" aria-labelledby="enroll-waiting-title">
      <div className="enroll-status">
        <span className="presence-icon" data-tone="warn" aria-hidden="true">
          <Laptop size={20} strokeWidth={ICON_STROKE[20]} />
        </span>
        <h2 id="enroll-waiting-title">{COPY.waiting}</h2>
      </div>
      <p className="enroll-compare">{COPY.compare}</p>
      <ConnectionDetails
        code={enrollment.fingerprint}
        codeNote={compare ? CONNECTION_DETAILS_COPY.compareOnMac : undefined}
        reason={enrollment.reason}
        scopes={enrollment.scopes}
        dataScope={enrollment.dataScope}
      />
      <Button size={size} block onClick={onCancel}>
        {COPY.cancel}
      </Button>
    </section>
  )
}

export function EnrollmentPage({ auth, onEnrolled }: { auth: AuthState; onEnrolled: () => Promise<EnrolledResult> }) {
  const enrollment = useEnrollment(onEnrolled)
  const { info, step, error, linkAllowsAdmin, electron } = enrollment
  const legacyName = auth.legacyName ?? info?.legacy?.name
  const legacy = auth.reason === 'legacy-reconfirm' || legacyName !== undefined
  const invited = pendingInvitation() !== null
  const [name, setName] = useState('')
  const [offlineCode, setOfflineCode] = useState('')
  const [showOffline, setShowOffline] = useState(false)
  const [manageDeclined, setManageDeclined] = useState(false)
  const size = useButtonSize()
  const reason = ENROLLMENT_REASON_TEXT[auth.reason]
  const title = legacy ? COPY.legacyTitle : COPY.title
  const presenceDown = info?.presence.status === 'unavailable'
  const offlineTicket = info?.offlineCodeAccepted === true
  // Only host.sock takes offline codes; a Host of the previous build may still take them over loopback and says so in
  // offlineCodeAccepted.
  const offlineAccepted = (info !== null && isLocalListener(info.listener)) || offlineTicket
  // Without local confirmation the offline code is the way in, so the intro does not promise Touch ID.
  const description = legacy ? COPY.legacyBody : invited ? COPY.invited : presenceDown && offlineAccepted ? COPY.offline : COPY.local

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
  if (step.kind === 'waiting')
    return (
      <Shell title={title}>
        <Waiting enrollment={step.enrollment} compare={!electron} onCancel={enrollment.cancel} />
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

  const outcome =
    step.kind === 'denied' ? COPY.denied : step.kind === 'expired' ? COPY.expired : step.kind === 'mismatch' ? COPY.mismatch : ''
  // The first request that passes uses the invitation up, so after a refusal or an invalid code the next try needs a new one.
  if (step.kind === 'invitation-required' || (info?.invitationRequired === true && !invited && (step.kind === 'form' || outcome !== '')))
    return (
      <Shell title={COPY.title}>
        {reason && !legacy && <InlineNotice tone={auth.reason === 'device-revoked' ? 'error' : 'warn'}>{reason}</InlineNotice>}
        {outcome && <InlineNotice tone="error">{outcome}</InlineNotice>}
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        {info?.listener === 'loopback-tcp' ? (
          <p className="enroll-description">
            {COPY.browserNotConnected}
            <code className="enroll-command">{COPY.browserLinkCommand}</code>
          </p>
        ) : (
          <p className="enroll-description">{COPY.invitationRequired}</p>
        )}
      </Shell>
    )

  const offlineOffered = offlineAccepted && (presenceDown || offlineTicket)
  const offlineOnly = offlineAccepted && presenceDown
  // Without a local confirmation nothing else can approve this device, so there is nothing to submit yet.
  const blocked = presenceDown && !offlineAccepted
  // The inviter's ceiling decides what can be asked, and the line above the button says so with a way to turn it down: the
  // system sheet names only the device. The desktop app's invitation leaves it out, and the command line's, for a Host with
  // no desktop app to raise it later, has it. Over HTTPS a device always starts without it.
  const linkCanManage = linkAllowsAdmin && info?.listener === 'loopback-tcp'
  const wantsAdmin = linkCanManage && !manageDeclined
  const busy = step.kind === 'submitting'
  const chosenName = enrollmentName(name, legacyName)
  const send = (event: FormEvent, useOffline: boolean) => {
    event.preventDefault()
    if (busy || chosenName === null || (useOffline ? !offlineCode.trim() : blocked)) return
    void enrollment.submit({ name: chosenName, admin: wantsAdmin, ...(useOffline ? { offlineCode: offlineCode.trim() } : {}) })
  }

  return (
    <Shell title={title} description={description}>
      {reason && !legacy && <InlineNotice tone={auth.reason === 'device-revoked' ? 'error' : 'warn'}>{reason}</InlineNotice>}
      {outcome && <InlineNotice tone="error">{outcome}</InlineNotice>}
      {presenceDown && <InlineNotice tone="warn">{unavailableText(info?.presence.message, offlineAccepted)}</InlineNotice>}
      {linkCanManage && !blocked && (
        <InlineNotice
          tone={manageDeclined ? 'neutral' : 'warn'}
          action={
            <Button
              variant="link"
              disabled={busy}
              onClick={() => {
                setManageDeclined(!manageDeclined)
              }}>
              {manageDeclined ? COPY.undoDecline : COPY.declineManage}
            </Button>
          }>
          {manageDeclined ? COPY.manageDeclined : COPY.linkCanManage}
        </InlineNotice>
      )}
      <form
        className="enroll-form"
        onSubmit={event => {
          send(event, offlineOnly)
        }}>
        {electron && (
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
        )}
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
              disabled={chosenName === null || blocked}>
              {legacy ? COPY.legacySubmit : electron ? COPY.submit : COPY.connectBrowser}
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
      {!electron && chosenName !== null && <ConnectionDetails name={chosenName} scopes={requestedScopes(wantsAdmin)} dataScope="work" />}
    </Shell>
  )
}
