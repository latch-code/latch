import { useEffect, useState, type ReactNode } from 'react'
import {
  DevicesGlyph,
  ICON_STROKE,
  Icon,
  InlineNotice,
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
  currentDesktopComputer,
  otherComputerRows,
  type OtherComputerList,
  type OtherComputerRow,
  type OtherWaiting,
} from '../core/computers.ts'
import type { ComputerSession } from '@latch/protocol'
import { ShelfHead } from './ProjectNavigation.tsx'
import { hostView } from '../core/permissions.ts'
import { computerName, describeFailure } from '../core/securityCopy.ts'
import { shellComputers, type ComputersView } from '../core/shell.ts'
import type { ConnectionStatus } from '../core/useHarness.ts'
import { relativeTime } from '../format.ts'
import { listedDevices } from '../settings/devices/deviceRows.ts'
import { Menu, rowOf } from './overlays.tsx'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    computer: '电脑',
    thisMac: '这台 Mac',
    otherComputers: '其他电脑',
    connect: '连接新设备',
    settings: '设置',
    oldBuild: '版本较旧',
    actions: (value1: string | number) => `${value1} 的操作`,
    openComputerWindow: '打开电脑窗口',
    openSeparateWindow: '在单独窗口打开',
    openMainWindow: '在主窗口打开',
    switchMainWindow: '在主窗口切换',
    opening: '正在打开…',
    switching: '正在切换…',
    devices: '设备',
    deviceCount: (count: number) => `${formatNumber(count)} 台`,
    untitled: '未命名会话',
    offlineTitle: (value1: string | number) => `${value1} · 不是实时`,
    offlineItems: (count: number) => `离线前 ${formatNumber(count)} 项`,
    offlineState: (value1: string | number) => `，${value1}，不是实时`,
    waiting: '等你处理',
    running: '运行中',
    failed: '失败',
    notLive: '不是实时',
    offlineLabel: '，不是实时',
    noSessions: '没有会话',
    recent: (count: number, value2: string) => `最近 ${formatNumber(count)} 个 · 在 ${value2} 上查看全部`,
  },
  {
    computer: 'Computer',
    thisMac: 'This Mac',
    otherComputers: 'Other computers',
    connect: 'Connect a device',
    settings: 'Settings',
    oldBuild: 'Outdated version',
    actions: (value1: string | number) => `Actions for ${value1}`,
    openComputerWindow: 'Open computer window',
    openSeparateWindow: 'Open in separate window',
    openMainWindow: 'Open in main window',
    switchMainWindow: 'Switch in main window',
    opening: 'Opening…',
    switching: 'Switching…',
    devices: 'Devices',
    deviceCount: (count: number) => `${plural(count, { one: '{n} device', other: '{n} devices' })}`,
    untitled: 'Untitled session',
    offlineTitle: (value1: string | number) => `${value1} · not live`,
    offlineItems: (count: number) => `${plural(count, { one: '{n} item', other: '{n} items' })} before going offline`,
    offlineState: (value1: string | number) => `, ${value1}, not live`,
    waiting: 'Needs you',
    running: 'Running',
    failed: 'Failed',
    notLive: 'Not live',
    offlineLabel: ', not live',
    noSessions: 'No sessions',
    recent: (count: number, value2: string) => `${formatNumber(count)} recent · See all on ${value2}`,
  },
)

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
 * this window reaches it, the other computers the desktop app knows, the devices, and the ways to 连接新设备 and 设置.
 * Choosing a computer switches the workbench; its context menu can open a separate window.
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
  const page = typeof window === 'undefined' ? undefined : window.location
  const current = page && currentDesktopComputer(view, page)
  const hostId = current?.hostId ?? hostView(snapshot)?.hostId
  const others = otherComputerRows(view, hostId, current?.local ? snapshot.version : undefined)
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState<string>()
  const [switchError, setSwitchError] = useState('')
  const localPage = page?.protocol === 'latch:' && page.hostname === 'app'
  const name = localPage
    ? computerName(snapshot.hostName, current?.name || COPY.thisMac)
    : (current?.name ?? computerName(snapshot.hostName))
  const live = connection === 'connected'
  const address = current?.origin ? hostOf(current.origin) : pageAddress(page)
  const how = [transport, address].filter(Boolean).join(' · ')
  const canSwitch = typeof computers?.switchTo === 'function'
  const destination = !canSwitch ? COPY.openComputerWindow : computers.switchesInMainWindow ? COPY.switchMainWindow : ''
  const localId = view?.computers.find(computer => computer.local)?.hostId

  async function choose(targetHostId: string, close: () => void) {
    if (!computers || switching !== undefined) return
    setSwitchError('')
    setSwitching(targetHostId)
    try {
      const result = await (computers.switchTo ? computers.switchTo(targetHostId) : computers.open(targetHostId))
      if (result.ok) close()
      else setSwitchError(result.error)
    } catch {
      setSwitchError('computer-switch-failed')
    } finally {
      setSwitching(undefined)
    }
  }
  return (
    <Popover
      label={COPY.computer}
      title={name}
      size="sm"
      side={side}
      align={align}
      onOpenChange={next => {
        setOpen(next)
        if (next) setSwitchError('')
      }}
      trigger={props =>
        trigger(props, {
          name,
          title: current?.local ? COPY.thisMac : name,
          state: current && current.state !== 'online' ? computerState(current).text : undefined,
          several: (view?.computers.length ?? 0) > 1,
        })
      }>
      <div className="computer-pop">
        <div className="computer-pop-here" data-computer-here="" aria-current="true">
          <span className="computer-pop-line">
            <LiveDot live={live} />
            <span className="computer-pop-name" title={name}>
              {name}
            </span>
            <span className="computer-pop-state">{CONNECTION_WORDS[connection]}</span>
          </span>
          {how && <span className="computer-pop-how">{how}</span>}
        </div>
        {computers && (others.length > 0 || switchError) && (
          <div className="computer-pop-group" role="group" aria-label={COPY.otherComputers}>
            {destination && others.length > 0 && <div className="computer-pop-destination">{destination}</div>}
            {others.map(row => (
              <OtherComputer
                key={row.hostId}
                row={row}
                busy={switching !== undefined}
                pending={switching === row.hostId ? (canSwitch ? COPY.switching : COPY.opening) : ''}
                destination={destination}
                onChoose={close => void choose(row.hostId, close)}
                openLabel={row.hostId === localId ? COPY.openMainWindow : COPY.openSeparateWindow}
                onOpen={() => void computers.open(row.hostId)}
                onManage={links.settings}
              />
            ))}
            {switchError && (
              <InlineNotice tone="error">
                {describeFailure(0, switchError, { fallback: describeFailure(0, 'computer-switch-failed') })}
              </InlineNotice>
            )}
          </div>
        )}
        {(links.devices || links.connect || links.settings) && (
          <div className="computer-pop-group">
            {links.devices && <DevicesRow open={open} links={links.devices} snapshot={snapshot} />}
            {links.connect && (
              <MenuFooterLink icon={PlusGlyph} chevron={false} closes onClick={links.connect}>
                {COPY.connect}
              </MenuFooterLink>
            )}
            {links.settings && (
              <MenuFooterLink icon={SettingsGlyph} closes onClick={links.settings}>
                {COPY.settings}
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

function OtherComputer({
  row,
  busy,
  pending,
  destination,
  onChoose,
  openLabel,
  onOpen,
  onManage,
}: {
  row: OtherComputerRow
  busy: boolean
  pending: string
  destination: string
  onChoose: (close: () => void) => void
  openLabel: string
  onOpen: () => void
  onManage: (() => void) | undefined
}) {
  const close = useLayerClose()
  return (
    <div className="computer-pop-row" data-computer-row={row.hostId}>
      <button
        type="button"
        className="ui-menu-footer-link computer-pop-other"
        title={row.name}
        aria-disabled={busy || undefined}
        aria-description={destination || undefined}
        onClick={() => onChoose(close)}>
        <span className="ui-menu-item-lead">
          <span className="computer-dot" data-state={row.state} aria-hidden="true" />
        </span>
        <span className="computer-pop-other-text">
          <span className="computer-pop-other-name">{row.name}</span>
          <span className="computer-pop-other-state" aria-live="polite">
            {pending || row.text}
          </span>
        </span>
        <span className="computer-pop-other-meta">
          {row.older && <span className="computer-older">{COPY.oldBuild}</span>}
          {row.count > 0 && <span className="computer-count">{row.count}</span>}
        </span>
      </button>
      <Menu
        label={COPY.actions(row.name)}
        context={rowOf('.computer-pop-row')}
        sections={[
          {
            id: 'computer',
            items: [
              { id: 'open', label: openLabel, disabled: busy, leading: <Icon icon={LaptopGlyph} size={14} />, onSelect: onOpen },
              ...(onManage
                ? [{ id: 'manage', label: COPY.settings, leading: <Icon icon={SettingsGlyph} size={14} />, onSelect: onManage }]
                : []),
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
        {COPY.devices}
        {count !== null && <span className="computer-pop-count">{COPY.deviceCount(count)}</span>}
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
function pageAddress(location: Location | undefined): string {
  if (location?.protocol !== 'http:' && location?.protocol !== 'https:') return ''
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
      <p className="other-computers-label">{COPY.otherComputers}</p>
      <ul>
        {others.map(({ computer, items, live }) =>
          live ? (
            items.map(item => {
              const title = item.title || COPY.untitled
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
                  title={COPY.offlineTitle(computer.name)}
                  onClick={() => void api.open(computer.hostId)}>
                  <span className="session-line">
                    <span className="session-title">{computer.name}</span>
                    <span className="other-computers-stale">{COPY.offlineItems(items.length)}</span>
                  </span>
                  <span className="session-meta" aria-hidden="true">
                    <LaptopGlyph className="session-computer-icon" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />
                    <span className="session-meta-rest">{computerState(computer).text}</span>
                  </span>
                  <span className="sr-only">{COPY.offlineState(computerState(computer).text)}</span>
                </button>
              </div>
            </li>
          ),
        )}
      </ul>
    </div>
  )
}

const SESSION_WORDS: Record<ComputerSession['status'], string | undefined> = {
  get waiting() {
    return COPY.waiting
  },
  get running() {
    return COPY.running
  },
  get failed() {
    return COPY.failed
  },
  idle: undefined,
}

/**
 * The unified list's other computers, after this computer's own projects: each computer a shelf of its own (its name,
 * and its state when it does not answer), its sessions under their projects. A row opens that session in that
 * computer's own window; nothing here reaches this page's Host. A computer that does not answer keeps its last rows,
 * grey and without status words, under 「不是实时」.
 */
export function OtherComputersSessions({
  lists,
  now,
  folded,
  onFold,
}: {
  lists: readonly OtherComputerList[]
  now: number
  folded: ReadonlySet<string>
  onFold: (id: string) => void
}) {
  const api = shellComputers()
  if (!lists.length || !api) return null
  return (
    <>
      {lists.map(list => {
        const id = `computer:${list.hostId}`
        const shut = folded.has(id)
        return (
          <section
            key={list.hostId}
            className="session-group other-computer"
            aria-label={list.name}
            data-other-computer={list.hostId}
            data-stale={list.live ? undefined : ''}>
            <ShelfHead
              className="other-computer-head"
              lead={
                <LaptopGlyph className="other-computer-glyph" size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
              }
              label={
                <>
                  <span className="other-computer-name">{list.name}</span>
                  {!list.live && <span className="other-computer-state">{list.stateText}</span>}
                </>
              }
              folded={shut}
              onFold={() => onFold(id)}
              count={list.count}
            />
            {!shut && (
              <div className="other-computer-body">
                {!list.live && list.count > 0 && <p className="other-computer-note">{COPY.notLive}</p>}
                {list.projects.map(project => (
                  <div key={project.id ?? 'none'} className="other-computer-project" data-other-project={project.id ?? ''}>
                    <p className="other-computer-project-name" title={project.name}>
                      {project.name}
                    </p>
                    <ul>
                      {project.sessions.map(session => {
                        const title = session.title || COPY.untitled
                        const word = list.live ? SESSION_WORDS[session.status] : undefined
                        return (
                          <li key={session.taskId} className="session-entry">
                            <div className="session-item" data-computer-item={list.hostId} data-stale={list.live ? undefined : ''}>
                              <button
                                type="button"
                                className="session-item-main"
                                data-other-task={session.taskId}
                                title={`${list.name} · ${title}`}
                                onClick={() => void api.open(list.hostId, session.taskId)}>
                                <span className="session-line">
                                  <span className="session-title">{title}</span>
                                  {word ? (
                                    <span className="other-computer-status" data-status={session.status}>
                                      {word}
                                    </span>
                                  ) : (
                                    <span className="session-status ui-status-time">{relativeTime(session.updatedAt, new Date(now))}</span>
                                  )}
                                </span>
                                <span className="sr-only">{`，${list.name}，${project.name}${word ? `，${word}` : ''}${list.live ? '' : COPY.offlineLabel}`}</span>
                              </button>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
                {list.count === 0 && <p className="other-computer-note">{list.live ? COPY.noSessions : list.stateText}</p>}
                {list.capped && (
                  <button type="button" className="other-computer-more" data-other-more="" onClick={() => void api.open(list.hostId)}>
                    {COPY.recent(list.count, list.name)}
                  </button>
                )}
              </div>
            )}
          </section>
        )
      })}
    </>
  )
}
