import { Columns3 } from 'lucide-react'
import {
  Button,
  OverviewGlyph,
  ScheduleGlyph,
  Icon,
  IconButton,
  Menu,
  NewSessionGlyph,
  SearchGlyph,
  SettingsGlyph,
  PluginsGlyph,
  PanelLeftGlyph,
  ChevronLeftGlyph,
  HistoryGlyph,
  LaptopGlyph,
  Kbd,
} from '@latch/ui'
import { setPreference, type WorkbenchLayout } from '../preferences.ts'
import { currentShell } from '../core/shell.ts'
import { ShellDelegate, SpaceButtons, SpaceSwitch, shellSpaces } from './SpaceNav.tsx'
import { BrandMark } from '../components/ui.tsx'
import { ComputerMenu } from '../components/Computers.tsx'
import { useComputers } from '../core/computers.ts'
import { computerName } from '../core/securityCopy.ts'
import type { ShellState } from './useShellLayout.tsx'
import { useViewport } from '../breakpoints.ts'

/** On tablets the project tree is a drawer beside a persistent 60px navigation rail. */
export function TabletRail({ shell }: { shell: ShellState }) {
  const spaces = shellSpaces(shell)
  return (
    <nav className="workbench-tablet-rail" aria-label="工作台导航">
      <span className="workbench-rail-brand">
        <BrandMark size={24} />
      </span>
      {spaces && <SpaceButtons {...spaces} />}
      <IconButton label="总览" icon={OverviewGlyph} pressed={shell.route.overview === true} onClick={shell.openOverview} />
      <IconButton label="新建会话" icon={NewSessionGlyph} onClick={shell.startNew} />
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
      {shell.entries.includes('settings') && <IconButton label="设置" icon={SettingsGlyph} onClick={() => shell.goEntry('settings')} />}
    </nav>
  )
}

/** The same choice as Settings, available without leaving a draft or a reading position. */
export function LayoutMenu({ value }: { value: WorkbenchLayout }) {
  const phone = useViewport() === 'phone'
  const choose = (layout: WorkbenchLayout) => {
    setPreference('workbenchLayout', layout)
    // Switching the navigation replaces this trigger; return keyboard focus to its visible counterpart.
    requestAnimationFrame(() => {
      const trigger = [...document.querySelectorAll<HTMLElement>('[data-layout-trigger]')].find(
        element => element.checkVisibility({ visibilityProperty: true }) && !element.closest('[inert]'),
      )
      trigger?.focus({ preventScroll: true })
    })
  }
  return (
    <Menu
      label="布局"
      selection
      sections={[
        {
          id: 'layout',
          items: [
            { id: 'overview', label: '总览', checked: value === 'overview', onSelect: () => choose('overview') },
            { id: 'triage', label: '分拣台', checked: value === 'triage', onSelect: () => choose('triage') },
          ],
        },
      ]}
      trigger={props => (
        <Button
          {...props}
          data-layout-trigger=""
          variant="ghost"
          aria-label="布局"
          menu
          icon={phone ? undefined : value === 'overview' ? OverviewGlyph : Columns3}>
          {phone ? '布局' : value === 'overview' ? '总览' : '分拣台'}
        </Button>
      )}
    />
  )
}

export function WorkbenchComputer({ shell }: { shell: ShellState }) {
  const computers = useComputers()
  if (!shell.entries.includes('settings'))
    return (
      <span className="workbench-computer">
        <Icon icon={LaptopGlyph} size={16} />
        {computerName(shell.snapshot.hostName)}
      </span>
    )
  return computers && computers.computers.length > 1 ? (
    <ComputerMenu snapshot={shell.snapshot} view={computers} onManage={() => shell.openSettings('computers')} />
  ) : (
    <Button variant="ghost" className="workbench-computer-button" icon={LaptopGlyph} onClick={() => shell.openSettings('computers')}>
      {computerName(shell.snapshot.hostName)}
    </Button>
  )
}

/** Triage's navigation is above the work, leaving its home the whole width. */
export function WorkbenchNav({ shell }: { shell: ShellState }) {
  const spaces = shellSpaces(shell)
  return (
    <div ref={shell.titlebar} className="titlebar workbench-nav" data-lights={currentShell()?.platform === 'darwin' ? '' : undefined}>
      <span className="workbench-brand" aria-label="Latch">
        <BrandMark size={24} />
      </span>
      {spaces && <SpaceSwitch {...spaces} />}
      {!shell.route.overview && !shell.route.allSessions && shell.route.entry === 'sessions' && (
        <IconButton
          ref={shell.sidebarToggle}
          label={shell.sidebarColumn ? (shell.sidebarCollapsed ? '展开侧栏' : '收起侧栏') : '打开会话列表'}
          icon={PanelLeftGlyph}
          aria-controls="session-navigation"
          aria-expanded={shell.sidebarColumn ? !shell.sidebarCollapsed : shell.drawer.open}
          onClick={() => (shell.sidebarColumn ? shell.setSidebarShut(!shell.sidebarCollapsed) : shell.drawer.show())}
        />
      )}
      {shell.route.overview && <IconButton label="返回会话" icon={ChevronLeftGlyph} onClick={() => shell.goEntry('sessions')} />}
      <nav className="workbench-primary-nav" aria-label="工作台">
        <Button
          variant="ghost"
          icon={OverviewGlyph}
          aria-label="总览"
          aria-current={shell.route.overview ? 'page' : undefined}
          onClick={shell.openOverview}>
          <span className="workbench-nav-label">总览</span>
        </Button>
        <Button
          variant="ghost"
          icon={HistoryGlyph}
          aria-label={shell.space === 'agents' ? '全部话题' : '全部会话'}
          aria-current={shell.route.allSessions ? 'page' : undefined}
          onClick={shell.space === 'agents' ? () => shell.goEntry('agents') : shell.openAllSessions}>
          <span className="workbench-nav-label">{shell.space === 'agents' ? '全部话题' : '全部会话'}</span>
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
      {shell.space === 'agents' ? (
        <ShellDelegate shell={shell} compact />
      ) : (
        <IconButton label="新建会话" icon={NewSessionGlyph} onClick={shell.startNew} />
      )}
      <Button variant="ghost" className="workbench-search" aria-label="搜索" icon={SearchGlyph} onClick={shell.openSearch}>
        <span className="workbench-nav-label">搜索</span>
        <Kbd>⌘K</Kbd>
      </Button>
      <WorkbenchComputer shell={shell} />
      {shell.entries.includes('apps') && <IconButton label="应用" icon={PluginsGlyph} onClick={() => shell.openApp()} />}
      <LayoutMenu value={shell.preferences.workbenchLayout} />
      {shell.entries.includes('settings') && <IconButton label="设置" icon={SettingsGlyph} onClick={() => shell.goEntry('settings')} />}
    </div>
  )
}
