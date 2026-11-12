import type { ComputerSummary } from '@latch/protocol'
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
  /** Version 2 also accepts a real workspace context and an authorized handle. */
  protocolVersion?: 2
  inspect: (sessionId: string, path: string) => Promise<FileInspection>
  /** Up to 64 references at once (inline code, a tool's targets); shells from before it do not have it. */
  known?: (sessionId: string, paths: string[]) => Promise<FileKnownResult>
  reveal: (context: string | { workspaceId: string; harnessId: string }, target: string | { handle: string }) => Promise<FileActionResult>
  quickLook: (
    context: string | { workspaceId: string; harnessId: string },
    target: string | { handle: string },
  ) => Promise<FileActionResult>
  open: (context: string | { workspaceId: string; harnessId: string }, target: string | { handle: string }) => Promise<FileActionResult>
}

export interface NotificationPreferences {
  completion: boolean
  approval: boolean
  title: boolean
  supported: boolean
  consent?: 'unasked' | 'accepted' | 'declined'
}

/**
 * The desktop app's own updates as main's updater sees them (apps/desktop/src/updater.cjs). The page never gets a
 * download address or a file path.
 */
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'waiting'
  | 'installing'
  | 'failed'
  | 'unsupported'

export interface UpdateView {
  state: UpdateState
  /** This app's version, which may differ from the Host's. */
  appVersion: string
  autoDownload: boolean
  /** 下次退出时安装 was chosen. */
  installAtQuit: boolean
  /** Why this build cannot update itself (`unsupported`). */
  reason?: 'development' | 'not-configured' | 'unsigned' | 'platform'
  checkedAt?: string
  release?: {
    version: string
    publishedAt: string
    notes: { 'zh-CN': string; en: string }
    size: number
    /** `app`: only the app restarts; `host`: this Mac's Host changes too, after its sessions settle. */
    plan: 'app' | 'host'
    /** Plugins on now that the new version will turn off on its first start (assets kept). */
    incompatiblePlugins: Array<{ id: string; name: string }>
  }
  progress?: { received: number; total: number }
  /** Sessions the install waits for: running, waiting for an approval, or with a write whose result is unknown. */
  /**
   * What the install waits for: sessions running, waiting for an approval or with a write whose result is unknown, queued
   * messages and terminals running a command. Local services end with their terminals; they are listed, not waited for.
   */
  waiting?: { count: number; running: number; waiting: number; unknown: number; queued: number; terminals: number; services: number }
  failure?: { stage: 'check' | 'download' | 'verify' | 'install' | 'gate'; code: string }
  /** Plugins an earlier update turned off because the new version could not load them. */
  heldPlugins: Array<{ id: string; name: string }>
}

export interface ShellUpdates {
  get(): Promise<UpdateView | undefined>
  check(): Promise<UpdateView | undefined>
  download(): Promise<UpdateView | undefined>
  install(when?: 'now' | 'at-quit'): Promise<UpdateView | undefined>
  cancelWaiting(): Promise<UpdateView | undefined>
  setAutoDownload(enabled: boolean): Promise<UpdateView | undefined>
  /** Main pushes each change; returns the function that stops listening. */
  onChange(callback: (view: UpdateView) => void): () => void
  /** 「检查更新…」 in the app menu: show Settings › 关于. */
  onShow(callback: () => void): () => void
}

export type { ComputerState } from '@latch/protocol'
/** A computer as the desktop app's pages see it (`ComputerSummary` in @latch/protocol). */
export type ComputerView = ComputerSummary

export interface ComputersView {
  computers: ComputerView[]
  /** Only on this Mac's own page: an addition in progress, and the code to compare once it waits on the other computer. */
  adding?: { stage: 'checking' | 'waiting'; origin: string; fingerprint?: string } | null
  /** Only on this Mac's own page: another computer's credentials could not be opened, so the list is read-only. */
  problem?: 'credentials'
}

export type ComputerResult = { ok: true; hostId?: string; revokedThere?: boolean } | { ok: false; error: string; message: string }

/**
 * The computers this desktop app reaches (apps/desktop/src/computers.cjs). Every page may list and open them; only this
 * Mac's own page adds (main reads the link from the clipboard or a code file, never the page) and removes.
 */
export interface ShellComputers {
  list(): Promise<ComputersView | undefined>
  subscribe(callback: (view: ComputersView) => void): () => void
  /** On this Mac's page `taskId` opens a session that waits on that computer (an item of its `waiting`). */
  open(hostId: string, taskId?: string): Promise<ComputerResult>
  /** Another computer's page: a session of its own Host that main was asked to open. */
  subscribeSession?(callback: (sessionId: string) => void): () => void
  add?(source: 'clipboard' | 'file'): Promise<ComputerResult>
  cancelAdd?(): Promise<ComputerResult>
  trustCertificate?(hostId: string): Promise<ComputerResult>
  remove?(hostId: string): Promise<ComputerResult>
}

/** What the Electron preload exposes; nothing else crosses into the renderer. */
export interface LatchShell {
  /**
   * Another computer's page in the desktop app: none of this Mac's folders, files, preview browser, lifecycle or
   * updates, only `computers`.
   */
  remote?: true
  /** Shells from before several computers do not have it. */
  computers?: ShellComputers
  /** Opaque HTML frames with main-process network and WebRTC restrictions. */
  previews?: { protocolVersion: 1; htmlScripts: true }
  notifications?: {
    get(): Promise<NotificationPreferences | undefined>
    set(value: Pick<NotificationPreferences, 'completion' | 'approval' | 'title'>): Promise<NotificationPreferences | undefined>
    subscribeState?(callback: (state: NotificationPreferences) => void): () => void
    subscribe(callback: (sessionId: string) => void): () => void
  }
  kind: 'electron'
  devMode: boolean
  platform: string
  /** Shells from before folder support do not have it. */
  folders?: ShellFolders
  /**
   * 「在浏览器中打开」: main makes a one-time invitation and opens the browser with it; the page never sees
   * the invitation. Absent in shells from before this action.
   */
  openInBrowser?: () => Promise<OpenInBrowserResult>
  /**
   * 「复制链接」 for another computer: main makes a one-time link on the HTTPS entry and puts it on the clipboard, which
   * main clears after 10 minutes if it still holds it; the page never sees the link. Refusals include
   * `tls-not-configured`. Absent in shells from before this action.
   */
  copyComputerLink?: () => Promise<OpenInBrowserResult>
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
  /** Shells from before updates do not have it. */
  updates?: ShellUpdates
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

/** The shell's computers, when it has them. */
export function shellComputers(): ShellComputers | null {
  const computers = currentShell()?.computers
  return computers && typeof computers.list === 'function' && typeof computers.subscribe === 'function' ? computers : null
}

/**
 * Where the desktop app serves this page's fixed frames: `latch-frame://preview/` and `latch-frame://app/` for this
 * Mac's page, `latch-frame://h-<hostId>/preview/` and `…/app/` for another computer's (each reaches only its own Host).
 */
export function shellFrameUrl(kind: 'preview' | 'app', file: string): string {
  const home = typeof location === 'undefined' ? 'app' : location.hostname
  return /^h-[a-z2-7]{52}$/u.test(home) ? `latch-frame://${home}/${kind}/${file}` : `latch-frame://${kind}/${file}`
}

/** What showing a folder is called on this computer's system. */
export function revealLabel(platform: string | undefined): string {
  if (platform === 'darwin') return '在访达中显示'
  if (platform === 'win32') return '在资源管理器中显示'
  return '在文件管理器中显示'
}
