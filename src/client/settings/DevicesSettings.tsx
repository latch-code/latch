import { useCallback, useEffect, useState, type FormEvent } from 'react'
import QRCode from 'qrcode'
import { Globe, Laptop, Link, Monitor, QrCode, Share2, Smartphone } from 'lucide-react'
import { escapeSecurityText, isAcceptableDeviceName } from '../../shared/text.ts'
import { LISTENER_LABELS, SCOPE_LABELS, type AppSnapshot, type Device, type DeviceScope, type InvitationView } from '../../shared/types.ts'
import { api, errorMessage, inlineError } from '../api.ts'
import { withConfirmation } from '../confirmations.ts'
import { dateTime, formatElapsed, looksLikePhone, relativeTime } from '../format.ts'
import { ICON_STROKE, Spinner, type LucideIcon } from '../icons.tsx'
import { DEV_MODE_TEXT, hostView, type DeviceAccess } from '../permissions.ts'
import { DEVICE_NAME_INVALID_TEXT, LOCAL_ONLY_TEXT } from '../securityCopy.ts'
import { ConfirmDialog, Modal, ModalHeader } from '../components/overlays.tsx'
import { Badge, InlineAlert, useCopy } from '../components/ui.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { useViewport } from '../breakpoints.ts'
import { Loading, SectionHeading } from './common.tsx'

const STATUS: Record<Device['status'], { label: string; tone: 'neutral' | 'warn' | 'err' | 'ok' }> = {
  active: { label: '正常', tone: 'ok' },
  review: { label: '待复核（仅查看）', tone: 'warn' },
  revoked: { label: '已撤销', tone: 'err' },
  'legacy-pending': { label: '需重新确认', tone: 'warn' },
}
const SCOPE_ORDER: DeviceScope[] = ['view', 'run', 'approve:standard', 'approve:elevated', 'admin', 'secrets']
/** Granting these is possible only for devices enrolled on the Host's own desktop. */
const LOCAL_SCOPES = new Set<DeviceScope>(['approve:elevated', 'secrets'])

const scopeText = (scopes: readonly DeviceScope[]) =>
  SCOPE_ORDER.filter(scope => scopes.includes(scope))
    .map(scope => SCOPE_LABELS[scope])
    .join('、') || '无'
/** Names recorded before the Host checked them may still hide characters, so they are shown escaped. */
const deviceLabel = (name: string) => escapeSecurityText(name) || '未命名设备'
export const revokeText = (name: string) => `撤销「${deviceLabel(name)}」？由它邀请配对的设备会降为仅查看，等待复核。`

function deviceIcon(device: Pick<Device, 'listener' | 'name'>): LucideIcon {
  if (device.listener === 'unix') return Monitor
  if (device.listener === 'loopback-tcp') return Globe
  return looksLikePhone(device.name) ? Smartphone : Laptop
}

function StatusBadge({ status }: { status: Device['status'] }) {
  return <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>
}

function ThisDevice({ device, devMode, onChanged }: { device: AppSnapshot['device']; devMode: boolean; onChanged: () => void }) {
  const [name, setName] = useState(device.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const nameInvalid = name.trim() !== '' && !isAcceptableDeviceName(name.trim())
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || nameInvalid || name.trim() === device.name) return
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      await api('devices/current', { method: 'PATCH', body: { name: name.trim() } })
      setSaved(true)
      onChanged()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const Icon = deviceIcon(device)
  return (
    <section className="settings-group" aria-labelledby="this-device">
      <h4 id="this-device">此设备</h4>
      <div className="device-card">
        <span className="device-avatar is-large" aria-hidden="true">
          <Icon size={18} strokeWidth={ICON_STROKE} />
        </span>
        <div className="device-card-main">
          <form
            className="inline-form"
            onSubmit={event => {
              void save(event)
            }}>
            <label className="field">
              <span>设备名称</span>
              <input
                value={name}
                maxLength={80}
                autoComplete="off"
                aria-invalid={nameInvalid}
                onChange={event => {
                  setName(event.target.value)
                  setSaved(false)
                }}
              />
              {nameInvalid && <small className="field-hint is-error">{DEVICE_NAME_INVALID_TEXT}</small>}
            </label>
            <button
              type="submit"
              className="button secondary"
              disabled={busy || !name.trim() || nameInvalid || name.trim() === device.name}>
              {busy && <Spinner size={14} />}保存名称
            </button>
          </form>
          {saved && (
            <span className="settings-saved" role="status">
              已保存
            </span>
          )}
          <dl className="device-facts">
            <div>
              <dt>连接方式</dt>
              <dd>{LISTENER_LABELS[device.listener]}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>
                <StatusBadge status={device.status} />
              </dd>
            </div>
            {device.fingerprint && (
              <div>
                <dt>设备指纹</dt>
                <dd>
                  <code className="fingerprint-inline">{device.fingerprint}</code>
                </dd>
              </div>
            )}
            <div>
              <dt>权限</dt>
              <dd>{scopeText(device.scopes)}</dd>
            </div>
            <div>
              <dt>登记有效期</dt>
              <dd>{dateTime(device.credentialExpiresAt) || '—'}</dd>
            </div>
          </dl>
          <div className="device-card-actions">
            <button
              type="button"
              className="text-button danger-text"
              onClick={() => {
                setRevoking(true)
              }}>
              撤销此设备
            </button>
          </div>
        </div>
      </div>
      {devMode && (
        <p className="dev-note">
          <span className="dev-chip" aria-hidden="true">
            开发版
          </span>
          {DEV_MODE_TEXT}。此版本未经签名发布，能修改本机文件的程序也能修改 Host 与桌面端。
        </p>
      )}
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      {revoking && (
        <ConfirmDialog
          title="撤销此设备"
          danger
          confirmLabel="撤销此设备"
          message={revokeText(device.name)}
          onClose={() => {
            setRevoking(false)
          }}
          onConfirm={async () => {
            try {
              await api('devices/current', { method: 'DELETE' })
            } catch (cause) {
              throw new Error(errorMessage(cause))
            }
            onChanged()
          }}
        />
      )}
    </section>
  )
}

/** Raising a device's scopes needs a local confirmation on the Host's desktop; lowering works from any admin device. */
function ScopeDialog({ device, local, onClose, onSaved }: { device: Device; local: boolean; onClose: () => void; onSaved: () => void }) {
  const phone = useViewport() === 'phone'
  const offered = SCOPE_ORDER.filter(scope => device.listener === 'unix' || !LOCAL_SCOPES.has(scope))
  const [scopes, setScopes] = useState<DeviceScope[]>(() =>
    device.status === 'review'
      ? offered.filter(scope => scope !== 'admin' && !LOCAL_SCOPES.has(scope))
      : device.scopes.filter(scope => offered.includes(scope)),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const raising = device.status === 'review' || scopes.some(scope => !device.scopes.includes(scope))
  const blocked = raising && !local
  const toggle = (scope: DeviceScope, on: boolean) => {
    setScopes(previous => (on ? [...previous, scope] : previous.filter(item => item !== scope)))
  }
  const submit = async () => {
    setBusy(true)
    setError('')
    const body = { scopes: SCOPE_ORDER.filter(scope => scope === 'view' || scopes.includes(scope)) }
    try {
      await withConfirmation(confirmation =>
        api(`devices/${encodeURIComponent(device.id)}`, { method: 'PATCH', body, ...(confirmation ? { confirmation } : {}) }),
      )
      onSaved()
      onClose()
    } catch (cause) {
      setError(inlineError(cause))
      setBusy(false)
    }
  }
  return (
    <Modal
      label="调整权限"
      variant={phone ? 'sheet' : 'dialog'}
      onClose={() => {
        if (!busy) onClose()
      }}>
      <ModalHeader title={`调整权限：${deviceLabel(device.name)}`} onClose={onClose} />
      <div className="modal-body">
        <fieldset className="scope-list" disabled={busy}>
          <legend>此设备的权限</legend>
          {offered.map(scope => (
            <label key={scope} className="scope-item">
              <input
                type="checkbox"
                checked={scope === 'view' || scopes.includes(scope)}
                disabled={scope === 'view'}
                onChange={event => {
                  toggle(scope, event.target.checked)
                }}
              />
              <span>{SCOPE_LABELS[scope]}</span>
            </label>
          ))}
        </fieldset>
        {blocked && <p className="settings-hint">{LOCAL_ONLY_TEXT}</p>}
        {error && <InlineAlert tone="error">{error}</InlineAlert>}
      </div>
      <footer className="modal-footer">
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy || blocked}
          onClick={() => {
            void submit()
          }}>
          {busy && <Spinner size={14} />}
          {raising ? '授予权限（需要本机确认）' : '保存权限'}
        </button>
      </footer>
    </Modal>
  )
}

function RegisteredDevices({ currentId, local, onChanged }: { currentId: string; local: boolean; onChanged: () => void }) {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [error, setError] = useState('')
  const [revoking, setRevoking] = useState<Device | null>(null)
  const [editing, setEditing] = useState<Device | null>(null)
  const load = useCallback(async () => {
    try {
      setDevices((await api<{ devices: Device[] }>('devices')).devices)
      setError('')
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  const order = (device: Device) => (device.status === 'revoked' ? 2 : device.status === 'legacy-pending' ? 1 : 0)
  const shown = devices === null ? [] : [...devices].sort((a, b) => order(a) - order(b) || b.lastSeenAt.localeCompare(a.lastSeenAt))
  const live = shown.filter(device => device.status !== 'revoked').length
  return (
    <section className="settings-group" aria-labelledby="registered-devices">
      <h4 id="registered-devices">已登记的设备 {devices && <span className="count">{live}</span>}</h4>
      {devices === null ? (
        error ? (
          <InlineAlert tone="error">{error}</InlineAlert>
        ) : (
          <Loading />
        )
      ) : (
        <ul className="device-list">
          {shown.map(device => {
            const Icon = deviceIcon(device)
            const self = device.id === currentId
            const revoked = device.status === 'revoked'
            return (
              <li key={device.id} className={`device-row${revoked ? ' is-revoked' : ''}`} data-device-id={device.id}>
                <span className="device-avatar" aria-hidden="true">
                  <Icon size={16} strokeWidth={ICON_STROKE} />
                </span>
                <div className="device-row-text">
                  <strong>
                    <span className="device-row-name">{device.name ? <VisibleText text={device.name} /> : '未命名设备'}</span>
                    {self && <Badge tone="accent">本机</Badge>}
                    {device.status !== 'active' && <StatusBadge status={device.status} />}
                  </strong>
                  <span>
                    {LISTENER_LABELS[device.listener]} ·{' '}
                    {revoked
                      ? `撤销于 ${relativeTime(device.revokedAt ?? '') || '未知时间'}`
                      : `最近使用 ${relativeTime(device.lastSeenAt) || '未知'}`}
                  </span>
                  {!revoked && <span className="device-row-scopes">{scopeText(device.scopes)}</span>}
                </div>
                {!revoked && !self && (
                  <div className="device-row-actions">
                    {device.status !== 'legacy-pending' && (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          setEditing(device)
                        }}>
                        权限…
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-button danger-text"
                      onClick={() => {
                        setRevoking(device)
                      }}>
                      撤销
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {error && devices !== null && <InlineAlert tone="error">{error}</InlineAlert>}
      {editing && (
        <ScopeDialog
          device={editing}
          local={local}
          onClose={() => {
            setEditing(null)
          }}
          onSaved={() => {
            onChanged()
            void load()
          }}
        />
      )}
      {revoking && (
        <ConfirmDialog
          title="撤销设备"
          danger
          confirmLabel="撤销此设备"
          message={revokeText(revoking.name)}
          onClose={() => {
            setRevoking(null)
          }}
          onConfirm={async () => {
            try {
              await api(`devices/${encodeURIComponent(revoking.id)}`, { method: 'DELETE' })
            } catch (cause) {
              throw new Error(errorMessage(cause))
            }
            onChanged()
            await load()
          }}
        />
      )}
    </section>
  )
}

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
    if (invitation === null) return
    let active = true
    setQr('')
    void QRCode.toDataURL(invitation.url, { width: 400, margin: 1, color: { dark: '#0f172a', light: '#ffffff' } })
      .then(value => {
        if (active) setQr(value)
      })
      .catch(() => {
        if (active) setError('二维码生成失败，可复制配对链接。')
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
      setInvitation((await api<{ invitation: InvitationView }>('pairings', { method: 'POST', body: {} })).invitation)
      setNow(Date.now())
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const share = async (url: string) => {
    try {
      await navigator.share({ title: 'Latch 配对链接', url })
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) void copy(url)
    }
  }
  if (invitation === null || expired)
    return (
      <div className="pair-empty">
        <p>
          生成一次性配对二维码，在手机上扫描后提交登记。二维码 10 分钟内有效，只能使用一次；对方提交后，仍需在这台电脑上核对指纹并确认。
        </p>
        {expired && <p className="settings-hint">上一个二维码已过期。</p>}
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() => {
            void create()
          }}>
          {busy ? <Spinner size={14} /> : <QrCode size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />}生成配对二维码
        </button>
        {error && <InlineAlert tone="error">{error}</InlineAlert>}
      </div>
    )
  return (
    <div className="pair-ready">
      <div className="pair-qr">{qr ? <img src={qr} alt="手机配对二维码" width={200} height={200} /> : <Spinner size={20} />}</div>
      <div className="pair-steps">
        <ol>
          <li>在手机上扫描二维码，或打开配对链接。</li>
          <li>在手机上提交登记请求。</li>
          <li>在这台电脑上核对两边显示的指纹，并用 Touch ID 或登录密码确认。</li>
        </ol>
        <p className="pair-expiry" role="timer">
          剩余 {formatElapsed(remaining)} · 仅可使用一次
        </p>
        <div className="pair-actions">
          {phone && typeof navigator.share === 'function' ? (
            <button
              type="button"
              className="button primary"
              onClick={() => {
                void share(invitation.url)
              }}>
              <Share2 size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
              分享链接
            </button>
          ) : (
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                void copy(invitation.url)
              }}>
              <Link size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {copyState === 'copied' ? '已复制' : '复制链接'}
            </button>
          )}
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => {
              void create()
            }}>
            重新生成
          </button>
        </div>
        {copyState === 'failed' && (
          <p className="settings-hint" role="alert">
            当前浏览器不允许复制。请在手机上扫描二维码。
          </p>
        )}
        {error && <InlineAlert tone="error">{error}</InlineAlert>}
      </div>
    </div>
  )
}

export function DevicesSettings({
  snapshot,
  access,
  phone,
  onChanged,
}: {
  snapshot: AppSnapshot
  access: DeviceAccess
  phone: boolean
  onChanged: () => void
}) {
  const host = hostView(snapshot)
  const pairing = !host?.tls
    ? '手机接入需要 HTTPS。请用 --tls-cert、--tls-key 和 --public-origin 启动 Host（例如用 tailscale cert 生成的证书）。'
    : !access.local
      ? '配对二维码只能在执行端电脑上的 Latch 桌面端生成，或运行 pnpm latch device invite。'
      : !access.admin
        ? '此设备没有「管理此 Host」权限'
        : null
  return (
    <>
      <SectionHeading
        title="设备"
        description="每台设备有自己的密钥和权限。新设备要在运行 Latch 的电脑上核对指纹并确认后才能连接；撤销立即生效。"
      />
      <ThisDevice device={snapshot.device} devMode={host?.devMode === true} onChanged={onChanged} />
      {access.admin && <RegisteredDevices currentId={snapshot.device.id} local={access.local} onChanged={onChanged} />}
      <section className="settings-group pair-section" aria-labelledby="phone-pairing">
        <h4 id="phone-pairing">手机配对</h4>
        {pairing === null ? <PhonePairing phone={phone} /> : <p className="settings-hint pair-hint">{pairing}</p>}
      </section>
    </>
  )
}
