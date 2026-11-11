import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppSnapshot, Device } from '@latch/protocol'
import { InlineNotice, Menu, Toast } from '@latch/ui'
import { ConfirmDialog } from '../../components/overlays.tsx'
import { VisibleText } from '../../components/VisibleText.tsx'
import { api, errorMessage } from '../../core/api.ts'
import type { DeviceAccess } from '../../core/permissions.ts'
import { computerName, DEVICES_COPY as COPY } from '../../core/securityCopy.ts'
import { currentShell } from '../../core/shell.ts'
import { IconTile, Loading, moreButton, ObjectRow, SettingsGroup, SettingsRow } from '../common.tsx'
import { NavigationContext, SettingsPages } from '../navigation.tsx'
import { AboutConnection, ConnectNew } from './ConnectDevices.tsx'
import { deviceIcon } from './deviceIcon.ts'
import { DevicePage, SeenLine } from './DevicePage.tsx'
import { connectWays, deviceLabel, listedDevices, removeBody, seenText } from './deviceRows.ts'
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
 * 设置 › 设备, in this order: the devices (one row each, 重命名 and 移除 in its ⋯), 连接新设备, 关于连接. A device opens as
 * a page inside the section, at every width. It names no address, relay, scope or fingerprint, and never holds a link:
 * the Latch app's main process makes and hands them out, and the Host still enforces all of it.
 */
export function PhoneDevicesPage({ snapshot, access, onChanged }: { snapshot: AppSnapshot; access: DeviceAccess; onChanged: () => void }) {
  const { phone } = useContext(NavigationContext)
  const { devices, error, load } = useDevices(snapshot.device, access.admin)
  const [chosen, setChosen] = useState<string | null>(null)
  const [pairing, setPairing] = useState(false)
  const [removing, setRemoving] = useState<Device | null>(null)
  const [removedName, setRemovedName] = useState('')
  const [renaming, setRenaming] = useState(0)
  const { pair: canPair, openInBrowser, copyLink } = connectWays(currentShell(), access, snapshot.host.tls)
  const computer = computerName(snapshot.hostName)
  const listed = devices === null ? [] : listedDevices(devices, snapshot.device.id)
  const selected = listed.find(device => device.id === chosen)
  const changed = () => {
    onChanged()
    void load()
  }

  const rows = listed.map(device => {
    const self = device.id === snapshot.device.id
    const label = deviceLabel(device.name)
    const items = [
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
    ]
    return (
      <ObjectRow
        key={device.id}
        className="device-row"
        data={{ 'data-device-id': device.id }}
        label={label}
        leading={<IconTile icon={deviceIcon(device)} />}
        title={<span className="settings-row-name">{device.name ? <VisibleText text={device.name} /> : COPY.unnamed}</span>}
        description={
          <>
            {self ? <SeenLine device={device} self /> : seenText(device, false)}
            {device.status === 'review' && ` · ${COPY.review}`}
          </>
        }
        onOpen={() => {
          setChosen(device.id)
        }}
        trailing={
          !phone && (self || access.admin) ? (
            <span className="device-nav-more">
              <Menu label={`${label} 的操作`} align="end" sections={[{ id: 'device', items }]} trigger={moreButton(`${label} 的操作`)} />
            </span>
          ) : undefined
        }
      />
    )
  })

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
                {devices !== null && (
                  <SettingsGroup title={access.local ? COPY.listTitle : COPY.shelf}>
                    {rows.length > 0 ? rows : <SettingsRow title={COPY.empty} />}
                  </SettingsGroup>
                )}
                <ConnectNew
                  local={canPair}
                  computer={computer}
                  openInBrowser={openInBrowser}
                  copyLink={copyLink}
                  pairing={pairing}
                  onPair={() => {
                    setPairing(true)
                  }}
                />
                <AboutConnection entry={snapshot.host.tls !== null} canManageRoutes={canPair} />
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
                      computer={computer}
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
