import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Ban, Globe, KeyRound, Laptop, LockKeyhole, Monitor, Smartphone } from 'lucide-react'
import {
  escapeSecurityText,
  isAcceptableDeviceName,
  isLocalListener,
  LISTENER_LABELS,
  SCOPE_LABELS,
  type AppSnapshot,
  type Device,
  type DeviceScope,
} from '@latch/protocol'
import { api, errorMessage, inlineError } from '../core/api.ts'
import { withConfirmation } from '../core/confirmations.ts'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { dateTime, looksLikePhone, relativeTime } from '../format.ts'
import { DEV_MODE_TEXT, hostView, type DeviceAccess } from '../core/permissions.ts'
import {
  CONNECTION_DETAILS,
  DEVICE_NAME_INVALID_TEXT,
  describeFailure,
  LOCAL_ONLY_TEXT,
  NATIVE_LINK_COPY,
  presenceUnavailableText,
} from '../core/securityCopy.ts'
import { currentShell, type LatchShell } from '../core/shell.ts'
import { ConfirmDialog, Modal, ModalHeader } from '../components/overlays.tsx'
import { Badge, Button, InlineNotice, type LucideIcon, Menu, StatusPill, TextField } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { useViewport } from '../breakpoints.ts'
import { IconTile, Loading, moreButton, SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'
import { RemoteStartRow } from './RemoteStartRow.tsx'
import { PairingSection } from './PhonePairing.tsx'

const STATUS: Record<Device['status'], { label: string; tone: 'neutral' | 'warn' | 'err' | 'ok' }> = {
  active: { label: '正常', tone: 'neutral' },
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
  return <StatusPill tone={STATUS[status].tone}>{STATUS[status].label}</StatusPill>
}

function ThisDevice({ device, devMode, onChanged }: { device: AppSnapshot['device']; devMode: boolean; onChanged: () => void }) {
  const [name, setName] = useState(device.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const nameInvalid = name.trim() !== '' && !isAcceptableDeviceName(name.trim())
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || nameInvalid || name.trim() === device.name) return
    setBusy(true)
    setError('')
    try {
      await api('devices/current', { method: 'PATCH', body: { name: name.trim() } })
      onChanged()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <SettingsGroup
        title="此设备"
        caption={devMode ? `${DEV_MODE_TEXT}。此版本未经签名发布，能修改本机文件的程序也能修改 Host 与桌面端。` : undefined}>
        <form
          className="settings-row settings-form-row"
          onSubmit={event => {
            void save(event)
          }}>
          <TextField
            label="设备名称"
            value={name}
            maxLength={80}
            autoComplete="off"
            error={nameInvalid ? DEVICE_NAME_INVALID_TEXT : undefined}
            onChange={event => {
              setName(event.target.value)
            }}
          />
          <Button type="submit" disabled={busy || !name.trim() || nameInvalid || name.trim() === device.name} loading={busy}>
            保存名称
          </Button>
        </form>
        <SettingsRow
          title="状态"
          trailing={
            // A healthy device is the default state, so it is plain text; only a state to act on gets a pill.
            device.status === 'active' ? (
              <span className="settings-row-value">{STATUS.active.label}</span>
            ) : (
              <StatusBadge status={device.status} />
            )
          }
        />
        <details className="connection-details">
          <summary>{CONNECTION_DETAILS}</summary>
          <SettingsRow title="连接方式" trailing={<span className="settings-row-value">{LISTENER_LABELS[device.listener]}</span>} />
          {device.fingerprint && (
            <SettingsRow title="设备指纹" trailing={<code className="settings-row-value settings-mono">{device.fingerprint}</code>} />
          )}
        </details>
        <SettingsRow title="权限" description={scopeText(device.scopes)} />
        <SettingsRow
          title={device.native ? '最近身份验证' : '登记有效期'}
          trailing={
            <span className="settings-row-value">{dateTime(device.native?.lastVerifiedAt ?? device.credentialExpiresAt) || '—'}</span>
          }
        />
        {device.native && (
          <SettingsRow
            title="手机访问"
            description={`${NATIVE_LINK_COPY.nativeInput[device.native.input]}；${device.native.bodyVerifiedUntil ? NATIVE_LINK_COPY.bodyUntil(dateTime(device.native.bodyVerifiedUntil)) : NATIVE_LINK_COPY.bodyLocked}`}
          />
        )}
      </SettingsGroup>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </>
  )
}

/** Revoking this device: the page's last group, outlined in red. */
function RevokeThisDevice({ device, onChanged }: { device: AppSnapshot['device']; onChanged: () => void }) {
  const [revoking, setRevoking] = useState(false)
  return (
    <>
      <SettingsGroup>
        <SettingsRow
          title="撤销此设备"
          description="撤销立即生效；这台设备要重新登记并在执行端确认后才能再连接"
          trailing={
            <Button
              variant="danger"
              onClick={() => {
                setRevoking(true)
              }}>
              撤销此设备
            </Button>
          }
        />
      </SettingsGroup>
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
              throw new Error(errorMessage(cause), { cause })
            }
            onChanged()
          }}
        />
      )}
    </>
  )
}

/** Raising a device's scopes needs a local confirmation on the Host's desktop; lowering works from any admin device. */
function ScopeDialog({ device, local, onClose, onSaved }: { device: Device; local: boolean; onClose: () => void; onSaved: () => void }) {
  const phone = useViewport() === 'phone'
  const offered = SCOPE_ORDER.filter(scope => isLocalListener(device.listener) || !LOCAL_SCOPES.has(scope))
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
      <div className="ui-modal-body">
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
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <InlineConfirm active={busy} />
      </div>
      <footer className="ui-modal-footer">
        <Button size="md" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          size="md"
          variant="primary"
          icon={raising ? LockKeyhole : undefined}
          disabled={busy || blocked}
          onClick={() => {
            void submit()
          }}
          loading={busy}>
          {raising ? '用 Touch ID 授予' : '保存权限'}
        </Button>
      </footer>
    </Modal>
  )
}

function RegisteredDevices({ currentId, local, onChanged }: { currentId: string; local: boolean; onChanged: () => void }) {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [error, setError] = useState('')
  const [revoking, setRevoking] = useState<Device | null>(null)
  const [editing, setEditing] = useState<Device | null>(null)
  const generation = useRef(0),
    mounted = useRef(false)
  const load = useCallback(async () => {
    const request = ++generation.current
    try {
      const next = await api<{ devices: Device[] }>('devices')
      if (!mounted.current || request !== generation.current) return
      setDevices(next.devices)
      setError('')
    } catch (cause) {
      if (mounted.current && request === generation.current) setError(errorMessage(cause))
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    void load()
    const timer = window.setInterval(() => {
      void load()
    }, 5000)
    return () => {
      mounted.current = false
      generation.current++
      clearInterval(timer)
    }
  }, [load])
  const order = (device: Device) => (device.status === 'revoked' ? 2 : device.status === 'legacy-pending' ? 1 : 0)
  const shown = devices === null ? [] : [...devices].sort((a, b) => order(a) - order(b) || b.lastSeenAt.localeCompare(a.lastSeenAt))
  const live = shown.filter(device => device.status !== 'revoked').length
  return (
    <>
      {devices === null ? (
        <SettingsGroup title="已登记的设备" bare>
          {error ? <InlineNotice tone="error">{error}</InlineNotice> : <Loading />}
        </SettingsGroup>
      ) : (
        <SettingsGroup title="已登记的设备" meta={`${live} 台`}>
          {shown.map(device => {
            const self = device.id === currentId
            const revoked = device.status === 'revoked'
            return (
              <div
                key={device.id}
                className={`settings-row device-row${revoked ? ' is-revoked' : ''}`}
                data-leading=""
                data-dim={revoked ? '' : undefined}
                data-device-id={device.id}>
                <span className="settings-row-lead">
                  <IconTile icon={deviceIcon(device)} />
                </span>
                <span className="settings-row-text">
                  <span className="settings-row-title settings-row-name" data-record="">
                    <span className="device-row-name">{device.name ? <VisibleText text={device.name} /> : '未命名设备'}</span>
                    {self && <Badge>此设备</Badge>}
                    {device.status !== 'active' && <StatusBadge status={device.status} />}
                  </span>
                  <span className="settings-row-description">
                    {LISTENER_LABELS[device.listener]} ·{' '}
                    {revoked
                      ? `撤销于 ${relativeTime(device.revokedAt ?? '') || '未知时间'}`
                      : `最近使用 ${relativeTime(device.lastSeenAt) || '未知'}`}
                  </span>
                  {!revoked && (
                    <span className="settings-row-description">
                      {device.native ? NATIVE_LINK_COPY.registeredScopes(scopeText(device.scopes)) : scopeText(device.scopes)}
                    </span>
                  )}
                  {!revoked && device.native && (
                    <span className="settings-row-description">
                      {NATIVE_LINK_COPY.nativeInput[device.native.input]} ·{' '}
                      {device.native.bodyVerifiedUntil
                        ? NATIVE_LINK_COPY.bodyUntil(dateTime(device.native.bodyVerifiedUntil))
                        : NATIVE_LINK_COPY.bodyLocked}
                    </span>
                  )}
                </span>
                {!revoked && !self && (
                  <span className="settings-row-end">
                    <Menu
                      label={`${deviceLabel(device.name)} 的操作`}
                      align="end"
                      sections={[
                        {
                          id: 'device',
                          items: [
                            ...(device.status !== 'legacy-pending'
                              ? [
                                  {
                                    id: 'scopes',
                                    label: '调整权限…',
                                    icon: KeyRound,
                                    onSelect: () => {
                                      setEditing(device)
                                    },
                                  },
                                ]
                              : []),
                            {
                              id: 'revoke',
                              label: '撤销设备…',
                              icon: Ban,
                              danger: true,
                              onSelect: () => {
                                setRevoking(device)
                              },
                            },
                          ],
                        },
                      ]}
                      trigger={moreButton(`${deviceLabel(device.name)} 的操作`)}
                    />
                  </span>
                )}
              </div>
            )
          })}
        </SettingsGroup>
      )}
      {error && devices !== null && <InlineNotice tone="error">{error}</InlineNotice>}
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
              throw new Error(errorMessage(cause), { cause })
            }
            onChanged()
            await load()
          }}
        />
      )}
    </>
  )
}

/**
 * 「在这台电脑的浏览器中打开」, in the desktop app only. A browser on this computer enrolls over loopback, which takes a
 * one-time invitation; the shell's main process makes one and opens the default browser with it in the fragment, so
 * this page never sees the invitation. Without the action (an older shell, or a system that would put the link on a
 * command line) the row names the terminal command instead. Like 手机配对 beside it, it hands out an invitation, so it is
 * a security surface (data-secure), and so is its error.
 */
function BrowserHere({ openInBrowser }: { openInBrowser: LatchShell['openInBrowser'] | undefined }) {
  const [busy, setBusy] = useState(false)
  const [opened, setOpened] = useState(false)
  const [error, setError] = useState('')
  const open = async (action: NonNullable<LatchShell['openInBrowser']>) => {
    setBusy(true)
    setOpened(false)
    setError('')
    try {
      const result = await action()
      if (result.ok) setOpened(true)
      else
        setError(
          describeFailure(
            result.status,
            result.error,
            result.message,
            result.retryAfter === undefined ? {} : { retryAfter: result.retryAfter },
          ),
        )
    } catch {
      setError(describeFailure(502, 'browser-open-failed', ''))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <SettingsGroup
        title="这台电脑的浏览器"
        secure
        caption={opened ? <span role="status">已在浏览器中打开。在浏览器中提交登记后，这台电脑会显示确认窗口。</span> : undefined}>
        <SettingsRow
          leading={<IconTile icon={Globe} />}
          title="一次性登记链接"
          description={
            openInBrowser
              ? '在默认浏览器中打开 Latch，首次使用时在这台电脑上允许连接。'
              : '此系统上不能从桌面端直接打开浏览器。请在终端运行 pnpm latch device invite --loopback，在浏览器中打开它给出的一次性链接。'
          }
          trailing={
            openInBrowser ? (
              <Button
                icon={Globe}
                loading={busy}
                onClick={() => {
                  void open(openInBrowser)
                }}>
                在这台电脑的浏览器中打开
              </Button>
            ) : undefined
          }
        />
      </SettingsGroup>
      {error && (
        <InlineNotice tone="error" secure>
          {error}
        </InlineNotice>
      )}
    </>
  )
}

export function DevicesSettings({ snapshot, access, onChanged }: { snapshot: AppSnapshot; access: DeviceAccess; onChanged: () => void }) {
  const host = hostView(snapshot)
  const shell = currentShell()
  // Only macOS hands the link to the browser without putting it on a command line (see the shell's main process).
  const openInBrowser = shell?.platform === 'darwin' ? shell.openInBrowser : undefined
  return (
    <>
      <SectionHeading title="设备" description="管理可以使用这台电脑的设备。新设备由电脑允许连接，移除后立即失去访问权。" />
      <ThisDevice device={snapshot.device} devMode={host?.devMode === true} onChanged={onChanged} />
      {access.admin && <RegisteredDevices currentId={snapshot.device.id} local={access.local} onChanged={onChanged} />}
      {access.local && access.admin && <BrowserHere openInBrowser={openInBrowser} />}
      {access.admin && (
        <RemoteStartRow
          {...(!access.local
            ? { raiseBlocked: '在 Mac 上开启' }
            : host?.presence.status === 'unavailable'
              ? { raiseBlocked: presenceUnavailableText(host.presence.message) }
              : {})}
        />
      )}
      <PairingSection access={access} snapshot={snapshot} />
      <RevokeThisDevice device={snapshot.device} onChanged={onChanged} />
    </>
  )
}
