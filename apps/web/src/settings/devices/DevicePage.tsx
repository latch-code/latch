import { useEffect, useRef, useState, type FormEvent } from 'react'

import { isAcceptableDeviceName, type Device } from '@latch/protocol'
import { Button, Hint, Icon, InlineNotice, SwitchRow, EyeGlyph, LockGlyph } from '@latch/ui'
import { InlineConfirm } from '../../components/InlineConfirm.tsx'
import { VisibleText } from '../../components/VisibleText.tsx'
import { api, errorMessage, inlineError } from '../../core/api.ts'
import { withConfirmation } from '../../core/confirmations.ts'
import { BASE_SCOPES } from '../../core/enrollment.ts'
import type { DeviceAccess } from '../../core/permissions.ts'
import { CONNECTION_DETAILS_COPY, DEVICE_NAME_INVALID_TEXT, DEVICES_COPY as COPY } from '../../core/securityCopy.ts'
import { SettingsGroup, SettingsRow } from '../common.tsx'
import { deviceIcon } from './deviceIcon.ts'
import { deviceSwitches, filesChange, grantedText, manageChange, seenText, type ScopeChange } from './deviceRows.ts'

export function SeenLine({ device, self }: { device: Device; self: boolean }) {
  return (
    <span className="device-seen">
      {self && <span className="device-dot" aria-hidden="true" />}
      {seenText(device, self)}
    </span>
  )
}

/** The name, saved on Enter or on leaving the field. Elsewhere than this Mac another device's name can only be read. */
function NameRow({ device, self, canRename, onSaved }: { device: Device; self: boolean; canRename: boolean; onSaved: () => void }) {
  const [name, setName] = useState(device.name)
  const [error, setError] = useState('')
  const trimmed = name.trim()
  const invalid = trimmed !== '' && !isAcceptableDeviceName(trimmed)
  const saving = useRef(false)
  const save = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!trimmed || invalid || trimmed === device.name || saving.current) return
    saving.current = true
    setError('')
    try {
      await api(self ? 'devices/current' : `devices/${encodeURIComponent(device.id)}/name`, { method: 'PATCH', body: { name: trimmed } })
      onSaved()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      saving.current = false
    }
  }
  if (!canRename)
    return (
      <SettingsRow
        title={COPY.name}
        trailing={
          <span className="settings-row-value">
            <VisibleText text={device.name} />
          </span>
        }
      />
    )
  return (
    <form
      className="settings-row device-name-row"
      onSubmit={event => {
        void save(event)
      }}>
      <label className="settings-row-text" htmlFor={`device-name-${device.id}`}>
        <span className="settings-row-title">{COPY.name}</span>
        {(invalid || error) && (
          <span className="settings-row-description device-name-error">{invalid ? DEVICE_NAME_INVALID_TEXT : error}</span>
        )}
      </label>
      <span className="settings-row-end">
        <input
          id={`device-name-${device.id}`}
          className="ui-input device-name-input"
          aria-label={COPY.nameLabel}
          aria-invalid={invalid || undefined}
          data-device-name=""
          value={name}
          maxLength={80}
          autoComplete="off"
          onChange={event => {
            setName(event.target.value)
          }}
          onBlur={() => {
            void save()
          }}
        />
      </span>
    </form>
  )
}

/** Raising takes this Mac's Touch ID, so it starts only here; lowering works from any device that manages it. */
function useScopeChange(device: Device, onChanged: () => void) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const change = async (body: ScopeChange) => {
    setPending(true)
    setError('')
    try {
      await withConfirmation(confirmation =>
        api(`devices/${encodeURIComponent(device.id)}`, { method: 'PATCH', body, ...(confirmation ? { confirmation } : {}) }),
      )
      onChanged()
    } catch (cause) {
      setError(inlineError(cause))
    } finally {
      setPending(false)
    }
  }
  return { pending, error, change }
}

/**
 * One device's page inside 设置 › 设备: its name, when it was last seen, what it may do, what needs doing about it, the
 * two switches for a browser (可以管理, 可以看项目文件), and 移除. On a wide window it names the device above the rows; a
 * phone's bar does that. Elsewhere than this Mac the switches name the computer (`computer`).
 */
export function DevicePage({
  device,
  self,
  access,
  computer,
  phone,
  renaming,
  onAskRemove,
  onChanged,
}: {
  device: Device
  self: boolean
  access: DeviceAccess
  computer: string
  phone: boolean
  renaming: number
  onAskRemove: () => void
  onChanged: () => void
}) {
  const scope = useScopeChange(device, onChanged)
  const admin = device.scopes.includes('admin')
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (renaming > 0) body.current?.querySelector<HTMLInputElement>('[data-device-name]')?.select()
  }, [renaming])
  const restore = device.status === 'review' && access.admin && !self
  const switches = deviceSwitches(device, self, access)
  const locked = switches.raise ? undefined : COPY.raiseOnMac(computer)
  const files = device.dataScope === 'all'
  const granted = grantedText(device, switches.manage)
  const statusText =
    device.status === 'review'
      ? COPY.review
      : device.status === 'legacy-pending'
        ? COPY.legacy
        : device.native?.input === 'verification-required'
          ? COPY.verificationRequired
          : null
  return (
    <div ref={body} className="device-detail">
      {!phone && (
        <header className="settings-heading device-title">
          <Icon icon={deviceIcon(device)} size={16} />
          <h2>{device.name ? <VisibleText text={device.name} /> : COPY.unnamed}</h2>
        </header>
      )}
      <SettingsGroup>
        <NameRow
          key={device.id}
          device={device}
          self={self}
          canRename={device.status !== 'legacy-pending' && (self || (access.local && access.admin))}
          onSaved={onChanged}
        />
        <SettingsRow
          title={self ? COPY.state : COPY.lastSeen}
          trailing={
            <span className="settings-row-value">
              <SeenLine device={device} self={self} />
            </span>
          }
        />
        {statusText && (
          <SettingsRow
            title={COPY.state}
            description={device.status === 'review' ? <Hint label={COPY.reviewNote.label}>{COPY.reviewNote.detail}</Hint> : undefined}
            trailing={
              restore ? (
                <Button
                  loading={scope.pending}
                  disabled={!access.local}
                  title={locked}
                  onClick={() => {
                    void scope.change({ scopes: BASE_SCOPES })
                  }}>
                  {COPY.restore}
                </Button>
              ) : (
                <span className="settings-row-value">{statusText}</span>
              )
            }
          />
        )}
        {granted && (
          <SettingsRow
            className="device-granted-row"
            title={CONNECTION_DETAILS_COPY.granted}
            trailing={<span className="settings-row-value device-granted">{granted}</span>}
          />
        )}
      </SettingsGroup>
      {(switches.manage || switches.files) && (
        <SettingsGroup secure>
          {switches.manage && (
            <SwitchRow
              className="settings-row"
              title={COPY.manageOf(access.local, computer)}
              description={
                <Hint lead={<Icon icon={LockGlyph} size={12} />} label={COPY.manageNote.label}>
                  {COPY.manageNote.detail}
                </Hint>
              }
              checked={admin}
              locked={admin ? undefined : locked}
              disabled={scope.pending}
              onCheckedChange={next => {
                void scope.change(manageChange(device, next))
              }}
            />
          )}
          {switches.files && (
            <SwitchRow
              className="settings-row"
              title={COPY.files}
              description={
                <Hint lead={<Icon icon={EyeGlyph} size={12} />} label={COPY.filesNote.label}>
                  {COPY.filesNote.detail}
                </Hint>
              }
              checked={files}
              locked={files ? undefined : locked}
              disabled={scope.pending}
              onCheckedChange={next => {
                void scope.change(filesChange(next))
              }}
            />
          )}
        </SettingsGroup>
      )}
      <InlineConfirm active={scope.pending} list />
      {scope.error && <InlineNotice tone="error">{scope.error}</InlineNotice>}
      {(self || access.admin) && (
        <SettingsGroup>
          <SettingsRow
            title={COPY.remove}
            trailing={
              <Button variant="danger" onClick={onAskRemove}>
                {COPY.remove}…
              </Button>
            }
          />
        </SettingsGroup>
      )}
    </div>
  )
}
