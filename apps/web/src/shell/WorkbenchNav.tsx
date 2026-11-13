import { Columns3, LayoutDashboard } from 'lucide-react'
import {
  Button,
  IconButton,
  Menu,
  NewSessionGlyph,
  SearchGlyph,
  SettingsGlyph,
  PluginsGlyph,
  PanelLeftGlyph,
  ChevronLeftGlyph,
} from '@latch/ui'
import { setPreference, type WorkbenchLayout } from '../preferences.ts'
import { currentShell } from '../core/shell.ts'
import { ShellDelegate, SpaceButtons, shellSpaces } from './SpaceNav.tsx'
import type { ShellState } from './useShellLayout.tsx'

/** The same choice as Settings, available without leaving a draft or a reading position. */
export function LayoutMenu({ value }: { value: WorkbenchLayout }) {
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
        <IconButton {...props} data-layout-trigger="" label="布局" icon={value === 'overview' ? LayoutDashboard : Columns3} />
      )}
    />
  )
}

/** Triage's navigation is above the work, leaving its home the whole width. */
export function WorkbenchNav({ shell }: { shell: ShellState }) {
  const spaces = shellSpaces(shell)
  return (
    <div ref={shell.titlebar} className="titlebar workbench-nav" data-lights={currentShell()?.platform === 'darwin' ? '' : undefined}>
      <span className="workbench-brand">Latch</span>
      {!shell.route.overview && shell.route.entry === 'sessions' && (
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
      <Button variant="ghost" icon={LayoutDashboard} aria-pressed={shell.route.overview === true} onClick={shell.openOverview}>
        总览
      </Button>
      {spaces && <SpaceButtons {...spaces} />}
      <span className="workbench-nav-spacer" />
      {shell.space === 'agents' ? (
        <ShellDelegate shell={shell} compact />
      ) : (
        <IconButton label="新建会话" icon={NewSessionGlyph} onClick={shell.startNew} />
      )}
      <IconButton label="搜索" icon={SearchGlyph} onClick={shell.openSearch} />
      {shell.entries.includes('apps') && <IconButton label="应用" icon={PluginsGlyph} onClick={() => shell.openApp()} />}
      <LayoutMenu value={shell.preferences.workbenchLayout} />
      {shell.entries.includes('settings') && <IconButton label="设置" icon={SettingsGlyph} onClick={() => shell.goEntry('settings')} />}
    </div>
  )
}
