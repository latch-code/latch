import { useEffect, useState, type ReactNode } from 'react'
import {
  DevicesGlyph,
  ICON_STROKE,
  Icon,
  LaptopGlyph,
  LiveDot,
  MenuFooterLink,
  PlusGlyph,
  Popover,
  SettingsGlyph,
  UpDownGlyph,
  useLayerClose,
  type MenuTriggerProps,
} from '@latch/ui'
import type { AppSnapshot, Device } from '@latch/protocol'
import { api as request } from '../core/api.ts'
import {
  ATTENTION_WORDS,
  CONNECTION_WORDS,
  computerState,
  otherComputerRows,
  type OtherComputerRow,
  type OtherWaiting,
} from '../core/computers.ts'
import { hostView } from '../core/permissions.ts'
import { computerName } from '../core/securityCopy.ts'
import { shellComputers, type ComputersView } from '../core/shell.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import { relativeTime } from '../format.ts'
import { listedDevices } from '../settings/devices/deviceRows.ts'
import { Menu, rowOf } from './overlays.tsx'

/** Where the computer popover's rows lead; each is absent where this device cannot go there. */
export interface ComputerLinks {
  /** 设置 › 电脑, where the chip used to lead. */
  settings?: (() => void) | undefined
  /** 设置 › 设备; `count` asks the Host for the list, which only a device with 管理 may read. */
  devices?: { open: () => void; count: boolean } | undefined
  /** 连接新设备 on 设置 › 设备: only the Latch app on this Mac with 管理 pairs, behind its own locked surface. */
  connect?: (() => void) | undefined
}

/**
 * The computer this page talks to, as a small popover anchored where its name stands (a sheet on phones): its name, how
 * this window reaches it and in what state, the other computers the desktop app knows (choosing one brings its window;
 * its row's context gesture opens the same 打开), the devices, and the ways to 连接新设备 and 设置. Everything that
 * changes trust (pairing, removing, trusting a certificate) stays on its own settings page; this only leads there.
 */
export function ComputerChip({
  snapshot,
  view,
  connection,
  transport,
  links,
  trigger,
  side = 'bottom',
  align = 'start',
}: {
  snapshot: AppSnapshot
  view: ComputersView | undefined
  connection: ConnectionStatus
  /** How this window reaches the Host (`connectionTransport`), empty when it cannot tell. */
  transport: string
  links: ComputerLinks
  /** `title` is 「这台 Mac」 in the desktop app's own window once it lists computers, the computer's name otherwise. */
  trigger: (props: MenuTriggerProps, here: { name: string; title: string; state: string | undefined; several: boolean }) => ReactNode
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
}) {
  const computers = shellComputers()
  const hostId = hostView(snapshot)?.hostId
  const current = view?.computers.find(computer => computer.hostId === hostId)
  // Compared with this Mac's Host, which updates with the app; only this Mac's page knows it.
  const reference = view?.computers.find(computer => computer.local)?.hostId === hostId ? snapshot.version : undefined
  const others = otherComputerRows(view, hostId, reference)
  const [open, setOpen] = useState(false)
  const name = computerName(snapshot.hostName)
  const live = connection === 'connected'
  const address = current?.origin ? hostOf(current.origin) : pageAddress()
  const how = [transport, address].filter(Boolean).join(' · ')
  return (
    <Popover
      label="电脑"
      title={name}
      size="sm"
      side={side}
      align={align}
      onOpenChange={setOpen}
      trigger={props =>
        trigger(props, {
          name,
          title: current?.local ? '这台 Mac' : name,
          state: current && current.state !== 'online' ? computerState(current).text : undefined,
          several: (view?.computers.length ?? 0) > 1,
        })
      }>
      <div className="computer-pop">
        <div className="computer-pop-here" data-computer-here="">
          <span className="computer-pop-line">
            <LiveDot live={live} />
            <span className="computer-pop-name" title={name}>
              {name}
            </span>
            <span className="computer-pop-state">{CONNECTION_WORDS[connection]}</span>
          </span>
          {how && <span className="computer-pop-how">{how}</span>}
        </div>
        {others.length > 0 && computers && (
          <div className="computer-pop-group" role="group" aria-label="其他电脑">
            {others.map(row => (
              <OtherComputer key={row.hostId} row={row} onOpen={() => void computers.open(row.hostId)} onManage={links.settings} />
            ))}
          </div>
        )}
        {(links.devices || links.connect || links.settings) && (
          <div className="computer-pop-group">
            {links.devices && <DevicesRow open={open} links={links.devices} snapshot={snapshot} />}
            {links.connect && (
              <MenuFooterLink icon={PlusGlyph} chevron={false} closes onClick={links.connect}>
                连接新设备
              </MenuFooterLink>
            )}
            {links.settings && (
              <MenuFooterLink icon={SettingsGlyph} closes onClick={links.settings}>
                设置
              </MenuFooterLink>
            )}
          </div>
        )}
      </div>
    </Popover>
  )
}

/** The trigger in a sidebar's head: the computer's name, its state when it is not online, and the chevron. */
export function SidebarComputerTrigger({ props, name, state }: { props: MenuTriggerProps; name: string; state: string | undefined }) {
  return (
    <button {...props} type="button" className="sidebar-host sidebar-host-menu" title={name}>
      <LaptopGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
      <span className="sidebar-host-name">{name}</span>
      {state && <span className="sidebar-host-state">{state}</span>}
      <UpDownGlyph className="sidebar-host-chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
    </button>
  )
}

function OtherComputer({ row, onOpen, onManage }: { row: OtherComputerRow; onOpen: () => void; onManage: (() => void) | undefined }) {
  const close = useLayerClose()
  return (
    <div className="computer-pop-row" data-computer-row={row.hostId}>
      <button
        type="button"
        className="ui-menu-footer-link computer-pop-other"
        title={row.name}
        onClick={() => {
          close()
          onOpen()
        }}>
        <span className="ui-menu-item-lead">
          <span className="computer-dot" data-state={row.state} aria-hidden="true" />
        </span>
        <span className="computer-pop-other-text">
          <span className="computer-pop-other-name">{row.name}</span>
          <span className="computer-pop-other-state">{row.text}</span>
        </span>
        <span className="computer-pop-other-meta">
          {row.older && <span className="computer-older">版本较旧</span>}
          {row.count > 0 && <span className="computer-count">{row.count}</span>}
        </span>
      </button>
      <Menu
        label={`${row.name} 的操作`}
        context={rowOf('.computer-pop-row')}
        sections={[
          {
            id: 'computer',
            items: [
              { id: 'open', label: '打开', leading: <Icon icon={LaptopGlyph} size={14} />, onSelect: onOpen },
              ...(onManage ? [{ id: 'manage', label: '设置', leading: <Icon icon={SettingsGlyph} size={14} />, onSelect: onManage }] : []),
            ],
          },
        ]}
      />
    </div>
  )
}

/** 设备 with how many this Host lists, read once each time the popover opens (a device with 管理 only). */
function DevicesRow({ open, links, snapshot }: { open: boolean; links: NonNullable<ComputerLinks['devices']>; snapshot: AppSnapshot }) {
  const [count, setCount] = useState<number | null>(null)
  const self = snapshot.device.id
  useEffect(() => {
    if (!open || !links.count) return undefined
    let active = true
    request<{ devices: Device[] }>('devices')
      .then(next => {
        if (active) setCount(listedDevices(next.devices, self).length)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [open, links.count, self])
  return (
    <MenuFooterLink icon={DevicesGlyph} closes onClick={links.open}>
      <span className="computer-pop-devices">
        设备
        {count !== null && <span className="computer-pop-count">{`${count} 台`}</span>}
      </span>
    </MenuFooterLink>
  )
}

/** The address of a computer as a person reads it: host and port. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return ''
  }
}

/** The address of this page where it is a web address; the desktop app's own scheme names none. */
function pageAddress(): string {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return ''
  // The Host's per-identity loopback alias (h-<hostId>.localhost) says nothing a person reads: its port does.
  return /^h-[a-z2-7]{52}\.localhost$/u.test(location.hostname) ? `localhost:${location.port}` : location.host
}

/**
 * 等你处理's rows from other computers, after this computer's own: a computer that answers lists its sessions, each with
 * its name on the second line, and clicking one opens that computer's window on it. One that does not answer is a single
 * grey row, 「离线前 N 项」: what waited before it went, not live.
 */
export function OtherComputersWaiting({ others, now }: { others: readonly OtherWaiting[]; now: number }) {
  const api = shellComputers()
  if (others.length === 0 || !api) return null
  return (
    <div className="other-computers" data-other-computers="">
      <p className="other-computers-label">其他电脑</p>
      <ul>
        {others.map(({ computer, items, live }) =>
          live ? (
            items.map(item => {
              const title = item.title || '未命名会话'
              const words = ATTENTION_WORDS[item.kind]
              return (
                <li key={`${computer.hostId}:${item.taskId}`} className="session-entry">
                  <div className="session-item is-strong" data-computer-item={computer.hostId}>
                    <button
                      type="button"
                      className="session-item-main"
                      data-attention-task={item.taskId}
                      title={`${computer.name} · ${title}`}
                      onClick={() => void api.open(computer.hostId, item.taskId)}>
                      <span className="session-line">
                        <span className="session-title">{title}</span>
                        <span className="session-status ui-status-time">{relativeTime(item.since, new Date(now))}</span>
                      </span>
                      <span className="session-meta" aria-hidden="true">
                        <LaptopGlyph className="session-computer-icon" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />
                        <span className="session-computer">{computer.name}</span>
                        <span className="session-wait">{`· ${words}`}</span>
                      </span>
                      <span className="sr-only">{`，${computer.name}，${words}`}</span>
                    </button>
                  </div>
                </li>
              )
            })
          ) : (
            <li key={computer.hostId} className="session-entry">
              <div className="session-item" data-computer-item={computer.hostId} data-stale="">
                <button
                  type="button"
                  className="session-item-main"
                  title={`${computer.name} · 不是实时`}
                  onClick={() => void api.open(computer.hostId)}>
                  <span className="session-line">
                    <span className="session-title">{computer.name}</span>
                    <span className="other-computers-stale">{`离线前 ${items.length} 项`}</span>
                  </span>
                  <span className="session-meta" aria-hidden="true">
                    <LaptopGlyph className="session-computer-icon" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />
                    <span className="session-meta-rest">{computerState(computer).text}</span>
                  </span>
                  <span className="sr-only">{`，${computerState(computer).text}，不是实时`}</span>
                </button>
              </div>
            </li>
          ),
        )}
      </ul>
    </div>
  )
}
