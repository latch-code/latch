import { SHELL_COPY } from './copy.ts'
import { useShortcutBindings } from '../core/shortcutBindings.ts'
import { ArrowLeft, Store } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  Count,
  ChevronLeftGlyph,
  Icon,
  IconButton,
  useLivePrevious,
  InboxGlyph,
  PanelLeftGlyph,
  NewSessionGlyph,
  LaptopGlyph,
  FolderGlyph,
  SettingsGlyph,
} from '@latch/ui'
import { currentShell, lightsStyle, useTrafficLights } from '../core/shell.ts'
import { computerName } from '../core/securityCopy.ts'
import { waitingCount } from '../sessions.ts'
import { BrandMark } from '../components/ui.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { ShellNewAgent, SpaceButtons, shellSpaces } from './SpaceNav.tsx'
import { UsageEntry } from '../usage/UsageEntry.tsx'
import { shortcutKeys } from '../workbenchShortcuts.ts'
import { ShellUpdateCheck } from './UpdateCheck.tsx'
import { WorkbenchPanes, workbenchPanes } from './WorkbenchPanes.tsx'
import { WorkbenchComputer } from './WorkbenchNav.tsx'
import { ViewSwitch } from './ViewSwitch.tsx'
import type { ShellState } from './useShellLayout.tsx'
import { defineCopy, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    waiting: (count: number) => `${count} 项等你处理`,
  },
  {
    waiting: (count: number) => plural(count, { one: '{n} item needs your attention', other: '{n} items need your attention' }),
  },
)

/**
 * The 52px row spanning the window. Its left zone holds the traffic lights' inset, the brand and the 对话 | 看板 switch
 * (compact words while there is room, icons when narrow), with Space buttons and 新建会话 once the sidebar is shut; its
 * end holds the draft summary and panel toggles (or, over 看板, the sidebar foot's 设置, 额度与用量 and 检查更新). From
 * 1280 an open right panel's strip shares the row: the panel's column starts at the window's top and its strip keeps this
 * end clear. Keeping one `.titlebar` and `.titlebar-lead` across 对话 ⇄ 看板 lets the view switch stay mounted and hold
 * focus through a switch. On the desktop app the row moves the window, except over its controls.
 */
export function TitleBar({ shell, draftSummary, boardWaiting }: { shell: ShellState; draftSummary?: ReactNode; boardWaiting: number }) {
  useShortcutBindings()
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
  const desktop = currentShell()
  const lights = useTrafficLights()
  const approvals = waitingCount(snapshot)
  // The button shows only while something waits, so its count is told the value it rose from.
  const approvalsBefore = useLivePrevious(approvals)
  const sessions = route.entry === 'sessions'
  const board = shell.board
  // What the shut panel would otherwise offer stays one click away here.
  const shut = !board && (sidebarColumn ? sidebarCollapsed : drawerMode && sessions)
  // With two places, the shut lead holds the way between them, and the place's own primary.
  const placed = spaces !== undefined && (sessions || route.entry === 'agents')
  const startContext = sessions && route.start && !board
  const project = startContext && shell.catalog?.workspaces.find(item => item.id !== 'default' && item.id === shell.choice.workspaceId)
  // On tablets in sessions the 60px navigation rail carries the view switch; everywhere else the titlebar's lead does.
  const viewInTabletRail = shell.viewport === 'tablet' && !board && sessions
  return (
    <div
      ref={titlebar}
      className="titlebar"
      data-board={board ? '' : undefined}
      data-lights={lights ? '' : undefined}
      style={lightsStyle(desktop)}
      data-shut={shut ? '' : undefined}
      data-waiting={!board && approvals > 0 ? '' : undefined}
      data-spaces={shut && placed ? '' : undefined}>
      <div className="titlebar-lead">
        {(board || (!shut && (sidebarColumn || !sessions))) && (
          <span className="titlebar-wordmark">
            <BrandMark size={20} />
            <span className="titlebar-wordmark-text">Latch</span>
          </span>
        )}
        {!shell.marketplace && !viewInTabletRail && (
          <div className="titlebar-view-slot">
            <ViewSwitch className="shell-view-switch" icons value={shell.preferences.workView} waiting={boardWaiting} />
          </div>
        )}
        {!board
          && (sidebarColumn
            ? !workbenchPanes(shell).left && (
                <IconButton
                  ref={sidebarToggle}
                  label={sidebarCollapsed ? SHELL_COPY.expandSidebar : SHELL_COPY.collapseSidebar}
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
                  label={SHELL_COPY.openSessions}
                  icon={PanelLeftGlyph}
                  aria-controls="session-navigation"
                  aria-expanded={drawer.open}
                  onClick={() => {
                    drawer.show()
                  }}
                />
              ))}
        {shut && (
          <>
            {placed && <SpaceButtons {...spaces} />}
            {placed && shell.space === 'agents' ? (
              <ShellNewAgent shell={shell} compact />
            ) : sessions ? (
              <IconButton
                label={SHELL_COPY.startSession}
                data-space-primary=""
                icon={NewSessionGlyph}
                pressed={route.start === true}
                onClick={startNew}
              />
            ) : (
              <IconButton
                label={SHELL_COPY.backToSession}
                icon={ArrowLeft}
                onClick={() => {
                  goEntry('sessions')
                }}
              />
            )}
            {approvals > 0 && (
              <IconButton
                label={COPY.waiting(approvals)}
                icon={InboxGlyph}
                badge={<Count tone="warn" value={approvals} from={approvalsBefore} />}
                onClick={openApprovals}
              />
            )}
          </>
        )}
      </div>
      {board ? (
        <>
          <div className="titlebar-board-computer">
            <WorkbenchComputer shell={shell} />
          </div>
          <div className="titlebar-views">
            {shell.canBrowseMarketplace && <IconButton label={SHELL_COPY.marketplace} icon={Store} onClick={shell.openMarketplace} />}
            {shell.entries.includes('settings') && (
              <IconButton
                label={SHELL_COPY.settings}
                data-testid="open-settings"
                icon={SettingsGlyph}
                shortcut={shortcutKeys('settings', desktop !== null) ?? undefined}
                onClick={() => shell.goEntry('settings')}
              />
            )}
            {shell.access.scopes.has('view') && <UsageEntry />}
            <ShellUpdateCheck shell={shell} />
          </div>
        </>
      ) : (
        <>
          {(!sessions || route.start) && (
            <header ref={setTitleSlot} className="topbar titlebar-page">
              {shell.marketplace && !shell.marketplaceBackInPage && (
                <IconButton label={SHELL_COPY.back} icon={ChevronLeftGlyph} onClick={shell.dismissMarketplace} />
              )}
              {startContext && (
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
          {/* Shut, the sidebar's foot stands here: 设置, 额度与用量 and 检查更新, left of an open right panel. */}
          {sidebarColumn && sidebarCollapsed && (
            <div className="titlebar-foot">
              {shell.canBrowseMarketplace && (
                <IconButton
                  label={SHELL_COPY.marketplace}
                  icon={Store}
                  aria-current={shell.marketplace ? 'page' : undefined}
                  data-marketplace-nav=""
                  onClick={shell.openMarketplace}
                />
              )}
              {shell.entries.includes('settings') && (
                <IconButton
                  label={SHELL_COPY.settings}
                  data-testid="open-settings"
                  icon={SettingsGlyph}
                  shortcut={shortcutKeys('settings', desktop !== null) ?? undefined}
                  onClick={() => shell.goEntry('settings')}
                />
              )}
              {shell.access.scopes.has('view') && <UsageEntry />}
              <ShellUpdateCheck shell={shell} />
            </div>
          )}
          <div className="titlebar-views">
            {draftSummary}
            <WorkbenchPanes shell={shell} />
          </div>
        </>
      )}
    </div>
  )
}
