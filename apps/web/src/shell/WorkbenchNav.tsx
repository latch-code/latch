import type { ComponentProps } from 'react'
import {
  Button,
  OverviewGlyph,
  ScheduleGlyph,
  IconButton,
  NewSessionGlyph,
  SearchGlyph,
  SettingsGlyph,
  PanelLeftGlyph,
  LaptopGlyph,
  ICON_STROKE,
  LiveDot,
  StatusStrip,
  type StripFact,
} from '@latch/ui'
import { currentShell, type ComputersView } from '../core/shell.ts'
import { ShellNewAgent, SpaceButtons, shellOverview, shellSpaces } from './SpaceNav.tsx'
import { BrandMark } from '../components/ui.tsx'
import { ComputerChip, SidebarComputerTrigger } from '../components/Computers.tsx'
import { CONNECTION_WORDS, connectionTransport, useComputers } from '../core/computers.ts'
import { connectWays } from '../settings/devices/deviceRows.ts'
import { settingsSections } from '../settings/SettingsPage.tsx'
import { hostView } from '../core/permissions.ts'
import { shortcutKeys } from '../workbenchShortcuts.ts'
import { UsageEntry } from '../usage/UsageEntry.tsx'
import { ShellUpdateCheck } from './UpdateCheck.tsx'
import type { ShellState } from './useShellLayout.tsx'

/** On tablets the project tree is a drawer beside a persistent 60px navigation rail. */
export function TabletRail({ shell }: { shell: ShellState }) {
  const spaces = shellSpaces(shell)
  const home = shellOverview(shell)
  const inAgents = spaces?.space === 'agents'
  return (
    // Under a page the rail's column is the page's own list: nothing here is in the focus order then.
    <nav className="workbench-tablet-rail" aria-label="工作台导航" inert={shell.route.entry !== 'sessions' || shell.board || undefined}>
      <span className="workbench-rail-brand">
        <BrandMark size={24} />
      </span>
      {spaces && <SpaceButtons {...spaces} />}
      {home && <IconButton label="总览" icon={OverviewGlyph} pressed={home.active} onClick={home.open} />}
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

/** The computer's name as a quiet button: in 看板's title row and 我的 Agent's foot. */
const chipTrigger: ComponentProps<typeof ComputerChip>['trigger'] = (props, here) => (
  <Button {...props} variant="ghost" className="workbench-computer-button" icon={LaptopGlyph} title={here.name}>
    <span className="sidebar-host-name">{here.name}</span>
  </Button>
)

/** The computer's name where 看板 and 我的 Agent stand it: the trigger of the computer popover. */
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
