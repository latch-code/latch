import { useCallback, useContext, useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { QrCode } from 'lucide-react'
import { isAcceptableDeviceName, type AppSnapshot, type Device, type NativeLinkInfo } from '@latch/protocol'
import { Button, EmptyState, Icon, InlineNotice, Menu, Popover, SwitchRow, Toast } from '@latch/ui'
import { InlineConfirm } from '../../components/InlineConfirm.tsx'
import { ConfirmDialog } from '../../components/overlays.tsx'
import { VisibleText } from '../../components/VisibleText.tsx'
import { api, errorMessage, inlineError } from '../../core/api.ts'
import { withConfirmation } from '../../core/confirmations.ts'
import { BASE_SCOPES } from '../../core/enrollment.ts'
import { hostView, type DeviceAccess } from '../../core/permissions.ts'
import {
  computerName,
  DEVICE_NAME_INVALID_TEXT,
  describeFailure,
  DEVICES_COPY as COPY,
  NATIVE_LINK_COPY,
  presenceUnavailableText,
} from '../../core/securityCopy.ts'
import { currentShell, type LatchShell } from '../../core/shell.ts'
import { IconTile, Loading, moreButton, SettingsGroup, SettingsRow } from '../common.tsx'
import { NavigationContext, SettingsPages } from '../navigation.tsx'
import { deviceIcon } from './deviceIcon.ts'
import { deviceLabel, isBrowserDevice, isPhoneDevice, listedDevices, removeBody, seenText } from './deviceRows.ts'
import { PairingSheet } from './PairingSheet.tsx'
import { WaitingDevices } from './WaitingDevices.tsx'

const POLL_MS = 5000
/** The note after 在浏览器中打开 says what happens next, so it goes once that has had time to happen. */
const OPENED_NOTE_MS = 15_000

/** The device list while this page is open. Without 管理此 Host the Host lists none, and a device sees only itself. */
function useDevices(current: AppSnapshot['device'], admin: boolean) {
  const [devices, setDevices] = useState<Device[] | null>(admin ? null : [current])
  const [error, setError] = useState('')
  const generation = useRef(0),
    mounted = useRef(false)
  const load = useCallback(async () => {
    if (!admin) return
    const request = ++generation.current
    try {
      const next = await api<{ devices: Device[] }>('devices')
      if (!mounted.current || request !== generation.current) return
      setDevices(next.devices)
      setError('')
    } catch (cause) {
      if (mounted.current && request === generation.current) setError(errorMessage(cause))
    }
  }, [admin])
  useEffect(() => {
    mounted.current = true
    void load()
    const timer = window.setInterval(() => {
      void load()
    }, POLL_MS)
    return () => {
      mounted.current = false
      generation.current++
      clearInterval(timer)
    }
  }, [load])
  return { devices: admin ? devices : [current], error, load }
}

function SeenLine({ device, self }: { device: Device; self: boolean }) {
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
  const change = async (scopes: Device['scopes']) => {
    setPending(true)
    setError('')
    try {
      await withConfirmation(confirmation =>
        api(`devices/${encodeURIComponent(device.id)}`, { method: 'PATCH', body: { scopes }, ...(confirmation ? { confirmation } : {}) }),
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

function DeviceDetail({
  device,
  devices,
  self,
  access,
  renaming,
  onAskRemove,
  onChanged,
}: {
  device: Device
  devices: readonly Device[]
  self: boolean
  access: DeviceAccess
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
  // A phone starts without 管理此 Host and cannot be given it here, but one that kept it from before can still lose it.
  const manageable = (isBrowserDevice(device) || (isPhoneDevice(device) && admin)) && device.status === 'active' && access.admin && !self
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
            description={device.status === 'review' ? COPY.reviewNote : undefined}
            trailing={
              restore ? (
                <Button
                  loading={scope.pending}
                  disabled={!access.local}
                  title={access.local ? undefined : COPY.raiseOnMac()}
                  onClick={() => {
                    void scope.change(BASE_SCOPES)
                  }}>
                  {COPY.restore}
                </Button>
              ) : (
                <span className="settings-row-value">{statusText}</span>
              )
            }
          />
        )}
        {manageable && (
          <SwitchRow
            className="settings-row"
            title={COPY.manage}
            description={COPY.manageNote}
            checked={admin}
            locked={!admin && !access.local ? COPY.raiseOnMac() : undefined}
            disabled={scope.pending}
            onCheckedChange={next => {
              void scope.change(next ? [...device.scopes, 'admin'] : device.scopes.filter(item => item !== 'admin'))
            }}
          />
        )}
      </SettingsGroup>
      <InlineConfirm active={scope.pending} />
      {scope.error && <InlineNotice tone="error">{scope.error}</InlineNotice>}
      {(self || access.admin) && (
        <SettingsGroup>
          <SettingsRow
            title={COPY.remove}
            description={removeBody(device, self, devices)}
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

/**
 * 在浏览器中打开, in the desktop app on macOS only. A browser here enrolls over loopback, which takes a one-time invitation;
 * the shell's main process makes one and opens the default browser with it in the fragment, so this page never sees
 * the invitation. Elsewhere the invitation would land on a command line, so nothing is offered.
 */
function OpenInBrowser({ open }: { open: NonNullable<LatchShell['openInBrowser']> }) {
  const [busy, setBusy] = useState(false)
  const [opened, setOpened] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!opened) return undefined
    const timer = window.setTimeout(() => {
      setOpened(false)
    }, OPENED_NOTE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [opened])
  const run = async () => {
    setBusy(true)
    setOpened(false)
    setError('')
    try {
      const result = await open()
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
    <div className="device-foot-browser" data-secure="">
      <Button
        variant="link"
        className="device-foot-link"
        loading={busy}
        onClick={() => {
          void run()
        }}>
        {COPY.browser}
      </Button>
      {opened && (
        <p className="device-foot-note" role="status">
          {COPY.browserOpened}
        </p>
      )}
      {error && (
        <InlineNotice tone="error" secure>
          {error}
        </InlineNotice>
      )}
    </div>
  )
}

/**
 * A relay or address directory saved by an earlier build: nothing can add one now, so this only offers the way to take it
 * back, and only to someone who has one. It is the one place these are named, beside the sentence about relays.
 */
function SavedRoutes() {
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
    void api<NativeLinkInfo>(path, { method: 'DELETE' }).then(setInfo, (cause: unknown) => {
      setError(inlineError(cause))
    })
  }
  return (
    <>
      {info?.relays.map(relay => (
        <div key={relay.relayId} className="device-saved">
          <span className="device-saved-text">
            <b>{COPY.savedRelay}</b>
            <span>{relay.url}</span>
          </span>
          <Button
            onClick={() => {
              remove(`native/relays/${relay.relayId}`)
            }}>
            {COPY.remove}
          </Button>
        </div>
      ))}
      {info?.directory && (
        <div className="device-saved">
          <span className="device-saved-text">
            <b>{COPY.savedDirectory}</b>
          </span>
          <Button
            onClick={() => {
              remove('native/directory')
            }}>
            {COPY.remove}
          </Button>
        </div>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </>
  )
}

function AboutConnection({ canManageRoutes }: { canManageRoutes: boolean }) {
  return (
    <Popover
      label={COPY.about}
      title={COPY.about}
      width={280}
      side="top"
      align="start"
      trigger={props => (
        <Button {...props} variant="link" className="device-foot-link">
          {COPY.about}
        </Button>
      )}>
      <p className="device-about">{COPY.aboutBody}</p>
      {canManageRoutes && <SavedRoutes />}
    </Popover>
  )
}

/**
 * 手机 (设置 › 手机与设备 on a phone): one row per device with 重命名 and 移除, the pairing sheet, and the one setting
 * other devices need from this Mac. It names no address, relay, scope or fingerprint: routes are automatic, an HTTPS entry
 * stays with the command line, and the Host still enforces all of it.
 */
export function PhoneDevicesPage({ snapshot, access, onChanged }: { snapshot: AppSnapshot; access: DeviceAccess; onChanged: () => void }) {
  const { phone, navSlot, titleSlot } = useContext(NavigationContext)
  const { devices, error, load } = useDevices(snapshot.device, access.admin)
  const [chosen, setChosen] = useState<string | null>(null)
  const [shown, setShown] = useState<string | null>(null)
  const [pairing, setPairing] = useState(false)
  const [removing, setRemoving] = useState<Device | null>(null)
  const [removedName, setRemovedName] = useState('')
  const [renaming, setRenaming] = useState(0)
  const shell = currentShell()
  // Only macOS hands the link to the browser without putting it on a command line (see the shell's main process).
  const openInBrowser = shell?.platform === 'darwin' && access.local && access.admin ? shell.openInBrowser : undefined
  const canPair = access.local && access.admin
  const host = hostView(snapshot)
  const listed = devices === null ? [] : listedDevices(devices, snapshot.device.id)
  // A wide window always shows one device, the first when none was picked; a phone opens one as a page. The first is
  // settled once: rows reorder as devices are seen, and the page must not change under someone typing a name.
  const selected =
    listed.find(device => device.id === chosen) ?? (phone ? undefined : (listed.find(device => device.id === shown) ?? listed[0]))
  const selectedId = selected?.id ?? null
  useEffect(() => {
    if (selectedId !== null) setShown(selectedId)
  }, [selectedId])
  const changed = () => {
    onChanged()
    void load()
  }

  const connect = canPair ? (
    <>
      <Button
        variant="primary"
        icon={QrCode}
        block
        className="device-connect"
        onClick={() => {
          setPairing(true)
        }}>
        {NATIVE_LINK_COPY.enable}
      </Button>
      {!pairing && <WaitingDevices place="page" />}
    </>
  ) : null
  const rows = listed.length > 0 && (
    <div className="plugin-shelf">
      <div className="plugin-shelf-head">
        <h3>{COPY.shelf}</h3>
      </div>
      {listed.map(device => {
        const self = device.id === snapshot.device.id
        const label = deviceLabel(device.name)
        return (
          <div key={device.id} className="device-nav-row" data-device-id={device.id}>
            <button
              type="button"
              className="plugin-nav-row"
              aria-current={device.id === selected?.id || undefined}
              onClick={() => {
                setChosen(device.id)
              }}>
              <IconTile icon={deviceIcon(device)} />
              <span className="plugin-nav-text">
                <span className="plugin-nav-name">{device.name ? <VisibleText text={device.name} /> : COPY.unnamed}</span>
                <span className="plugin-nav-state">
                  {self ? <SeenLine device={device} self /> : seenText(device, false)}
                  {device.status === 'review' && ` · ${COPY.review}`}
                </span>
              </span>
            </button>
            {!phone && (self || access.admin) && (
              <span className="device-nav-more">
                <Menu
                  label={`${label} 的操作`}
                  align="end"
                  sections={[
                    {
                      id: 'device',
                      items: [
                        ...(device.status !== 'legacy-pending' && (self || access.local)
                          ? [
                              {
                                id: 'rename',
                                label: COPY.rename,
                                onSelect: () => {
                                  setChosen(device.id)
                                  setRenaming(count => count + 1)
                                },
                              },
                            ]
                          : []),
                        {
                          id: 'remove',
                          label: COPY.remove,
                          danger: true,
                          onSelect: () => {
                            setRemoving(device)
                          },
                        },
                      ],
                    },
                  ]}
                  trigger={moreButton(`${label} 的操作`)}
                />
              </span>
            )}
          </div>
        )
      })}
      {!canPair && <p className="device-foot-note device-pair-elsewhere">{COPY.pairElsewhere(computerName(snapshot.hostName))}</p>}
    </div>
  )
  const foot = (
    <div className="device-foot">
      <div className="device-foot-links">
        <AboutConnection canManageRoutes={canPair} />
        {openInBrowser && <OpenInBrowser open={openInBrowser} />}
      </div>
    </div>
  )
  const empty = (
    <div className="device-empty">
      <span className="pair-glyph" aria-hidden="true">
        <Icon icon={deviceIcon({ listener: 'native-direct', name: '' })} size={20} />
      </span>
      <EmptyState title={COPY.empty} description={canPair ? COPY.emptyBody : COPY.pairElsewhere(computerName(snapshot.hostName))} />
    </div>
  )
  const detail = selected && (
    <DeviceDetail
      key={selected.id}
      device={selected}
      devices={devices ?? []}
      self={selected.id === snapshot.device.id}
      access={access}
      renaming={renaming}
      onAskRemove={() => {
        setRemoving(selected)
      }}
      onChanged={changed}
    />
  )
  const overlays = (
    <>
      {pairing && (
        <PairingSheet
          snapshot={snapshot}
          onChanged={changed}
          onClose={() => {
            setPairing(false)
            changed()
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={COPY.removeTitle(deviceLabel(removing.name))}
          danger
          confirmLabel={COPY.remove}
          message={removeBody(removing, removing.id === snapshot.device.id, devices ?? [])}
          onClose={() => {
            setRemoving(null)
          }}
          onConfirm={async () => {
            const self = removing.id === snapshot.device.id
            try {
              await api(self ? 'devices/current' : `devices/${encodeURIComponent(removing.id)}`, { method: 'DELETE' })
            } catch (cause) {
              throw new Error(errorMessage(cause), { cause })
            }
            setRemovedName(deviceLabel(removing.name))
            if (chosen === removing.id) setChosen(null)
            changed()
          }}
        />
      )}
      {removedName
        && createPortal(
          <Toast
            className="toast"
            onDismiss={() => {
              setRemovedName('')
            }}>
            {COPY.removed(removedName)}
          </Toast>,
          document.body,
        )}
    </>
  )

  if (phone)
    return (
      <>
        <SettingsPages
          main={
            <>
              {error && <InlineNotice tone="error">{error}</InlineNotice>}
              {devices === null && !error ? (
                <Loading />
              ) : (
                <div className="device-phone-list">
                  {connect}
                  {rows || (devices !== null && empty)}
                  {foot}
                </div>
              )}
            </>
          }
          levels={
            selected
              ? [
                  {
                    key: selected.id,
                    title: deviceLabel(selected.name),
                    onBack: () => {
                      setChosen(null)
                    },
                    content: detail,
                  },
                ]
              : []
          }
        />
        {overlays}
      </>
    )
  return (
    <>
      {navSlot
        && createPortal(
          <div className="device-panel">
            {connect && <div className="device-panel-top">{connect}</div>}
            <div className="device-panel-list">{rows}</div>
            {foot}
          </div>,
          navSlot,
        )}
      {titleSlot
        && createPortal(
          selected ? (
            <div className="device-title">
              <Icon icon={deviceIcon(selected)} size={16} />
              <h1 className="titlebar-page-title">
                <VisibleText text={selected.name} />
              </h1>
            </div>
          ) : (
            <h1 className="titlebar-page-title">手机</h1>
          ),
          titleSlot,
        )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {devices === null ? !error && <Loading /> : (detail ?? empty)}
      {overlays}
    </>
  )
}
