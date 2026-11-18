import { ResizeHandle } from '@latch/ui'
import { TerminalPanel } from '../panel/terminal/TerminalPanel.tsx'
import { paneStorageKey } from '../panel/terminal/panes.ts'
import { DOCK_MIN } from './panelLayout.ts'
import type { ShellState } from './useShellLayout.tsx'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    terminal: '底部终端',
    height: '调整终端高度',
  },
  {
    terminal: 'Terminal dock',
    height: 'Resize terminal height',
  },
)

/**
 * The target's terminals, in the dock or in a tab of the right panel: one component in one place at a time, so the
 * streams, the pane keys and the commands to fill in have a single home.
 */
export function SessionTerminal({ shell, shown, place }: { shell: ShellState; shown: boolean; place: 'dock' | 'panel' }) {
  const {
    terminalTarget,
    terminalKey,
    terminalUnavailable,
    terminalLocation,
    terminalRequested,
    gate,
    submission,
    sessionBlock,
    settings,
    composerRef,
    canBrowser,
    browserShell,
    openInBrowser,
  } = shell
  if (!terminalTarget) return null
  const session = terminalTarget.sessionId !== undefined
  const canCompose = session && !settings && gate.kind === 'open' && !submission.pending && !submission.sending && !sessionBlock
  const compose = (text: string) => {
    submission.setDraft(previous => (previous.trim() ? `${previous}\n\n${text}` : text))
    if (shell.pageMode) shell.setInfoPage(false)
    composerRef.current?.focus()
  }
  return (
    <TerminalPanel
      key={terminalKey}
      target={terminalTarget}
      shown={shown}
      requested={terminalRequested}
      openWhenShown
      onCollapse={place === 'dock' ? shell.closeTerminal : () => shell.closePanelTabKey('terminal')}
      {...(terminalUnavailable ? { unavailable: terminalUnavailable } : {})}
      {...(terminalLocation ? { location: terminalLocation } : {})}
      onCompose={canCompose ? compose : undefined}
      onOpenService={session && canBrowser && browserShell ? openInBrowser : undefined}
      fillPlace={terminalTarget.sessionId}
      onFillReveal={shell.revealTerminal}
      layoutKey={terminalKey && paneStorageKey(shell.snapshot.device.id, terminalKey)}
      paneKeys={shell.terminalKeys}
      {...(shell.panelTerminal
        ? {
            move: {
              to: place === 'dock' ? ('panel' as const) : ('dock' as const),
              onSelect: () => shell.moveTerminal(place === 'dock' ? 'panel' : 'dock'),
            },
          }
        : {})}
      {...(place === 'panel' ? { request: shell.terminalRequest } : {})}
    />
  )
}

export function TerminalDock({ shell }: { shell: ShellState }) {
  const { terminalTarget, terminalOpen, terminalDock, resizeTerminal, resetTerminal, dockHeight, dockLimit } = shell
  if (!terminalTarget || shell.terminalInPanel) return null
  return (
    <aside
      ref={terminalDock}
      id="terminal-dock"
      className="terminal-dock"
      aria-label={COPY.terminal}
      hidden={!terminalOpen || shell.board}
      inert={shell.board || undefined}>
      {terminalOpen && dockLimit >= DOCK_MIN && (
        <ResizeHandle
          className="terminal-resize"
          label={COPY.height}
          orientation="horizontal"
          edge="start"
          value={dockHeight}
          min={DOCK_MIN}
          max={dockLimit}
          onResize={resizeTerminal}
          onReset={resetTerminal}
        />
      )}
      {/* Under 看板 the terminal is kept as when the dock is shut: its processes and screen stay. */}
      <SessionTerminal shell={shell} shown={terminalOpen && !shell.board} place="dock" />
    </aside>
  )
}
