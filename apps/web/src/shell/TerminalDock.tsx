import { ResizeHandle } from '@latch/ui'
import { TerminalPanel } from '../panel/terminal/TerminalPanel.tsx'
import { DOCK_MIN } from './panelLayout.ts'
import type { ShellState } from './useShellLayout.tsx'

export function TerminalDock({ shell }: { shell: ShellState }) {
  const {
    terminalTarget,
    terminalKey,
    terminalUnavailable,
    terminalLocation,
    terminalOpen,
    terminalRequested,
    terminalDock,
    closeTerminal,
    resizeTerminal,
    resetTerminal,
    dockHeight,
    dockLimit,
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
    <aside
      ref={terminalDock}
      id="terminal-dock"
      className="terminal-dock"
      aria-label="底部终端"
      hidden={!terminalOpen}
      inert={shell.homeFocused || undefined}>
      {terminalOpen && dockLimit >= DOCK_MIN && (
        <ResizeHandle
          className="terminal-resize"
          label="调整终端高度"
          orientation="horizontal"
          edge="start"
          value={dockHeight}
          min={DOCK_MIN}
          max={dockLimit}
          onResize={resizeTerminal}
          onReset={resetTerminal}
        />
      )}
      <TerminalPanel
        key={terminalKey}
        target={terminalTarget}
        shown={terminalOpen}
        requested={terminalRequested}
        {...(terminalUnavailable ? { unavailable: terminalUnavailable } : {})}
        {...(terminalLocation ? { location: terminalLocation } : {})}
        onCollapse={closeTerminal}
        onCompose={canCompose ? compose : undefined}
        onOpenService={session && canBrowser && browserShell ? openInBrowser : undefined}
        fillPlace={terminalTarget.sessionId}
        onFillReveal={shell.revealTerminal}
      />
    </aside>
  )
}
