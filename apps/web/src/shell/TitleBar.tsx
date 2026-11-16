import { ArrowLeft } from 'lucide-react'
import {
  OverviewGlyph,
  Count,
  Icon,
  IconButton,
  useLivePrevious,
  InboxGlyph,
  PanelLeftGlyph,
  NewSessionGlyph,
  LaptopGlyph,
  FolderGlyph,
} from '@latch/ui'
import { currentShell, lightsStyle, useTrafficLights } from '../core/shell.ts'
import { computerName } from '../core/securityCopy.ts'
import { waitingCount } from '../sessions.ts'
import { BrandMark } from '../components/ui.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { ShellNewAgent, SpaceButtons, shellOverview, shellSpaces } from './SpaceNav.tsx'
import { UsageEntry } from '../usage/UsageEntry.tsx'
import { WorkbenchPanes, workbenchPanes } from './WorkbenchPanes.tsx'
import type { ShellState } from './useShellLayout.tsx'

/**
 * The 52px row spanning the window. Its left zone holds the traffic lights' inset and ◧, with 新建会话 once the panel is
 * shut; its end is kept free for the shell's layout switch; the rest of the row is the conversation's header, or the title of a page. On the desktop app the row
 * moves the window, except over its controls.
 */
export function TitleBar({ shell }: { shell: ShellState }) {
  const {
    titlebar,
    route,
    sidebarColumn,
    sidebarCollapsed,
    drawerMode,
    drawer,
    setSidebarShut,
    sidebarToggle,
    startNew,
    goEntry,
    snapshot,
    openApprovals,
    setTitleSlot,
  } = shell
  const spaces = shellSpaces(shell)
  const home = shellOverview(shell)
  const desktop = currentShell()
  const lights = useTrafficLights()
  const approvals = waitingCount(snapshot)
  // The button shows only while something waits, so its count is told the value it rose from.
  const approvalsBefore = useLivePrevious(approvals)
  const sessions = route.entry === 'sessions'
  // What the shut panel would otherwise offer stays one click away here.
  const shut = sidebarColumn ? sidebarCollapsed : drawerMode && sessions
  // With two places, the shut lead holds the way between them, and the place's own primary.
  const placed = spaces !== undefined && (sessions || route.entry === 'agents')
  const overviewContext = sessions && route.overview && shell.preferences.workbenchLayout === 'overview'
  const project = overviewContext && shell.catalog?.workspaces.find(item => item.id !== 'default' && item.id === shell.choice.workspaceId)
  return (
    <div
      ref={titlebar}
      className="titlebar"
      inert={shell.homeFocused || undefined}
      data-lights={lights ? '' : undefined}
      style={lightsStyle(desktop)}
      data-shut={shut ? '' : undefined}
      data-waiting={approvals > 0 ? '' : undefined}
      data-spaces={shut && placed ? '' : undefined}>
      <div className="titlebar-lead">
        {sidebarColumn
          ? !workbenchPanes(shell).left && (
              <IconButton
                ref={sidebarToggle}
                label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
                icon={PanelLeftGlyph}
                shortcut={desktop ? '⌘B' : 'Alt B'}
                aria-controls="session-navigation"
                aria-expanded={!sidebarCollapsed}
                onClick={() => {
                  setSidebarShut(!sidebarCollapsed)
                }}
              />
            )
          : sessions && (
              <IconButton
                label="打开会话列表"
                icon={PanelLeftGlyph}
                aria-controls="session-navigation"
                aria-expanded={drawer.open}
                onClick={() => {
                  drawer.show()
                }}
              />
            )}
        {!shut && (sidebarColumn || !sessions) && (
          <span className="titlebar-wordmark">
            <BrandMark size={20} />
            Latch
          </span>
        )}
        {shut && (
          <>
            {placed && <SpaceButtons {...spaces} />}
            {placed && shell.space === 'agents' ? (
              <ShellNewAgent shell={shell} compact />
            ) : sessions ? (
              <IconButton
                label="新建会话"
                data-space-primary=""
                icon={NewSessionGlyph}
                pressed={route.overview === true}
                onClick={startNew}
              />
            ) : (
              <IconButton
                label="返回会话"
                icon={ArrowLeft}
                onClick={() => {
                  goEntry('sessions')
                }}
              />
            )}
            {approvals > 0 && (
              <IconButton
                label={`${approvals} 项等你处理`}
                icon={InboxGlyph}
                badge={<Count tone="warn" value={approvals} from={approvalsBefore} />}
                onClick={openApprovals}
              />
            )}
          </>
        )}
      </div>
      {(!sessions || route.overview) && (
        <header ref={setTitleSlot} className="topbar titlebar-page">
          {overviewContext && (
            <div className="work-landing-context">
              <span>
                <Icon icon={LaptopGlyph} size={12} />
                {computerName(snapshot.hostName)}
              </span>
              {project && (
                <span>
                  <Icon icon={FolderGlyph} size={12} />
                  <VisibleText text={project.name} />
                </span>
              )}
            </div>
          )}
        </header>
      )}
      <div className="titlebar-views">
        {sidebarColumn && sidebarCollapsed && shell.access.scopes.has('view') && <UsageEntry />}
        {/* A tablet's rail already holds 总览; the layout switch itself is the shell's, drawn over this reserved end. */}
        {sidebarColumn && shut && !home.active && <IconButton label="总览" icon={OverviewGlyph} onClick={home.open} />}
        <WorkbenchPanes shell={shell} />
        <span className="layout-switch-space" aria-hidden="true" />
      </div>
    </div>
  )
}
