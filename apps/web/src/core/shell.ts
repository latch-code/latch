/** What the Electron preload exposes; nothing else crosses into the renderer. */
export interface LatchShell {
  kind: 'electron'
  devMode: boolean
  platform: string
}

declare global {
  interface Window {
    latchShell?: LatchShell
  }
}

/** The desktop shell when this page runs inside Latch's Electron window, otherwise null (a browser). */
export function currentShell(): LatchShell | null {
  if (typeof window === 'undefined') return null
  const shell = window.latchShell
  return shell !== undefined && shell !== null && shell.kind === 'electron' ? shell : null
}
