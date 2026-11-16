import type { ComponentProps } from 'react'
import {
  Button,
  OverviewGlyph,
  ScheduleGlyph,
  Icon,
  IconButton,
  NewSessionGlyph,
  SearchGlyph,
  SettingsGlyph,
  PluginsGlyph,
  PanelLeftGlyph,
  HistoryGlyph,
  LaptopGlyph,
  ICON_STROKE,
  Kbd,
  LiveDot,
  StatusStrip,
  type StripFact,
} from '@latch/ui'
import { currentShell, lightsStyle, useTrafficLights, type ComputersView } from '../core/shell.ts'
import { ShellNewAgent, SpaceButtons, SpaceSwitch, shellOverview, shellSpaces } from './SpaceNav.tsx'
import { BrandMark } from '../components/ui.tsx'
import { ComputerChip, SidebarComputerTrigger } from '../components/Computers.tsx'
import { CONNECTION_WORDS, connectionTransport, useComputers } from '../core/computers.ts'
import { connectWays } from '../settings/devices/deviceRows.ts'
import { settingsSections } from '../settings/SettingsPage.tsx'
import { hostView } from '../core/permissions.ts'
import { shortcutKeys } from '../workbenchShortcuts.ts'
import { UsageEntry } from '../usage/UsageEntry.tsx'
import { ShellUpdateCheck } from './UpdateCheck.tsx'
import { WorkbenchPanes } from './WorkbenchPanes.tsx'
import type { ShellState } from './useShellLayout.tsx'

/** On tablets the project tree is a drawer beside a persistent 60px navigation rail. */
export function TabletRail({ shell }: { shell: ShellState }) {
  const spaces = shellSpaces(shell)
  const home = shellOverview(shell)
  const inAgents = spaces?.space === 'agents'
  return (
    // Under a page the rail's column is the page's own list: nothing here is in the focus order then.
    <nav
      className="workbench-tablet-rail"
      aria-label="工作台导航"
      inert={shell.route.entry !== 'sessions' || shell.homeFocused || undefined}>
      <span className="workbench-rail-brand">
        <BrandMark size={24} />
      </span>
      {spaces && <SpaceButtons {...spaces} />}
      <IconButton label="总览" icon={OverviewGlyph} pressed={home.active} onClick={home.open} />
      {inAgents ? <ShellNewAgent shell={shell} compact /> : <IconButton label="新建会话" icon={NewSessionGlyph} onClick={shell.startNew} />}
      <IconButton label="搜索" icon={SearchGlyph} onClick={shell.openSearch} />
      {shell.catalog?.features?.automations && (
        <IconButton label="定时任务" icon={ScheduleGlyph} onClick={() => shell.openMyAgent({ id: 'general', tab: 'schedules' })} />
      )}
      <IconButton
        ref={shell.sidebarToggle}
        label="打开会话列表"
        icon={PanelLeftGlyph}
        aria-controls="session-navigation"
        aria-expanded={shell.drawer.open}
        onClick={() => shell.drawer.show()}
      />
      <span className="workbench-rail-spacer" />
      {shell.access.scopes.has('view') && <UsageEntry />}
      {shell.entries.includes('settings') && <IconButton label="设置" icon={SettingsGlyph} onClick={() => shell.goEntry('settings')} />}
      <ShellUpdateCheck shell={shell} />
    </nav>
  )
}

/** The computer's name as a quiet button: in the status bar, the 顶栏 layout and 我的 Agent's foot. */
const chipTrigger: ComponentProps<typeof ComputerChip>['trigger'] = (props, here) => (
  <Button {...props} variant="ghost" className="workbench-computer-button" icon={LaptopGlyph} title={here.name}>
    <span className="sidebar-host-name">{here.name}</span>
  </Button>
)

/** The computer's name where the 顶栏 layout and 我的 Agent stand it: the trigger of the computer popover. */
export function WorkbenchComputer({ shell }: { shell: ShellState }) {
  return <ShellComputer shell={shell} computers={useComputers()} trigger={chipTrigger} />
}

/** The sidebar head's computer row as the popover's trigger: 「这台 Mac」 or the computer's name, and its state. */
export function SidebarComputer({ shell, computers }: { shell: ShellState; computers: ComputersView | undefined }) {
  return (
    <ShellComputer
      shell={shell}
      computers={computers}
      trigger={(props, here) => <SidebarComputerTrigger props={props} name={here.title} state={here.state} />}
    />
  )
}

/** The phone list's heading line, the computer this list comes from, as the popover's trigger (a sheet there). */
export function PhoneComputer({ shell }: { shell: ShellState }) {
  return (
    <ShellComputer
      shell={shell}
      computers={undefined}
      trigger={(props, here) => (
        <button {...props} type="button" className="phone-list-host" title={here.name}>
          <LaptopGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
          <span className="phone-list-host-name">{here.name}</span>
        </button>
      )}
    />
  )
}

/**
 * The computer popover with this shell's ways out: 设置 › 电脑 where the chip used to lead, 设置 › 设备 where this device
 * sees it, and 连接新设备 where this device can pair.
 */
export function ShellComputer({
  shell,
  computers,
  trigger,
  side,
}: {
  shell: ShellState
  computers: ComputersView | undefined
  trigger: ComponentProps<typeof ComputerChip>['trigger']
  side?: 'top' | 'bottom'
}) {
  const settings = shell.entries.includes('settings')
  const devices = settings && settingsSections(shell.snapshot, shell.access).includes('devices')
  const pair = devices && connectWays(currentShell(), shell.access, shell.snapshot.host.tls).pair
  return (
    <ComputerChip
      snapshot={shell.snapshot}
      view={computers}
      connection={shell.connection}
      transport={shellTransport(shell)}
      side={side}
      links={{
        settings: settings ? () => shell.openSettings('computers') : undefined,
        devices: devices ? { open: () => shell.openSettings('devices'), count: shell.access.admin } : undefined,
        connect: pair ? () => shell.openSettings('devices') : undefined,
      }}
      trigger={trigger}
    />
  )
}

/** How this window reaches its Host while it is connected (`connectionTransport`). */
function shellTransport(shell: ShellState): string {
  return shell.connection === 'connected'
    ? connectionTransport(window.location, {
        local: shell.access.local,
        remote: currentShell()?.remote === true,
        hostId: hostView(shell.snapshot)?.hostId,
      })
    : ''
}

/** Uses the connection of this page and the computers this desktop has actually listed. */
export function WorkbenchConnection({ shell, inert }: { shell: ShellState; inert: boolean }) {
  const computers = useComputers()
  const desktop = currentShell()
  const connected = shell.connection === 'connected'
  const transport = shellTransport(shell)
  const online =
    connected && computers && !computers.problem ? computers.computers.filter(computer => computer.state === 'online').length : null
  const facts: StripFact[] = [
    {
      id: 'connection',
      text: CONNECTION_WORDS[shell.connection],
      lead: (
        <>
          <LiveDot live={connected} />
          <ShellComputer shell={shell} computers={computers} side="top" trigger={chipTrigger} />
        </>
      ),
    },
    { id: 'transport', text: transport },
    { id: 'online', text: online === null ? '' : `${online} 台在线` },
    { id: 'search', text: shortcutKeys('palette', desktop !== null) ?? '', end: true },
  ]
  return (
    <footer className="workbench-connection" inert={inert || undefined}>
      <StatusStrip facts={facts} label="连接状态" />
    </footer>
  )
}

/** The 顶栏 layout's navigation is above the work, leaving its home the whole width. */
export function WorkbenchNav({ shell }: { shell: ShellState }) {
  const spaces = shellSpaces(shell)
  const lights = useTrafficLights()
  const home = shellOverview(shell)
  // In 我的 Agent the same three ways lead to the space's own pages: its 总览, 全部话题 and 定时任务.
  const inAgents = spaces?.space === 'agents'
  const allActive = inAgents ? shell.route.entry === 'agents' && shell.route.topics === true : shell.route.allSessions === true
  return (
    <div
      ref={shell.titlebar}
      className="titlebar workbench-nav"
      inert={shell.homeFocused || undefined}
      data-lights={lights ? '' : undefined}
      style={lightsStyle(currentShell())}>
      <span className="workbench-brand" aria-label="Latch">
        <BrandMark size={24} />
      </span>
      {spaces && <SpaceSwitch {...spaces} />}
      {!shell.sidebarColumn && !shell.route.overview && !shell.route.allSessions && shell.route.entry === 'sessions' && (
        <IconButton
          ref={shell.sidebarToggle}
          label={shell.sidebarColumn ? (shell.sidebarCollapsed ? '展开侧栏' : '收起侧栏') : '打开会话列表'}
          icon={PanelLeftGlyph}
          aria-controls="session-navigation"
          aria-expanded={shell.sidebarColumn ? !shell.sidebarCollapsed : shell.drawer.open}
          onClick={() => (shell.sidebarColumn ? shell.setSidebarShut(!shell.sidebarCollapsed) : shell.drawer.show())}
        />
      )}
      <nav className="workbench-primary-nav" aria-label="工作台">
        <Button variant="ghost" icon={OverviewGlyph} aria-label="总览" aria-current={home.active ? 'page' : undefined} onClick={home.open}>
          <span className="workbench-nav-label">总览</span>
        </Button>
        <Button
          variant="ghost"
          icon={HistoryGlyph}
          aria-label={inAgents ? '全部话题' : '全部会话'}
          aria-current={allActive ? 'page' : undefined}
          onClick={inAgents ? () => shell.openAgentTopics() : shell.openAllSessions}>
          <span className="workbench-nav-label">{inAgents ? '全部话题' : '全部会话'}</span>
        </Button>
        {shell.catalog?.features?.automations && (
          <Button
            variant="ghost"
            icon={ScheduleGlyph}
            aria-label="定时任务"
            onClick={() => shell.openMyAgent({ id: 'general', tab: 'schedules' })}>
            <span className="workbench-nav-label">定时任务</span>
          </Button>
        )}
      </nav>
      <span className="workbench-nav-spacer" />
      {/* The queue's rail leads with 新建 Agent; 全部话题 has no rail, so the way stays here. */}
      {inAgents && shell.route.entry === 'agents' && shell.route.topics === true && <ShellNewAgent shell={shell} compact />}
      <Button variant="ghost" className="workbench-search" aria-label="搜索" icon={SearchGlyph} onClick={shell.openSearch}>
        <span className="workbench-nav-label">搜索</span>
        <Kbd>⌘K</Kbd>
      </Button>
      {shell.route.entry !== 'sessions' && <WorkbenchComputer shell={shell} />}
      {shell.access.scopes.has('view') && <UsageEntry />}
      {shell.entries.includes('apps') && <IconButton label="应用" icon={PluginsGlyph} onClick={() => shell.openApp()} />}
      {shell.entries.includes('settings') && <IconButton label="设置" icon={SettingsGlyph} onClick={() => shell.goEntry('settings')} />}
      <ShellUpdateCheck shell={shell} />
      <WorkbenchPanes shell={shell} />
      {/* The layout switch is the shell's, drawn over this reserved end in both layouts. */}
      <span className="layout-switch-space" aria-hidden="true" />
    </div>
  )
}
