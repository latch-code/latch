import { SHELL_COPY } from './copy.ts'
import { useShortcutBindings } from '../core/shortcutBindings.ts'
import { ArrowLeft, Store } from 'lucide-react'
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
 * The 52px row spanning the window. Its left zone holds the traffic lights' inset and ◧, with 新建会话 once the panel is
 * shut; its end is kept free for the shell's 对话 | 看板 switch; the rest of the row is the conversation's header, or the
 * title of a page. From 1280 an open right panel's strip shares the row: the panel's column starts at the window's top
 * and its strip keeps this end clear. Over 看板 it holds the computer and the sidebar foot's 设置, 额度与用量 and
 * 检查更新. On the desktop app the row moves the window, except over its controls.
 */
export function TitleBar({ shell }: { shell: ShellState }) {
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
  // What the shut panel would otherwise offer stays one click away here.
  const shut = sidebarColumn ? sidebarCollapsed : drawerMode && sessions
  // With two places, the shut lead holds the way between them, and the place's own primary.
  const placed = spaces !== undefined && (sessions || route.entry === 'agents')
  const startContext = sessions && route.start && !shell.board
  const project = startContext && shell.catalog?.workspaces.find(item => item.id !== 'default' && item.id === shell.choice.workspaceId)
  if (shell.board) return <BoardTitleBar shell={shell} />
  return (
    <div
      ref={titlebar}
      className="titlebar"
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
        <WorkbenchPanes shell={shell} />
        {/* The 对话 | 看板 switch is the shell's, drawn over this reserved end in both views. */}
        <span className="view-switch-space" aria-hidden="true" />
      </div>
    </div>
  )
}

/**
 * The title row over 看板: the traffic lights' inset, the computer, then the sidebar foot's 设置, 额度与用量 and 检查更新
 * as the same icons, before the shell's switch. 看板 has no session list or panels to toggle.
 */
function BoardTitleBar({ shell }: { shell: ShellState }) {
  const desktop = currentShell()
  const lights = useTrafficLights()
  return (
    <div ref={shell.titlebar} className="titlebar" data-board="" data-lights={lights ? '' : undefined} style={lightsStyle(desktop)}>
      <div className="titlebar-lead">
        <span className="titlebar-wordmark">
          <BrandMark size={20} />
          Latch
        </span>
      </div>
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
        <span className="view-switch-space" aria-hidden="true" />
      </div>
    </div>
  )
}
