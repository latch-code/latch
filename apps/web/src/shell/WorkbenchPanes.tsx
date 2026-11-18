import { IconButton, PanelLeftGlyph, PanelRightGlyph, TerminalGlyph } from '@latch/ui'
import { currentShell } from '../core/shell.ts'
import type { ShellState } from './useShellLayout.tsx'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    panes: '工作台面板',
    expandSidebar: '展开侧栏',
    collapseSidebar: '收起侧栏',
    terminal: '终端',
    sidePanel: '侧边面板',
  },
  {
    panes: 'Workbench panes',
    expandSidebar: 'Expand sidebar',
    collapseSidebar: 'Collapse sidebar',
    terminal: 'Terminal',
    sidePanel: 'Side panel',
  },
)

export function workbenchPanes(shell: ShellState) {
  // 看板 has no session list, panel or terminal of its own.
  const code = shell.route.entry === 'sessions' && !shell.board
  const left = code && shell.sidebarColumn
  const right = code && !shell.phone && (shell.route.start ? shell.homeInspector : Boolean(shell.summary || shell.canBrowseFiles))
  return { left, terminal: shell.canTerminal, right }
}

export function WorkbenchPanes({ shell }: { shell: ShellState }) {
  const panes = workbenchPanes(shell)
  if (!panes.left && !panes.terminal && !panes.right) return null
  const desktop = currentShell() !== null
  const panelOpen = (shell.columnOpen && !shell.profileColumn) || (shell.pageMode && shell.infoPage && !shell.route.start)
  return (
    <div className="workbench-pane-controls" role="group" aria-label={COPY.panes}>
      {panes.left && (
        <IconButton
          ref={shell.sidebarToggle}
          label={shell.sidebarCollapsed ? COPY.expandSidebar : COPY.collapseSidebar}
          icon={PanelLeftGlyph}
          shortcut={desktop ? '⌘B' : 'Alt B'}
          aria-controls="session-navigation"
          aria-expanded={!shell.sidebarCollapsed}
          onClick={() => shell.setSidebarShut(!shell.sidebarCollapsed)}
        />
      )}
      {panes.terminal && (
        <IconButton
          ref={shell.terminalToggle}
          label={COPY.terminal}
          icon={TerminalGlyph}
          shortcut={desktop ? '⌘J' : 'Alt J'}
          pressed={shell.terminalInPanel ? shell.panelVisible && shell.panelSelected === 'terminal' : shell.terminalOpen}
          {...(shell.terminalInPanel ? {} : { 'aria-controls': 'terminal-dock' })}
          onClick={shell.toggleTerminal}
        />
      )}
      {panes.right && (
        <IconButton
          ref={shell.panelToggle}
          label={COPY.sidePanel}
          icon={PanelRightGlyph}
          shortcut={desktop ? '⌥⌘B' : 'Alt Shift B'}
          pressed={panelOpen}
          onClick={event => shell.togglePanel(event.detail === 0)}
        />
      )}
    </div>
  )
}
