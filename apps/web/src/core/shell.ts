/** What adding folders as projects through the desktop shell came to. */
export type FolderResult =
  | {
      status: 'added'
      added: Array<{ workspaceId: string; path: string }>
      /** Paths the Host did not add, with its answer's status, error code and words (0: the Host was not reached). */
      refused: Array<{ path: string; status: number; code: string; message?: string }>
    }
  | { status: 'canceled' }
  /** Another native dialog is open. */
  | { status: 'busy' }
  | { status: 'failed'; code: string }

type RevealResult = { status: 'shown' } | { status: 'busy' } | { status: 'failed'; code: string }

/**
 * The system file manager, through the desktop shell's main process: the native open panel, folders dropped from
 * Finder (main asks for a native confirmation first) and showing a project's folder in Finder. The page never sends a
 * path for these.
 */
export interface ShellFolders {
  /** Signed multi-folder requests; absent from shells that post the old unsigned path body. */
  protocolVersion?: 1
  pick: () => Promise<FolderResult>
  drop: (files: readonly File[]) => Promise<FolderResult>
  reveal: (workspaceId: string) => Promise<RevealResult>
}

/** What the Electron preload exposes; nothing else crosses into the renderer. */
export interface LatchShell {
  kind: 'electron'
  devMode: boolean
  platform: string
  /** Shells from before folder support do not have it. */
  folders?: ShellFolders
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

/** The shell's folder actions, only when every one of them is there (an older shell has none). */
export function shellFolders(): ShellFolders | null {
  const folders = currentShell()?.folders
  if (!folders || folders.protocolVersion !== 1) return null
  return typeof folders.pick === 'function' && typeof folders.drop === 'function' && typeof folders.reveal === 'function' ? folders : null
}

/** What showing a folder is called on this computer's system. */
export function revealLabel(platform: string | undefined): string {
  if (platform === 'darwin') return '在访达中显示'
  if (platform === 'win32') return '在资源管理器中显示'
  return '在文件管理器中显示'
}
