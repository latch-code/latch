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
  pick: (workspaceId?: string, replaceFolderId?: string) => Promise<FolderResult>
  drop: { (files: readonly File[]): Promise<FolderResult>; (workspaceId: string, files: readonly File[]): Promise<FolderResult> }
  reveal: (workspaceId: string, folderId?: string) => Promise<RevealResult>
  saveSessionFolder?: (sessionId: string) => Promise<FolderResult>
}

export type ShellConfirmationResult = { status: 'confirmed' | 'cancelled' | 'busy' } | { status: 'failed'; code: string }

export interface ShellConfirmations {
  protocolVersion: 1
  /** Main reads all displayed content from the Host and returns no proof to the page. */
  confirm(id: string): Promise<ShellConfirmationResult>
}

/** What main answers when asked to open this Host's page in the default browser. */
type OpenInBrowserResult = { ok: true } | { ok: false; status: number; error: string; message: string; retryAfter?: number }

/** The Host's life on this Mac as the desktop app's main process runs it (apps/desktop/src/lifecycle.cjs). */
export interface ShellLifecycle {
  /** 「让 Latch 在后台运行」: the macOS login item, which only a packaged Latch.app can register. */
  loginItem: { available: boolean; enabled: boolean; needsApproval: boolean; reason?: 'development' | 'platform' }
  /** Idle sleep held off while the Host has work; the display may still sleep. */
  keepAwake: {
    enabled: boolean
    active: boolean
    cause: 'running' | 'waiting' | null
    power: 'ac' | 'battery'
    batteryLimitReached: boolean
  }
  /** Whether main starts the Host again after a crash, and where that stands. */
  host: {
    /** `unresponsive`: the process is alive but has not answered over host.sock three checks in a row. */
    status: 'running' | 'unresponsive' | 'starting' | 'restarting' | 'stopped' | 'crashed' | 'crash-loop'
    supervised: boolean
    reason?: 'external' | 'environment'
    restartInMs?: number
    crashes: number
  }
}

export type ShellLifecycleResult = { ok: true; lifecycle: ShellLifecycle } | { ok: false; error: string; message: string }

/** What the desktop app may do with a file a message refers to, as the Host and this computer decided. */
export type FileInspection =
  | {
      status: 'ok'
      name: string
      actions: { reveal: boolean; quickLook: boolean; open: boolean }
      /** Why an action is not offered: an error code (`file-secret`, `file-type-refused`, `unsupported`…). */
      refused?: { quickLook?: string; open?: string }
    }
  /** Not a file the Host will act on: `file-missing`, `file-outside-folders`, `file-protected`… */
  | { status: 'refused'; code: string }
  | { status: 'busy' }
  | { status: 'failed'; code: string }

export type FileActionResult =
  | { status: 'shown' }
  | { status: 'opened' }
  | { status: 'refused'; code: string }
  | { status: 'busy' }
  | { status: 'failed'; code: string }

/** Which of a batch of references are files the Host would act on, as the references the page sent. */
export type FileKnownResult = { status: 'ok'; known: string[] } | { status: 'busy' } | { status: 'refused' | 'failed'; code: string }

/**
 * A file a message refers to, in the system's own tools, through the desktop shell's main process: main asks the
 * Host, which checks the file and records the action, and only then shows it in Finder, previews it with Quick Look
 * or opens it with its default application. The page sends the session and the reference as the message wrote it.
 */
export interface ShellFiles {
  inspect: (sessionId: string, path: string) => Promise<FileInspection>
  /** Up to 64 references at once (inline code, a tool's targets); shells from before it do not have it. */
  known?: (sessionId: string, paths: string[]) => Promise<FileKnownResult>
  reveal: (sessionId: string, path: string) => Promise<FileActionResult>
  quickLook: (sessionId: string, path: string) => Promise<FileActionResult>
  open: (sessionId: string, path: string) => Promise<FileActionResult>
}

export interface NotificationPreferences {
  completion: boolean
  approval: boolean
  title: boolean
  supported: boolean
  needsConsent: boolean
}

/** What the Electron preload exposes; nothing else crosses into the renderer. */
export interface LatchShell {
  notifications?: {
    get(): Promise<NotificationPreferences | undefined>
    set(value: Pick<NotificationPreferences, 'completion' | 'approval' | 'title'>): Promise<NotificationPreferences | undefined>
    subscribe(callback: (sessionId: string) => void): () => void
  }
  kind: 'electron'
  devMode: boolean
  platform: string
  /** Shells from before folder support do not have it. */
  folders?: ShellFolders
  confirmations?: ShellConfirmations
  /**
   * 「在这台电脑的浏览器中打开」: main makes a one-time invitation and opens the browser with it; the page never sees
   * the invitation. Absent in shells from before this action.
   */
  openInBrowser?: () => Promise<OpenInBrowserResult>
  /** Absent in shells from before the desktop app ran the Host's lifecycle. */
  lifecycle?: {
    get(): Promise<ShellLifecycleResult>
    setLoginItem(enabled: boolean): Promise<ShellLifecycleResult>
    setKeepAwake(enabled: boolean): Promise<ShellLifecycleResult>
    restartHost(): Promise<ShellLifecycleResult>
    /** Main pushes each change; returns the function that stops listening. */
    subscribe(callback: (lifecycle: ShellLifecycle) => void): () => void
  }
  /** Shells from before file actions do not have it. */
  files?: ShellFiles
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

export function shellConfirmations(): ShellConfirmations | null {
  const confirmations = currentShell()?.confirmations
  return confirmations?.protocolVersion === 1 && typeof confirmations.confirm === 'function' ? confirmations : null
}

/** The shell's folder actions, only when every one of them is there (an older shell has none). */
export function shellFolders(): ShellFolders | null {
  const folders = currentShell()?.folders
  if (!folders || folders.protocolVersion !== 1) return null
  return typeof folders.pick === 'function' && typeof folders.drop === 'function' && typeof folders.reveal === 'function' ? folders : null
}

/** The shell's file actions, only when every one of them is there (an older shell has none). */
export function shellFiles(): ShellFiles | null {
  const files = currentShell()?.files
  if (!files) return null
  return typeof files.inspect === 'function'
    && typeof files.reveal === 'function'
    && typeof files.quickLook === 'function'
    && typeof files.open === 'function'
    ? files
    : null
}

/** What showing a folder is called on this computer's system. */
export function revealLabel(platform: string | undefined): string {
  if (platform === 'darwin') return '在访达中显示'
  if (platform === 'win32') return '在资源管理器中显示'
  return '在文件管理器中显示'
}
