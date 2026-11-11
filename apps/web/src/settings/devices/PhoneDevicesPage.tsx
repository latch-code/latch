import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppSnapshot, Device } from '@latch/protocol'
import { EmptyState, Icon, InlineNotice, Menu, Toast } from '@latch/ui'
import { ConfirmDialog } from '../../components/overlays.tsx'
import { VisibleText } from '../../components/VisibleText.tsx'
import { api, errorMessage } from '../../core/api.ts'
import type { DeviceAccess } from '../../core/permissions.ts'
import { computerName, DEVICES_COPY as COPY } from '../../core/securityCopy.ts'
import { currentShell } from '../../core/shell.ts'
import { IconTile, Loading, moreButton } from '../common.tsx'
import { NavigationContext, SettingsPages } from '../navigation.tsx'
import { ConnectionFoot, ConnectPhone } from './ConnectDevices.tsx'
import { deviceIcon } from './deviceIcon.ts'
import { DevicePage, SeenLine } from './DevicePage.tsx'
import { deviceLabel, listedDevices, removeBody, seenText } from './deviceRows.ts'
import { PairingSheet } from './PairingSheet.tsx'

const POLL_MS = 5000

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

/**
 * 设置 › 设备: 连接手机 on this Mac, one row per device with 重命名 and 移除 in its ⋯, and 关于连接 at the foot. A device
 * opens as a page inside the section, at every width. It names no address, relay, scope or fingerprint: routes are
 * automatic, an HTTPS entry stays with the command line, and the Host still enforces all of it.
 */
export function PhoneDevicesPage({ snapshot, access, onChanged }: { snapshot: AppSnapshot; access: DeviceAccess; onChanged: () => void }) {
  const { phone } = useContext(NavigationContext)
  const { devices, error, load } = useDevices(snapshot.device, access.admin)
  const [chosen, setChosen] = useState<string | null>(null)
  const [pairing, setPairing] = useState(false)
  const [removing, setRemoving] = useState<Device | null>(null)
  const [removedName, setRemovedName] = useState('')
  const [renaming, setRenaming] = useState(0)
  const shell = currentShell()
  // Only macOS hands the link to the browser without putting it on a command line (see the shell's main process).
  const openInBrowser = shell?.platform === 'darwin' && access.local && access.admin ? shell.openInBrowser : undefined
  const canPair = access.local && access.admin
  const listed = devices === null ? [] : listedDevices(devices, snapshot.device.id)
  const selected = listed.find(device => device.id === chosen)
  const changed = () => {
    onChanged()
    void load()
  }

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
  const empty = (
    <div className="device-empty">
      <span className="pair-glyph" aria-hidden="true">
        <Icon icon={deviceIcon({ listener: 'native-direct', name: '' })} size={20} />
      </span>
      <EmptyState title={COPY.empty} description={canPair ? COPY.emptyBody : COPY.pairElsewhere(computerName(snapshot.hostName))} />
    </div>
  )

  return (
    <>
      <SettingsPages
        main={
          <>
            {error && <InlineNotice tone="error">{error}</InlineNotice>}
            {devices === null && !error ? (
              <Loading />
            ) : (
              <div className="device-list">
                {canPair && (
                  <ConnectPhone
                    pairing={pairing}
                    onPair={() => {
                      setPairing(true)
                    }}
                  />
                )}
                {rows || (devices !== null && empty)}
                <ConnectionFoot canManageRoutes={canPair} openInBrowser={openInBrowser} />
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
                  content: (
                    <DevicePage
                      key={selected.id}
                      device={selected}
                      devices={devices ?? []}
                      self={selected.id === snapshot.device.id}
                      access={access}
                      phone={phone}
                      renaming={renaming}
                      onAskRemove={() => {
                        setRemoving(selected)
                      }}
                      onChanged={changed}
                    />
                  ),
                },
              ]
            : []
        }
      />
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
}
