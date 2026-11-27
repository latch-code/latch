import { memo, useMemo, useState } from 'react'
import { ResizeHandle } from '@latch/ui'
import { TerminalPanel } from '../panel/terminal/TerminalPanel.tsx'
import { useFillAsk } from '../panel/terminal/fills.ts'
import { paneStorageKey } from '../panel/terminal/panes.ts'
import { useStableCallback } from '../hooks/useStableCallback.ts'
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

const MountedTerminal = memo(TerminalPanel)

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
  const session = terminalTarget?.sessionId !== undefined
  const canCompose = session && !settings && gate.kind === 'open' && !submission.pending && !submission.sending && !sessionBlock
  const compose = useStableCallback((text: string) => {
    submission.setDraft(previous => (previous.trim() ? `${previous}\n\n${text}` : text))
    if (shell.pageMode) shell.setInfoPage(false)
    composerRef.current?.focus()
  })
  const collapse = useStableCallback(() => (place === 'dock' ? shell.closeTerminal() : shell.closePanelTabKey('terminal')))
  const reveal = useStableCallback(() => shell.revealTerminal())
  const openService = useStableCallback(openInBrowser)
  const moveTo = place === 'dock' ? 'panel' : 'dock'
  const move = useStableCallback(() => shell.moveTerminal(moveTo))
  const moveAction = useMemo(() => ({ to: moveTo, onSelect: move }) as const, [moveTo, move])
  if (!terminalTarget) return null
  return (
    <MountedTerminal
      key={terminalKey}
      target={terminalTarget}
      shown={shown}
      requested={terminalRequested}
      openWhenShown
      onCollapse={collapse}
      {...(terminalUnavailable ? { unavailable: terminalUnavailable } : {})}
      {...(terminalLocation ? { location: terminalLocation } : {})}
      onCompose={canCompose ? compose : undefined}
      onOpenService={session && canBrowser && browserShell ? openService : undefined}
      fillPlace={terminalTarget.sessionId}
      onFillReveal={reveal}
      layoutKey={terminalKey && paneStorageKey(shell.snapshot.device.id, terminalKey)}
      paneKeys={shell.terminalKeys}
      move={shell.panelTerminal ? moveAction : undefined}
      {...(place === 'panel' ? { request: shell.terminalRequest } : {})}
    />
  )
}

/** The first explicit show or fill mounts a screen. Folding keeps it until this target leaves the dock. */
function DockContents({ shell }: { shell: ShellState }) {
  const shown = shell.terminalOpen && !shell.board
  const ask = useFillAsk(shell.terminalTarget?.sessionId)
  const [opened, setOpened] = useState(false)
  if (!opened) {
    if (!shown && !ask) return null
    setOpened(true)
  }
  return <SessionTerminal shell={shell} shown={shown} place="dock" />
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
      hidden={!terminalOpen || shell.board || shell.marketplace}
      inert={shell.board || shell.marketplace || undefined}>
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
      <DockContents key={shell.terminalKey} shell={shell} />
    </aside>
  )
}
