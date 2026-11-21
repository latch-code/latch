import { useEffect, useState } from 'react'
import type { ComputerSummary } from '@latch/protocol'
import { defineCopy } from './i18n.ts'

const COPY = defineCopy(
  {
    finder: '在访达中显示',
    explorer: '在资源管理器中显示',
    fileManager: '在文件管理器中显示',
  },
  {
    finder: 'Show in Finder',
    explorer: 'Show in File Explorer',
    fileManager: 'Show in file manager',
  },
)

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
  revealAgentHome?: (agentId: string) => Promise<RevealResult>
  saveSessionFolder?: (sessionId: string) => Promise<FolderResult>
  /** 克隆: main asks where with the native panel; the clone then goes on in the Host (`/workspaces/clone/:id`). */
  clone?: (url: string) => Promise<CloneStart>
  /** 设置 › 数据: Finder shows the Host's data directory; main reads its path from the Host. */
  revealData?: () => Promise<RevealResult>
  /** 导出全部: main asks where with the native panel; the export then goes on in the Host (`/data/export/:id`). */
  exportData?: () => Promise<ExportStart>
  /**
   * 导出后删除: main asks where with the native panel; the Host writes the archive, then deletes the Agent (or the
   * leftover folder) and its home (`/custom-agents/folder-exports/:requestId`).
   */
  exportAgentFolder?: (target: { agentId: string; requestId: string } | { folder: string; requestId: string }) => Promise<AgentFolderStart>
}

/** What asking main to export an Agent's folder came to. */
export type AgentFolderStart = { status: 'exporting' } | { status: 'canceled' } | { status: 'busy' } | { status: 'failed'; code: string }

/** What asking main to export came to: the export under way, or why it did not start. */
type ExportStart =
  | { status: 'exporting'; id: string; name: string }
  | { status: 'canceled' }
  | { status: 'busy' }
  | { status: 'failed'; code: string }

/** What asking main to clone came to: the clone under way, or why it did not start. */
type CloneStart =
  | { status: 'cloning'; id: string; name: string }
  | { status: 'canceled' }
  | { status: 'busy' }
  | { status: 'failed'; code: string; refused?: Array<{ path: string; status: number; code: string; message?: string }> }

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
    /** `schedule`: an Agent's 「到点前后保持唤醒」 near one of its scheduled times. */
    cause: 'running' | 'waiting' | 'schedule' | null
    power: 'ac' | 'battery'
    batteryLimitReached: boolean
    /** Absent from older shells. */
    scheduleLimitReached?: boolean
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

export interface ShellCli {
  status: 'unavailable' | 'unlinked' | 'linked' | 'occupied'
  path: string
  target: string
  inPath: boolean
  error?: string
}

/** What the desktop app may do with a file a message refers to, as the Host and this computer decided. */
export type FileInspection =
  | {
      status: 'ok'
      name: string
      /** `editor`: shells from before 在编辑器中打开 leave it out. */
      actions: { reveal: boolean; quickLook: boolean; open: boolean; editor?: boolean }
      /** Why an action is not offered: an error code (`file-secret`, `file-type-refused`, `unsupported`…). */
      refused?: { quickLook?: string; open?: string; editor?: string }
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
  /**
   * 在编辑器中打开 in the editor chosen in 设置 (`ShellEditors`), at `line` when known. Main starts it only right after a
   * real click or key on this page; shells from before it do not have it.
   */
  editor?: (
    context: string | { workspaceId: string; harnessId: string },
    target: string | { handle: string },
    line?: number,
  ) => Promise<FileActionResult>
}

/** The code editors main found on this Mac (a fixed list of bundle IDs) and the one the person chose. */
export type EditorList = { status: 'ok'; editors: { id: string; name: string }[]; chosen: string | null }

export interface ShellEditors {
  protocolVersion: 1
  list(): Promise<EditorList | { status: 'failed' | 'refused'; code: string }>
  choose(id: string): Promise<EditorList | { status: 'failed' | 'refused'; code: string }>
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
  /** 新会话 on that computer: its own window comes forward on its start screen; nothing typed goes along. */
  start?(hostId: string): Promise<ComputerResult>
  /** Another window asked this page to show its start screen. */
  subscribeStart?(callback: () => void): () => void
  add?(source: 'clipboard' | 'file'): Promise<ComputerResult>
  cancelAdd?(): Promise<ComputerResult>
  trustCertificate?(hostId: string): Promise<ComputerResult>
  remove?(hostId: string): Promise<ComputerResult>
}

/** A tab's viewport: 适应面板 (`fit`) or a preset size, turned when rotated. */
export type BrowserPreset = 'fit' | 'phone-small' | 'phone' | 'phone-large' | 'android' | 'tablet' | 'desktop'
export type BrowserColorScheme = 'system' | 'light' | 'dark'

/** A preview tab as main reports it (apps/desktop/src/browser.cjs). */
export interface BrowserTabState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  zoom: number
  crashed: boolean
  /** The Chromium network error of the last failed main-frame load, negative; null when it did not fail. */
  error: number | null
  viewport: { preset: BrowserPreset; rotated: boolean }
  colorScheme: BrowserColorScheme
  /** Console errors and warnings and failed requests since the page's document started. */
  logs: { errors: number; warnings: number; failed: number }
  /** Who opened it: the person, or the Agent through its browser tools (version 3). */
  opener?: 'agent' | 'person'
  /** An Agent action runs in it (`agent`), or the person took it over (`person`) (version 3). */
  control?: 'agent' | 'person' | null
  /** What the Agent is doing in it, in main's words: 「正在点击「保存」」. */
  activity?: string | null
}

export interface BrowserImage {
  type: 'image/png'
  width: number
  height: number
  data: Uint8Array
}

export interface BrowserRect {
  x: number
  y: number
  width: number
  height: number
}

/** The element 标注 found: what the page presents there, never form values. */
export interface BrowserTarget {
  url: string
  tag: string
  selector: string
  text: string
  rect: BrowserRect
  image: BrowserImage | null
}

export interface BrowserConsoleEntry {
  /** Main's sequence number for the tab's list. */
  id: number
  level: 'info' | 'warning' | 'error' | 'debug'
  text: string
  source: string
  line: number
  time: number
}

/** A request's summary: never its headers or bodies, and its address without the query. */
export interface BrowserNetworkEntry {
  id: number
  method: string
  url: string
  type: string
  status: number | null
  error: string | null
  duration: number | null
  size: number | null
  time: number
}

export type BrowserFailure = { ok: false; error: string; reason?: string }
export type BrowserResult<T extends object = object> = ({ ok: true } & T) | BrowserFailure

export type BrowserEvent =
  | { type: 'state'; tabId: string; state: BrowserTabState }
  | { type: 'notice'; tabId: string; notice: 'permission' | 'download' | 'popup' | 'navigation' | 'certificate'; detail?: string }
  | { type: 'closed'; tabId: string }
  /** A tab opened in the window, from any page or by the Agent (version 3): every page's list stays whole. */
  | { type: 'opened'; tabId: string; projectId: string; sessionId: string; state: BrowserTabState }
  /** The Agent needs this tab in sight (version 3): the panel showing its session selects it. */
  | { type: 'reveal'; tabId: string }
  /** Main hid the tab (the page that placed it went away): it waits to be placed again. */
  | { type: 'hidden'; tabId: string }

/**
 * The 浏览器 tab's tabs, which the desktop app's main process keeps: version 2 ties each to a session, lists them for a
 * page that reloaded, and adds viewports, color schemes, 选取元素 and the console and network lists.
 */
export interface ShellBrowser {
  protocolVersion: number
  open(projectId: string, sessionId: string, url?: string | null): Promise<BrowserResult<{ tabId: string; state: BrowserTabState }>>
  list(): Promise<BrowserResult<{ tabs: Array<{ tabId: string; projectId: string; sessionId: string; state: BrowserTabState }> }>>
  close(tabId: string): Promise<BrowserResult>
  navigate(tabId: string, url: string): Promise<BrowserResult<{ url: string }>>
  back(tabId: string): Promise<BrowserResult>
  forward(tabId: string): Promise<BrowserResult>
  reload(tabId: string): Promise<BrowserResult>
  stop(tabId: string): Promise<BrowserResult>
  setBounds(tabId: string, bounds: BrowserRect | null): Promise<BrowserResult>
  occlude(tabId: string, occluded: boolean): Promise<BrowserResult<{ image: BrowserImage | null }>>
  focus(tabId: string): Promise<BrowserResult>
  capture(tabId: string): Promise<BrowserResult<{ image: BrowserImage }>>
  annotate(tabId: string, point: { x: number; y: number }): Promise<BrowserResult<{ target: BrowserTarget }>>
  hitTest(tabId: string, point: { x: number; y: number }): Promise<BrowserResult<{ target: { tag: string; rect: BrowserRect } }>>
  setViewport(tabId: string, preset: BrowserPreset, rotated: boolean): Promise<BrowserResult>
  setColorScheme(tabId: string, scheme: BrowserColorScheme): Promise<BrowserResult>
  logs(tabId: string): Promise<BrowserResult<{ console: BrowserConsoleEntry[]; network: BrowserNetworkEntry[] }>>
  zoom(tabId: string, direction: 'in' | 'out' | 'reset'): Promise<BrowserResult<{ zoom: number }>>
  devTools(tabId: string): Promise<BrowserResult>
  clearData(projectId: string): Promise<BrowserResult>
  state(tabId: string): Promise<BrowserResult<{ state: BrowserTabState }>>
  subscribe(callback: (event: BrowserEvent) => void): () => void
  /** 接手: the person takes a tab the Agent works in (version 3). */
  takeOver?(tabId: string): Promise<BrowserResult>
  /** 交还给 Agent (version 3). */
  handBack?(tabId: string): Promise<BrowserResult>
  /** Which session's 浏览器 panel this page shows now, null for none (version 3): the Agent works only in a tab in sight. */
  showing?(sessionId: string | null): Promise<BrowserResult>
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
  locale?: { set(preference: import('./i18n.ts').LocalePreference, language: import('./i18n.ts').Locale): void }
  /** macOS: where the window's traffic lights end, in px from its left edge; the top row starts 12px after them. */
  lights?: {
    end: number
    /** Full screen hides the lights; absent on a shell that does not say. */
    fullScreen?(): Promise<boolean>
    onFullScreen?(callback: (fullScreen: boolean) => void): () => void
  }
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
  /**
   * 「打开系统设置」 in the local-network hint: main opens the Local Network settings page and, in the packaged app, a
   * floating guide over it; resolves whether the page opened. Needs a real press a moment before. Absent in shells from
   * before the guide.
   */
  localNetwork?: { openSettings(): Promise<boolean> }
  /** Absent in shells from before the desktop app ran the Host's lifecycle. */
  lifecycle?: {
    get(): Promise<ShellLifecycleResult>
    setLoginItem(enabled: boolean): Promise<ShellLifecycleResult>
    setKeepAwake(enabled: boolean): Promise<ShellLifecycleResult>
    restartHost(): Promise<ShellLifecycleResult>
    /** Main pushes each change; returns the function that stops listening. */
    subscribe(callback: (lifecycle: ShellLifecycle) => void): () => void
  }
  cli?: {
    /** The installed executable path, supplied only to the main window for this Mac. */
    executable?: string
    get(): Promise<ShellCli | undefined>
    install(): Promise<ShellCli | undefined>
  }
  /** Shells from before file actions do not have it. */
  files?: ShellFiles
  /** Shells from before 在编辑器中打开 do not have it; other computers' windows never do. */
  editors?: ShellEditors
  /** 诊断导出: main asks the Host and saves the bundle where the person chooses; absent elsewhere. */
  diagnostics?: {
    export(): Promise<{ status: 'saved' | 'canceled' | 'busy' } | { status: 'failed' | 'refused'; code: string }>
  }
  /** Shells from before updates do not have it. */
  updates?: ShellUpdates
  /** The 浏览器 tab's tabs; version 1 shells (no sessions, no list) are not used. Never on another computer's page. */
  browser?: ShellBrowser
  /** The light or dark scheme and four opaque hex colors for this window's About panel. */
  about?: { setAppearance(appearance: string): void }
  /** 设置… chosen in the menu bar. Shells from before it do not have it. */
  settings?: { onShow(callback: () => void): () => void }
  /** Code or 我的 Agent chosen in the menu bar. Shells from before the two places do not have it. */
  spaces?: {
    onShow(callback: (space: 'code' | 'agents') => void): () => void
    /** The menu bar's keys for Code and 我的 Agent in this window; main checks them again. Absent in older desktop apps. */
    setKeys?(keys: { code: string | null; agents: string | null; pastePlainTextConflict?: boolean }): void
  }
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

/** The shell's editors with the file action that uses them, or null (a browser, another computer's window, an older shell). */
export function shellEditors(): (ShellEditors & { open: NonNullable<ShellFiles['editor']> }) | null {
  const shell = currentShell()
  const editors = shell?.editors
  const files = shellFiles()
  if (shell?.remote || !editors || editors.protocolVersion !== 1 || typeof files?.editor !== 'function') return null
  return typeof editors.list === 'function' && typeof editors.choose === 'function' ? { ...editors, open: files.editor } : null
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
  if (platform === 'darwin') return COPY.finder
  if (platform === 'win32') return COPY.explorer
  return COPY.fileManager
}

/** The preview browser, only from a shell that ties tabs to sessions and lists them again (version 2 and later). */
export function shellBrowser(): ShellBrowser | null {
  const shell = currentShell()
  const browser = shell?.browser
  if (!shell || shell.remote || !browser || typeof browser.protocolVersion !== 'number' || browser.protocolVersion < 2) return null
  return typeof browser.list === 'function' && typeof browser.open === 'function' && typeof browser.subscribe === 'function'
    ? browser
    : null
}

/**
 * Whether the window's traffic lights float over the top row: the desktop app on a Mac, out of full screen. The row
 * keeps their place free while they do, and starts at the window's edge while they are hidden.
 */
export function useTrafficLights(): boolean {
  const shell = currentShell()
  const mac = shell?.platform === 'darwin'
  const [fullScreen, setFullScreen] = useState(false)
  useEffect(() => {
    const lights = mac ? shell?.lights : undefined
    if (!lights?.onFullScreen) return
    let live = true
    const read = () => {
      void lights
        .fullScreen?.()
        .then(value => {
          if (live) setFullScreen(value === true)
        })
        .catch(() => {})
    }
    read()
    const stop = lights.onFullScreen(value => setFullScreen(value === true))
    // Entering or leaving full screen resizes the window: main is asked again, in case its own word did not arrive.
    addEventListener('resize', read)
    return () => {
      live = false
      stop()
      removeEventListener('resize', read)
    }
  }, [mac, shell])
  return mac && !fullScreen
}

/** The traffic lights' end as a style for the top row, or nothing where the window has none (or an older shell). */
export function lightsStyle(shell: LatchShell | null | undefined): { '--lights-end'?: string } {
  const end = shell?.platform === 'darwin' ? shell.lights?.end : undefined
  return typeof end === 'number' && Number.isFinite(end) && end >= 40 && end <= 120 ? { '--lights-end': `${end}px` } : {}
}
