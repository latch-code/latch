import { useState, type FormEvent, type ReactNode } from 'react'
import { Check, KeyRound, RefreshCw } from 'lucide-react'
import { acceptableName, enrollmentName, pendingInvitation, useEnrollment, type EnrolledResult } from '../core/enrollment.ts'
import { useCountdown } from '../hooks/useCountdown.ts'
import { ICON_STROKE, Spinner } from '../icons.tsx'
import { DEVICE_NAME_INVALID_TEXT, ENROLLMENT_REASON_TEXT } from '../core/securityCopy.ts'
import type { AuthState } from '../core/useHarness.ts'
import { BrandMark, InlineAlert } from './ui.tsx'

const COPY = {
  title: '连接到 Latch',
  local: '这台设备会生成自己的密钥。提交后，请在运行 Latch 的电脑上核对指纹，并用 Touch ID 或登录密码确认。',
  invited: '已收到配对邀请。提交后，请在运行 Latch 的电脑上核对指纹并确认。',
  invitationRequired:
    '手机或其他电脑需要配对邀请。请在电脑上的 Latch 桌面端「设备」页生成配对二维码，或在电脑上运行 pnpm latch device invite。',
  submit: '请求本机确认',
  waiting: '等待本机确认',
  fingerprint: '设备指纹',
  compare: '请确认电脑上显示的指纹与下面完全一致：',
  completing: '正在完成登记…',
  confirmFailed: '登记已完成，但还没能读取执行端状态。',
  denied: '本机拒绝了此设备。',
  expired: '本机确认已超时，请重新提交。',
  offlineField: '离线登记码',
  offlineSubmit: '使用离线登记码',
  unsupported: '此浏览器无法在当前地址安全地保存设备密钥。请使用最新版 Chrome、Edge、Firefox 或 Safari，或使用 Latch 桌面端。',
  mismatch: '服务器返回的指纹与本机计算的不一致，已停止登记。',
  legacyTitle: '此设备需要在本机重新确认',
  legacyBody: 'Latch 已升级设备凭据，旧的登录状态不再有效。请提交确认请求，并在运行 Latch 的电脑上核对指纹。',
  legacySubmit: '在本机重新确认',
  oldHost: '此 Host 版本过旧，请在电脑上重启 Latch。',
  admin: '管理此 Host（模型服务、插件、项目和设备）',
} as const

const FIXED_SCOPES = ['查看会话', '发起和继续会话', '批准普通操作']
/** The desktop shell enrolls on the Host's own socket and receives every scope. */
const DESKTOP_SCOPES = [
  '查看会话',
  '发起和继续会话',
  '批准普通操作',
  '批准高风险操作',
  '管理此 Host（模型服务、插件、项目和设备）',
  '设置密钥',
]

function unavailableText(message: string | undefined): string {
  const reason = (message ?? '').trim().replace(/[。.]+$/, '')
  return `本机确认不可用：${reason || '未知原因'}。可以停止 Host 后运行 pnpm latch device enroll --offline，再在下方填写离线登记码。`
}

function Shell({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="enroll-page">
      <main className="enroll-card" aria-labelledby="enroll-title">
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
      <InlineAlert
        tone="error"
        action={
          <span className="banner-actions">
            <button type="button" className="text-button" onClick={onNewSession}>
              回到新会话
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                location.reload()
              }}>
              重新加载
            </button>
          </span>
        }>
        界面出错，当前内容无法显示。
      </InlineAlert>
    </Shell>
  )
}

/** Before the Host has answered: a quiet loading state, or the network error with a retry. */
export function ConnectScreen({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <Shell title={COPY.title}>
      {error ? (
        <InlineAlert
          tone="warn"
          action={
            <button type="button" className="text-button" onClick={onRetry}>
              重试
            </button>
          }>
          {error}
        </InlineAlert>
      ) : (
        <p className="loading-line enroll-loading" role="status">
          <Spinner size={16} />
          正在连接执行端…
        </p>
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
          核对码 <code>{hash}</code>
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
  return (
    <section className="enroll-waiting" aria-labelledby="enroll-waiting-title">
      <div className="enroll-status">
        <span className="presence-pulse" aria-hidden="true" />
        <h2 id="enroll-waiting-title">{COPY.waiting}</h2>
        <span className="enroll-timer" role="timer">
          剩余 {seconds} 秒
        </span>
      </div>
      <p className="enroll-compare">{COPY.compare}</p>
      <Fingerprint value={fingerprint} hash={hash} />
      <span className="countdown-track" aria-hidden="true">
        <i style={{ width: `${Math.round(fraction * 100)}%` }} />
      </span>
      <button type="button" className="button secondary block" onClick={onCancel}>
        取消
      </button>
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
  const reason = ENROLLMENT_REASON_TEXT[auth.reason]
  const title = legacy ? COPY.legacyTitle : COPY.title
  const description = legacy ? COPY.legacyBody : invited ? COPY.invited : COPY.local

  if (step.kind === 'loading')
    return (
      <Shell title={title}>
        <p className="loading-line enroll-loading" role="status">
          <Spinner size={16} />
          正在连接执行端…
        </p>
      </Shell>
    )
  if (step.kind === 'old-host')
    return (
      <Shell title={COPY.title}>
        <InlineAlert tone="info">{COPY.oldHost}</InlineAlert>
      </Shell>
    )
  if (step.kind === 'load-failed')
    return (
      <Shell title={title}>
        <InlineAlert
          tone="warn"
          action={
            <button
              type="button"
              className="text-button"
              onClick={() => {
                void enrollment.reload()
              }}>
              重试
            </button>
          }>
          {step.message}
        </InlineAlert>
      </Shell>
    )
  if (step.kind === 'unsupported')
    return (
      <Shell title={title}>
        <InlineAlert tone="error">{COPY.unsupported}</InlineAlert>
      </Shell>
    )
  if (step.kind === 'invitation-required')
    return (
      <Shell title={COPY.title}>
        <InlineAlert tone="info">{COPY.invitationRequired}</InlineAlert>
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
        <p className="loading-line enroll-loading" role="status">
          <Spinner size={16} />
          {COPY.completing}
        </p>
      </Shell>
    )
  if (step.kind === 'confirm-failed')
    return (
      <Shell title={title}>
        <InlineAlert
          tone="warn"
          action={
            <button
              type="button"
              className="text-button"
              onClick={() => {
                void enrollment.retryConfirm()
              }}>
              重试
            </button>
          }>
          {COPY.confirmFailed}
          {step.message}
        </InlineAlert>
      </Shell>
    )

  const presenceDown = info?.presence.status === 'unavailable'
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
      {reason && !legacy && <InlineAlert tone={auth.reason === 'device-revoked' ? 'error' : 'warn'}>{reason}</InlineAlert>}
      {outcome && <InlineAlert tone="error">{outcome}</InlineAlert>}
      {presenceDown && <InlineAlert tone="warn">{unavailableText(info?.presence.message)}</InlineAlert>}
      <form
        className="enroll-form"
        onSubmit={event => {
          send(event, offlineOnly)
        }}>
        <label className="field">
          <span>设备名称</span>
          <input
            value={name}
            onChange={event => {
              setName(event.target.value)
            }}
            placeholder={acceptableName(legacyName) ?? '例如：我的手机'}
            autoComplete="off"
            maxLength={80}
            disabled={busy}
            aria-invalid={chosenName === null}
            aria-describedby={chosenName === null ? 'enroll-name-error' : undefined}
          />
          {chosenName === null && (
            <small id="enroll-name-error" className="field-hint is-error">
              {DEVICE_NAME_INVALID_TEXT}
            </small>
          )}
        </label>
        <fieldset className="scope-list" disabled={busy}>
          <legend>此设备的权限</legend>
          {(electron ? DESKTOP_SCOPES : FIXED_SCOPES).map(label => (
            <div key={label} className="scope-item is-fixed">
              <span className="scope-check" aria-hidden="true">
                <Check size={12} strokeWidth={2.5} />
              </span>
              <span>{label}</span>
            </div>
          ))}
          {!electron && (
            <label className="scope-item">
              <input
                type="checkbox"
                checked={adminChecked}
                onChange={event => {
                  setAdmin(event.target.checked)
                }}
              />
              <span>{COPY.admin}</span>
            </label>
          )}
        </fieldset>
        {offlineOffered && (offlineOnly || showOffline) && (
          <label className="field">
            <span>{COPY.offlineField}</span>
            <input
              value={offlineCode}
              onChange={event => {
                setOfflineCode(event.target.value)
              }}
              placeholder="lpo1-…"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </label>
        )}
        {offlineOnly ? (
          <button type="submit" className="button primary block" disabled={busy || chosenName === null || !offlineCode.trim()}>
            {busy ? <Spinner size={16} /> : <KeyRound size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            {COPY.offlineSubmit}
          </button>
        ) : (
          <>
            <button type="submit" className="button primary block" disabled={busy || chosenName === null}>
              {busy ? <Spinner size={16} /> : outcome ? <RefreshCw size={16} strokeWidth={ICON_STROKE} aria-hidden="true" /> : null}
              {legacy ? COPY.legacySubmit : COPY.submit}
            </button>
            {offlineOffered
              && (showOffline ? (
                <button
                  type="button"
                  className="button secondary block"
                  disabled={busy || chosenName === null || !offlineCode.trim()}
                  onClick={event => {
                    send(event, true)
                  }}>
                  {COPY.offlineSubmit}
                </button>
              ) : (
                <button
                  type="button"
                  className="text-button enroll-offline-toggle"
                  onClick={() => {
                    setShowOffline(true)
                  }}>
                  {COPY.offlineSubmit}
                </button>
              ))}
          </>
        )}
      </form>
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
    </Shell>
  )
}
