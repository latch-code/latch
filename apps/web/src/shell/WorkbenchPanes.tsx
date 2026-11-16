import { IconButton, PanelLeftGlyph, PanelRightGlyph, TerminalGlyph } from '@latch/ui'
import { currentShell } from '../core/shell.ts'
import type { ShellState } from './useShellLayout.tsx'

export function workbenchPanes(shell: ShellState) {
  const code = shell.route.entry === 'sessions' && !shell.route.allSessions
  const left = code && shell.sidebarColumn && (!shell.route.overview || shell.preferences.workbenchLayout === 'overview')
  const right = code && !shell.phone && (shell.route.overview ? shell.homeInspector : Boolean(shell.summary || shell.canBrowseFiles))
  return { left, terminal: shell.canTerminal, right }
}

export function WorkbenchPanes({ shell }: { shell: ShellState }) {
  const panes = workbenchPanes(shell)
  if (!panes.left && !panes.terminal && !panes.right) return null
  const desktop = currentShell() !== null
  const panelOpen = (shell.columnOpen && !shell.profileColumn) || (shell.pageMode && shell.infoPage && !shell.route.overview)
  return (
    <div className="workbench-pane-controls" role="group" aria-label="工作台面板">
      {panes.left && (
        <IconButton
          ref={shell.sidebarToggle}
          label={shell.sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
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
          label="终端"
          icon={TerminalGlyph}
          shortcut={desktop ? '⌘J' : 'Alt J'}
          pressed={shell.terminalOpen}
          aria-controls="terminal-dock"
          onClick={shell.toggleTerminal}
        />
      )}
      {panes.right && (
        <IconButton
          ref={shell.panelToggle}
          label="侧边面板"
          icon={PanelRightGlyph}
          shortcut={desktop ? '⌥⌘B' : 'Alt Shift B'}
          pressed={panelOpen}
          onClick={event => shell.togglePanel(event.detail === 0)}
        />
      )}
    </div>
  )
}
