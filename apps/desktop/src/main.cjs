'use strict'
// Latch desktop shell. Started as:
//   electron apps/desktop/src/main.cjs --latch-host-state=<data>/host.json [--latch-user-data=<dir>]
// The renderer loads latch://app/link/; main answers that scheme over the Host's unix socket and
// holds the device key and credential. No environment variable carries a URL or a credential.
const electron = require('electron')

if (typeof electron === 'string' || !electron.app) {
  console.error('[Latch] 桌面端必须由 Electron 启动；检测到 ELECTRON_RUN_AS_NODE，已退出。')
  process.exit(1)
}

const {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  safeStorage,
  session,
  shell,
  autoUpdater,
  WebContentsView,
} = electron
const { constants: fsConstants } = require('node:fs')
const { createHash } = require('node:crypto')
const { lstat, open: openFile, readdir, readFile, realpath, rm, stat } = require('node:fs/promises')
const { hostname } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const { readHostStateFile, inspectHostState, readBody, socketRequest } = require('./host.cjs')
const { openCredentialStore, secureStorageProblem } = require('./credentials.cjs')
// Through the module objects, so the multi-computer end-to-end test's bootstrap can trust its test certificate.
const remotes = require('./remote-proxy.cjs')
const { createComputers, createWindowOpener } = require('./computers.cjs')
const { createFolderActions, isTrustedSender } = require('./folders.cjs')
const {
  createNotifications,
  readPreferences: readNotificationPreferences,
  writePreferences: writeNotificationPreferences,
  handleNotificationRequests,
} = require('./notifications.cjs')
const { createFileActions } = require('./files.cjs')
const { createNetworkSink } = require('./network.cjs')
const { createPreviewBrowser, handleBrowserRequests } = require('./browser.cjs')
// Through the module objects, so the end-to-end test's bootstrap can give the updater a local feed and a fake installer.
const updates = require('./updater.cjs')
const menus = require('./menu.cjs')
const {
  LIFECYCLE_CHANNELS,
  createHostSupervisor,
  createKeepAwake,
  createLoginItem,
  createSystemQuit,
  excludeFromBackup,
  readLaunchRecord,
  readLifecyclePreferences,
  spawnHost,
  writeLaunchRecord,
  writeLifecyclePreferences,
} = require('./lifecycle.cjs')
const {
  HTML_CSP,
  createDialogGate,
  OPEN_IN_BROWSER,
  COPY_COMPUTER_LINK,
  createBrowserOpener,
  createLinkCopier,
  concealedClipboardEntry,
  createExternalGesture,
  createExternalOpener,
  createShellProxy,
  debugFlagProblems,
  htmlErrorPage,
  isAllowedRendererDetails,
  isPreviewFrameUrl,
  isAppFrameUrl,
  isAppSender,
  isAppUrl,
  LOCAL_HOME,
  unexpectedArguments,
} = require('./proxy.cjs')

const APP_URL = 'latch://app/link/'
/** A development run is Electron's own bundle, whose version is Electron's; the desktop package says this app's. */
const DESKTOP_VERSION = '0.1.0'
const log = text => console.error(`[Latch] ${text}`)
/** The Host start script of this checkout: the only script the desktop app starts (see lifecycle.cjs). */
const HOST_SCRIPT = resolve(__dirname, '../../../dist/start.js')
const CHECK_INTERVAL_MS = 5_000

function argument(name) {
  const prefix = `--${name}=`
  const found = process.argv.find(arg => arg.startsWith(prefix))
  return found === undefined ? undefined : found.slice(prefix.length) || undefined
}

const debugFlags = debugFlagProblems([...process.execArgv, ...process.argv], process.env)
if (app.isPackaged) {
  const refused = [...new Set([...debugFlags, ...unexpectedArguments(process.argv.slice(1))])]
  if (refused.length > 0) {
    log(`检测到调试参数或未知参数（${refused.join('、')}），已拒绝启动。`)
    process.exit(1)
  }
} else if (debugFlags.length > 0) {
  // Development runs are driven by test tooling; the Host and shell code are locally modifiable there anyway.
  log(`开发运行：检测到调试参数（${debugFlags.join('、')}）。打包版本会拒绝这些参数。`)
}

app.setName('Latch')
app.setPath('userData', resolve(argument('latch-user-data') ?? join(app.getPath('appData'), 'Latch', 'Desktop')))
const hostStatePath = argument('latch-host-state')

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'latch-frame',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      stream: false,
      corsEnabled: false,
      allowServiceWorkers: false,
      bypassCSP: false,
    },
  },
  {
    scheme: 'latch',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: false,
      allowServiceWorkers: false,
      bypassCSP: false,
    },
  },
])
app.enableSandbox()

// The application icon, the same file the page uses (apps/web/public/icon.png).
const icon = nativeImage.createFromPath(join(__dirname, '../../web/public/icon.png'))
let ready = false

// Below the page's phone breakpoint it drops the title row, and with it what moves the window.
const DESKTOP_MIN_WIDTH = 768

/** @param {{ width?: number, height?: number, preload?: boolean, partition?: string }} [options] */
function createWindow({ width = 1250, height = 850, preload = true, partition } = {}) {
  return new BrowserWindow({
    width,
    height,
    minWidth: Math.min(width, DESKTOP_MIN_WIDTH),
    minHeight: Math.min(height, 560),
    title: 'Latch',
    // The window's own colour (--sidebar in @latch/ui), so the window shows no flash before the first paint.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#09090b' : '#ebebef',
    icon,
    // The page's title row holds the traffic lights in its 78px inset and moves the window. Their centre is the work
    // panel's title row's (8px inset + half of 52px), where the lead's buttons stand too; before the shell the
    // enrollment, connection and crash screens draw a strip of the same height. The local error page, which has neither,
    // keeps the standard bar.
    ...(preload && process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 27 } } : {}),
    webPreferences: {
      ...(preload ? { preload: join(__dirname, 'preload.cjs') } : {}),
      // Another computer's window: its own storage, cache and scheme handlers, shared with nothing else.
      ...(partition ? { partition } : {}),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      safeDialogs: true,
      devTools: !app.isPackaged,
    },
  })
}

/** The window that shows the page; folder and file actions answer only its own top-level page. */
let mainWindow
const refusedFolders = { status: 'failed', code: 'shell-refused' }
const trusted = event => isTrustedSender(event, mainWindow?.webContents)
/**
 * Which computer each window's page belongs to: `app` (this Mac, the default) or `h-<hostId>`. Navigation, frames and
 * the renderer's requests stay inside it.
 */
const homes = new WeakMap()
const homeOf = contents => homes.get(contents) ?? LOCAL_HOME
/** Each page's last native click or key, which main checks before an action only a person may start. */
const gestures = new WeakMap()
/** Other computers' windows by hostId; each in its own partition. */
const remoteWindows = new Map()
const partitionOf = hostId => `persist:latch-host-${hostId}`

function openWindow() {
  mainWindow = createWindow()
  previewBrowser.attach(mainWindow)
  void mainWindow.loadURL(APP_URL)
}

/** Shows a local error page served by the latch scheme (the renderer may load nothing else), then quits on close. */
function fatal(message) {
  log(message)
  if (protocol.isProtocolHandled('latch')) protocol.unhandle('latch')
  protocol.handle(
    'latch',
    () =>
      new Response(htmlErrorPage(message), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': HTML_CSP, 'cache-control': 'no-store' },
      }),
  )
  void createWindow({ width: 560, height: 280, preload: false }).loadURL(APP_URL)
}

async function hardenSession(target, home = LOCAL_HOME) {
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  target.setPermissionCheckHandler(() => false)
  target.setDevicePermissionHandler(() => false)
  // The renderer has no network of its own; every Host connection goes through main, and only to its own computer.
  target.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRendererDetails(details, { packaged: app.isPackaged, home }) })
  })
  const sink = await createNetworkSink()
  app.once('will-quit', () => {
    void sink.close()
  })
  await target.setProxy(sink.proxy)
}

// One native dialog at a time: the external-link confirmation and the folder dialogs share it.
const dialogGate = createDialogGate()
const openExternal = createExternalOpener({
  confirm: (options, parent) => (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)),
  open: url => shell.openExternal(url),
  gate: dialogGate,
  log,
})

/** The 浏览器 tab: untrusted pages in their own partitions and with their own rules, driven by `latchShell.browser`. */
const previewBrowser = createPreviewBrowser({
  WebContentsView,
  fromPartition: partition => session.fromPartition(partition),
  window: () => mainWindow,
  // browser.cjs hands over only an internet address the person clicked in the tab a moment ago.
  openExternal: url => openExternal(url, mainWindow, { userGesture: true }),
  log,
})

app.on('web-contents-created', (_event, contents) => {
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  // A preview tab, or the developer tools opened for one, never gets the app page's rules or network.
  if (previewBrowser.owns(contents)) {
    previewBrowser.guard(contents)
    return
  }
  const gesture = createExternalGesture()
  gestures.set(contents, gesture)
  contents.on('before-mouse-event', (_event, input) => gesture.mouse(input))
  contents.on('before-input-event', (_event, input) => gesture.key(input))
  contents.on('blur', () => gesture.clear())
  contents.on('did-start-navigation', () => gesture.clear())
  contents.setWindowOpenHandler(({ url }) => {
    // Only this Mac's own page opens a clicked link without a confirmation; another computer's page always confirms.
    const userGesture = contents === mainWindow?.webContents && isAppUrl(contents.getURL()) && gesture.take()
    void openExternal(url, BrowserWindow.fromWebContents(contents) ?? undefined, { userGesture })
    return { action: 'deny' }
  })
  const guard = (event, url) => {
    if (!isAppUrl(event.url ?? url, homeOf(contents))) event.preventDefault()
  }
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  contents.on('will-frame-navigate', event => {
    const home = homeOf(contents)
    if (event.isMainFrame) {
      if (!isAppUrl(event.url, home)) event.preventDefault()
    } else if (event.frame && isAppFrameUrl(event.frame.url, home)) {
      // A plugin page frame never navigates, not even to itself or to another fixed bootstrap.
      event.preventDefault()
    } else if (isAppFrameUrl(event.url, home)) {
      // Only the app page itself points a frame at the page runtime.
      if (!event.initiator || event.initiator.parent !== null || !isAppUrl(event.initiator.url, home)) event.preventDefault()
    } else if (!isPreviewFrameUrl(event.url, home)) event.preventDefault()
  })
  contents.on('will-attach-webview', event => event.preventDefault())
})

/** A Host API call of main's own, through the proxy with the shell's credential (never one the page made). */
async function hostRequest(proxy, method, path, body) {
  const response = await proxy.handle(
    new Request(`latch://app${path}`, {
      method,
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { shell: true },
  )
  const json = await response.json().catch(() => undefined)
  return { status: response.status, json }
}

/**
 * `latchShell.folders`: the native open panel, dropped folders after a native confirmation, a session's own folder
 * saved as a project after a native confirmation, and showing a project's folder in Finder. Main adds folders to the
 * Host itself, through `shellRequest` (the renderer's own requests to the add routes get 403 shell-managed) and signed
 * with the device key; the page never sends a path for these. Every call from anything but the main window's own page
 * is refused.
 */
function handleFolders(proxy, store) {
  const actions = createFolderActions({
    request: (method, path, body) => proxy.shellRequest(method, path, body),
    sign: body => store.signFolders(body),
    pick: options => (mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options)),
    confirm: options => (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options)),
    show: path => {
      shell.showItemInFolder(path)
    },
    async inspect(path) {
      const real = await realpath(path)
      return { real, directory: (await stat(real)).isDirectory() }
    },
    home: () => app.getPath('home'),
    focused: () => mainWindow !== undefined && !mainWindow.isDestroyed() && mainWindow.isFocused(),
    gate: dialogGate,
    log,
  })
  ipcMain.handle('latch:folders:pick', (event, input) => (trusted(event) ? actions.pickFolders(input) : refusedFolders))
  ipcMain.handle('latch:folders:drop', (event, input) => (trusted(event) ? actions.dropFolders(input) : refusedFolders))
  ipcMain.handle('latch:folders:reveal', (event, input) => (trusted(event) ? actions.revealFolder(input) : refusedFolders))
  ipcMain.handle('latch:folders:save-session', (event, input) => (trusted(event) ? actions.saveSessionFolder(input) : refusedFolders))
}

/** One request to the Host over host.sock without a credential, as the command line makes it; resolves with the status. */
async function reportToHost(socketPath, body) {
  const payload = Buffer.from(JSON.stringify(body))
  const { response } = await socketRequest(socketPath, {
    method: 'POST',
    path: '/link/api/host/state',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: payload,
    timeoutMs: 2_000,
  })
  await readBody(response, 64 * 1024)
  if (response.statusCode !== 200) throw new Error(`host/state 返回 ${response.statusCode}`)
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/**
 * The supervisor of the Host whose host.json is `statePath`. It may start the Host before the lifecycle runs (the
 * desktop app finding none at startup), so what it reports goes through `hooks`, which startLifecycle fills in.
 */
function hostSupervisor(hostId, statePath, hooks) {
  const dataDir = dirname(statePath)
  return createHostSupervisor({
    hostId,
    async readState() {
      const state = await readHostStateFile(statePath)
      previewBrowser.blockHost(state)
      return state
    },
    inspect: state => inspectHostState(state),
    alive: isAlive,
    readLaunch: () => readLaunchRecord(dataDir, { script: HOST_SCRIPT }),
    writeLaunch: record => writeLaunchRecord(dataDir, record),
    startHost: launch => spawnHost(launch, { dataDir, env: process.env }),
    terminate: pid => process.kill(pid, 'SIGTERM'),
    report: reportToHost,
    log,
    onChange: view => hooks.onChange(view),
    onActivity: activity => hooks.onActivity(activity),
  })
}

/** A quit within 30 seconds of macOS announcing a logout, restart or shutdown: the system's, which nothing holds. */
const systemQuit = createSystemQuit()

/**
 * Starts the Host again after a crash, keeps the Mac awake while it has work, tells it about sleep and shutdown, and
 * answers the page's lifecycle requests (Settings › 通用). On macOS all of this goes on with no window open: the app
 * keeps running until it is quit. Resolves whether macOS opened the app at login.
 */
async function startLifecycle({ supervisor, hooks }) {
  const userData = app.getPath('userData')
  const preferences = await readLifecyclePreferences(userData)
  let started = false
  const lifecycleView = () => ({ loginItem: loginItem.view(), keepAwake: keepAwake.view(), host: supervisor.view() })
  const broadcast = () => {
    if (!started) return
    // This Mac's lifecycle is for this Mac's page alone; another computer's window has no lifecycle.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(LIFECYCLE_CHANNELS.changed, lifecycleView())
  }
  const loginItem = createLoginItem({ app, platform: process.platform, packaged: app.isPackaged })
  const keepAwake = createKeepAwake({
    blocker: powerSaveBlocker,
    onBattery: () => powerMonitor.isOnBatteryPower(),
    enabled: preferences.keepAwake,
    onChange: broadcast,
  })
  hooks.onChange = broadcast
  hooks.onActivity = activity => keepAwake.setActivity(activity)
  started = true

  const refused = { ok: false, error: 'forbidden', message: '只接受 Latch 页面的请求。' }
  ipcMain.handle(LIFECYCLE_CHANNELS.get, event => (isAppSender(event) ? { ok: true, lifecycle: lifecycleView() } : refused))
  ipcMain.handle(LIFECYCLE_CHANNELS.setLoginItem, (event, enabled) => {
    if (!isAppSender(event) || typeof enabled !== 'boolean') return refused
    try {
      loginItem.set(enabled)
    } catch (error) {
      log(`无法更改登录项：${error instanceof Error ? error.message : '未知错误'}`)
      return { ok: false, error: 'login-item-failed', message: '无法更改登录项，请在「系统设置 › 通用 › 登录项」中检查。' }
    }
    broadcast()
    return { ok: true, lifecycle: lifecycleView() }
  })
  ipcMain.handle(LIFECYCLE_CHANNELS.setKeepAwake, async (event, enabled) => {
    if (!isAppSender(event) || typeof enabled !== 'boolean') return refused
    try {
      await writeLifecyclePreferences(userData, { keepAwake: enabled })
    } catch (error) {
      log(`无法保存设置：${error instanceof Error ? error.message : '未知错误'}`)
      return { ok: false, error: 'preferences-failed', message: '无法保存设置，请重试。' }
    }
    keepAwake.setEnabled(enabled)
    return { ok: true, lifecycle: lifecycleView() }
  })
  ipcMain.handle(LIFECYCLE_CHANNELS.restartHost, async event => {
    if (!isAppSender(event)) return refused
    const result = await supervisor.restartNow()
    broadcast()
    return result.ok ? { ok: true, lifecycle: lifecycleView() } : result
  })

  powerMonitor.on('suspend', () => void supervisor.announce({ state: 'sleeping' }))
  powerMonitor.on('resume', () => {
    void supervisor.announce({ state: 'awake' })
    void supervisor.check()
  })
  powerMonitor.on('on-ac', () => keepAwake.powerChanged())
  powerMonitor.on('on-battery', () => keepAwake.powerChanged())
  // A logout, restart or shutdown: the notice records the reason with the Host (it lapses after a minute), and the quit
  // macOS then asks of this app stops the Host while the network is still up (see createSystemQuit).
  powerMonitor.on('shutdown', () => {
    systemQuit.noticed()
    void supervisor.announce({ state: 'stopping', reason: 'shutdown' })
  })
  app.on('before-quit', event => {
    if (!systemQuit.take()) return
    event.preventDefault()
    void supervisor.systemShutdown().finally(() => app.quit())
  })
  app.on('will-quit', () => {
    supervisor.stop()
    keepAwake.stop()
  })
  // The device credentials are encrypted with a key in this Mac's keychain; a backup copy is of no use and stays out.
  void excludeFromBackup([join(userData, 'latch-devices')], { log })
  await supervisor.check()
  setInterval(() => void supervisor.check(), CHECK_INTERVAL_MS)
  return loginItem.openedAtLogin()
}

/**
 * `latchShell.updates` and the menu bar. The updater (updater.cjs) reads one fixed feed, verifies it and the download,
 * and installs through the gate; the page only sees its view. 「检查更新…」 in the app menu checks and shows
 * Settings › 关于.
 */
async function startUpdates({ proxy, supervisor }) {
  const userData = app.getPath('userData')
  const config = updates.configuration()
  const unsupported = updates.unsupportedReason({ packaged: app.isPackaged, platform: process.platform, source: config })
  const appVersion = app.isPackaged ? app.getVersion() : DESKTOP_VERSION
  const broadcast = view => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(updates.UPDATE_CHANNELS.changed, view)
  }
  const source = unsupported
    ? {
        latest: () => Promise.reject(new updates.UpdateError('check', 'unsupported')),
        download: () => Promise.reject(new Error('unsupported')),
      }
    : updates.createFeedSource({
        feedUrl: /** @type {string} */ (config.feedUrl),
        publicKey: /** @type {string} */ (config.publicKey),
        platform: process.platform,
        arch: process.arch,
        cacheDir: join(userData, 'updates'),
      })
  const gate = updates.createHostGate({
    request: (method, path, body) => proxy.shellRequest(method, path, body),
    async activity() {
      const state = hostStatePath ? await readHostStateFile(hostStatePath) : undefined
      const checked = state ? await inspectHostState(state) : undefined
      if (!checked?.ok) return undefined
      const { info } = checked
      const activity = info.activity ?? { running: info.activeSessions ?? 0, waiting: 0 }
      return { running: activity.running, waiting: activity.waiting, version: info.version, protocol: info.protocol }
    },
  })
  const updater = updates.createUpdater({
    appVersion,
    platform: process.platform,
    source,
    installer: updates.createElectronInstaller({
      autoUpdater,
      stopHost: () => supervisor.stopForUpdate(),
      restartHost: () => supervisor.restartNow(),
      serve: file => updates.serveVerifiedFile(file),
    }),
    gate,
    preferences: await updates.readUpdatePreferences(userData),
    savePreferences: value => updates.writeUpdatePreferences(userData, value),
    unsupported,
    log,
    onChange: broadcast,
  })
  const channels = updates.UPDATE_CHANNELS
  const answer = handler => (event, input) => (isAppSender(event) ? handler(input) : undefined)
  ipcMain.handle(
    channels.get,
    answer(() => updater.view()),
  )
  ipcMain.handle(
    channels.check,
    answer(() => updater.check()),
  )
  ipcMain.handle(
    channels.download,
    answer(() => updater.download()),
  )
  ipcMain.handle(
    channels.install,
    answer(when => updater.install(when === 'at-quit' ? 'at-quit' : 'now')),
  )
  ipcMain.handle(
    channels.cancelWaiting,
    answer(() => updater.cancelWaiting()),
  )
  ipcMain.handle(
    channels.setAutoDownload,
    answer(async enabled => {
      if (typeof enabled !== 'boolean') return updater.view()
      try {
        return await updater.setAutoDownload(enabled)
      } catch (error) {
        log(`无法保存更新设置：${error instanceof Error ? error.message : '未知错误'}`)
        return updater.view()
      }
    }),
  )

  const showUpdates = () => {
    void updater.check()
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (!ready) return
      openWindow()
      mainWindow.webContents.once('did-finish-load', () => mainWindow?.webContents.send(channels.show))
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send(channels.show)
  }
  if (process.platform === 'darwin')
    Menu.setApplicationMenu(Menu.buildFromTemplate(menus.menuTemplate({ packaged: app.isPackaged, onCheckForUpdates: showUpdates })))

  // The same gate for a quit the user starts: an install at quit waits for nothing that runs; a waiting install is given
  // up. A quit macOS starts (logout, restart, shutdown) is never held; the update waits for the next time.
  let quitHeld = false
  app.on('before-quit', event => {
    if (quitHeld || systemQuit.active() || !updater.holdsQuit({ system: false })) return
    event.preventDefault()
    quitHeld = true
    void updater.quitting().then(
      tookOver => {
        if (!tookOver) app.quit()
      },
      () => app.quit(),
    )
  })
  powerMonitor.on('resume', () => updater.resume())
  app.on('will-quit', () => updater.stop())
  updater.start()
}

/**
 * `latchShell.files`: a file a message refers to, shown in Finder, previewed with Quick Look or opened with its
 * default application. The page sends the session and the reference; main asks the Host, which checks the file,
 * audits the action and gives main the real path. Every call from anything but the main window's own page is refused.
 */
function handleFiles(proxy) {
  const actions = createFileActions({
    request: (method, path, body) => hostRequest(proxy, method, path, body),
    show: path => {
      shell.showItemInFolder(path)
    },
    quickLook: (path, name) => {
      if (!mainWindow) throw new Error('没有窗口')
      mainWindow.previewFile(path, name)
    },
    open: path => shell.openPath(path),
    async inspect(path) {
      const info = await lstat(path)
      return { real: await realpath(path), file: info.isFile(), symlink: info.isSymbolicLink() }
    },
    async readHead(path, bytes) {
      const handle = await openFile(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | fsConstants.O_NONBLOCK)
      try {
        const buffer = Buffer.alloc(bytes)
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
        return new Uint8Array(buffer.subarray(0, bytesRead))
      } finally {
        await handle.close()
      }
    },
    platform: process.platform,
    log,
  })
  ipcMain.handle('latch:files:inspect', (event, input) => (trusted(event) ? actions.inspectFile(input) : refusedFolders))
  ipcMain.handle('latch:files:known', (event, input) => (trusted(event) ? actions.knownFiles(input) : refusedFolders))
  ipcMain.handle('latch:files:reveal', (event, input) => (trusted(event) ? actions.revealFile(input) : refusedFolders))
  ipcMain.handle('latch:files:quicklook', (event, input) => (trusted(event) ? actions.quickLookFile(input) : refusedFolders))
  ipcMain.handle('latch:files:open', (event, input) => (trusted(event) ? actions.openFile(input) : refusedFolders))
}

/** This Mac's name as other computers list this app: `<name> 上的 Latch`, one plain line. */
function deviceNameHere() {
  const name = hostname()
    .replace(/\.local$/u, '')
    .replace(/[^\p{L}\p{N} ._-]/gu, '')
    .trim()
    .slice(0, 40)
  return name ? `${name} 上的 Latch` : 'Mac 上的 Latch'
}

const COMPUTER_CHANNELS = Object.freeze({
  list: 'latch:computers:list',
  open: 'latch:computers:open',
  add: 'latch:computers:add',
  cancelAdd: 'latch:computers:cancel-add',
  trustCertificate: 'latch:computers:trust-certificate',
  remove: 'latch:computers:remove',
  changed: 'latch:computers:changed',
})
const CODE_FILE_LIMIT = 4096

/**
 * Other computers (computers.cjs, remote-proxy.cjs): their windows, each in a partition of its own whose `latch:` and
 * `latch-frame:` schemes reach only that computer's Host, and `latchShell.computers`. This Mac's page may list, open,
 * add and remove; another computer's page may only list and open. Adding and removing need a native click or key on
 * this Mac's page a moment before; main alone reads the link from the clipboard or a code file.
 */
async function startComputers({ localHostId, localState }) {
  const userData = app.getPath('userData')
  /** Each partition is hardened and given its handlers once, however many opens race for it. */
  const prepared = new Map()
  /** @type {ReturnType<typeof createComputers>} */
  let computers

  function prepareSession(hostId) {
    let pending = prepared.get(hostId)
    if (!pending) {
      const target = session.fromPartition(partitionOf(hostId))
      pending = (async () => {
        await hardenSession(target, `h-${hostId}`)
        // Removed while this ran: its handlers are not registered, so a later add starts clean.
        if (prepared.get(hostId) !== pending) throw new Error('这台电脑已移除')
        for (const scheme of ['latch', 'latch-frame']) if (target.protocol.isProtocolHandled(scheme)) target.protocol.unhandle(scheme)
        const missing = () => new Response(null, { status: 404 })
        target.protocol.handle('latch', request => computers.proxyFor(hostId)?.handle(request) ?? missing())
        target.protocol.handle('latch-frame', request => computers.proxyFor(hostId)?.previewFrame(request) ?? missing())
        return target
      })()
      prepared.set(hostId, pending)
      pending.catch(() => prepared.delete(hostId))
    }
    return pending
  }

  function broadcast() {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(COMPUTER_CHANNELS.changed, computers.view({ full: true }))
    for (const window of remoteWindows.values())
      if (!window.isDestroyed()) window.webContents.send(COMPUTER_CHANNELS.changed, computers.view())
  }

  function focus(window) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  async function openComputer(hostId) {
    if (hostId === localHostId) {
      if (!mainWindow || mainWindow.isDestroyed()) openWindow()
      else focus(mainWindow)
      return { ok: true }
    }
    if (!computers.proxyFor(hostId)) return { ok: false, error: 'computer-not-found', message: '找不到这台电脑。' }
    try {
      await openRemote(hostId)
    } catch {
      return { ok: false, error: 'computer-not-found', message: '找不到这台电脑。' }
    }
    return { ok: true }
  }

  // One window per computer: opens that race share one attempt, and an open window is brought forward.
  const openRemote = createWindowOpener({
    existing: hostId => {
      const window = remoteWindows.get(hostId)
      return window && !window.isDestroyed() ? window : undefined
    },
    focus,
    async create(hostId) {
      await prepareSession(hostId)
      if (!computers.proxyFor(hostId)) throw new Error('这台电脑已移除')
      const window = createWindow({ partition: partitionOf(hostId) })
      homes.set(window.webContents, `h-${hostId}`)
      remoteWindows.set(hostId, window)
      window.on('closed', () => {
        if (remoteWindows.get(hostId) === window) remoteWindows.delete(hostId)
      })
      void window.loadURL(`latch://h-${hostId}/link/`)
      return window
    },
  })

  computers = createComputers({
    directory: userData,
    localHostId,
    local: () => ({ name: hostname().replace(/\.local$/u, ''), state: localState() }),
    openStore: hostId => openCredentialStore({ directory: join(userData, 'latch-devices'), hostId, safeStorage, log }),
    makeProxy: input => remotes.createRemoteProxy({ ...input, log }),
    enroll: (link, hooks) => remotes.enrollRemote({ link, name: deviceNameHere(), ...hooks }),
    parseLink: text => remotes.parseComputerLink(text),
    async forgetPartition(hostId) {
      const target = session.fromPartition(partitionOf(hostId))
      remoteWindows.delete(hostId)
      // Every window of that computer's partition goes, not only the one in the list.
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed() && window.webContents.session === target) window.destroy()
      await target.clearStorageData()
      await target.clearCache()
      // A first open may still be preparing the partition: let it finish (it then registers nothing), then unregister.
      const preparing = prepared.get(hostId)
      prepared.delete(hostId)
      await preparing?.catch(() => {})
      for (const scheme of ['latch', 'latch-frame']) if (target.protocol.isProtocolHandled(scheme)) target.protocol.unhandle(scheme)
      // Chromium may still write a file or two after the session is cleared; the folder goes again a moment later, and
      // any that is left is removed at the next start (below).
      const folder = join(userData, 'Partitions', `latch-host-${hostId}`)
      await rm(folder, { recursive: true, force: true }).catch(() => {})
      setTimeout(() => {
        if (!computers.known(hostId)) void rm(folder, { recursive: true, force: true }).catch(() => {})
      }, 2_000).unref()
    },
    onChange: broadcast,
    log,
  })

  /** `full` for this Mac's page, `remote` for a listed computer's own window, otherwise undefined. */
  function senderOf(event) {
    const frame = event?.senderFrame
    const contents = event?.sender
    if (!frame || frame.parent || !contents) return undefined
    const home = homeOf(contents)
    if (!isAppUrl(frame.url, home)) return undefined
    if (home === LOCAL_HOME) return contents === mainWindow?.webContents ? 'full' : undefined
    const window = remoteWindows.get(home.slice(2))
    return window && !window.isDestroyed() && window.webContents === contents && computers.has(home.slice(2)) ? 'remote' : undefined
  }
  const refused = { ok: false, error: 'forbidden', message: '只接受 Latch 页面的请求。' }
  const noGesture = { ok: false, error: 'gesture-required', message: '请在 Latch 页面上点按后再试。' }
  const gestureOf = event => gestures.get(event.sender)?.take() === true

  ipcMain.handle(COMPUTER_CHANNELS.list, event => {
    const sender = senderOf(event)
    return sender ? computers.view({ full: sender === 'full' }) : refused
  })
  ipcMain.handle(COMPUTER_CHANNELS.open, (event, hostId) => {
    if (!senderOf(event)) return refused
    // A page may not pull a window to the front on its own: only after a click or key on it.
    if (!gestureOf(event)) return noGesture
    if (typeof hostId !== 'string' || !computers.has(hostId)) return { ok: false, error: 'computer-not-found', message: '找不到这台电脑。' }
    return openComputer(hostId)
  })
  ipcMain.handle(COMPUTER_CHANNELS.add, async (event, source) => {
    if (senderOf(event) !== 'full') return refused
    if (!gestureOf(event)) return noGesture
    let text
    if (source === 'file') {
      if (!dialogGate.enter()) return { ok: false, error: 'busy', message: '另一个对话框正在打开。' }
      try {
        const picked = await dialog.showOpenDialog(mainWindow, { title: '选择连接文件', properties: ['openFile', 'dontAddToRecent'] })
        if (picked.canceled || picked.filePaths.length !== 1) return { ok: false, error: 'canceled', message: '' }
        const path = picked.filePaths[0]
        const info = await lstat(path)
        if (!info.isFile() || info.size > CODE_FILE_LIMIT) return { ok: false, error: 'invalid-link', message: '这个文件不是连接文件。' }
        text = await readFile(path, 'utf8')
      } catch {
        return { ok: false, error: 'invalid-link', message: '无法读取这个文件。' }
      } finally {
        dialogGate.leave()
      }
    } else text = await clipboard.readText()
    const result = await computers.add(text)
    // A link that added its computer is spent: the clipboard forgets it if it still holds it.
    if (result.ok && source !== 'file') {
      const digest = value => createHash('sha256').update(value).digest('hex')
      const used = digest(text)
      if (digest(String(await clipboard.readText())) === used) await clipboard.clear()
    }
    return result
  })
  ipcMain.handle(COMPUTER_CHANNELS.cancelAdd, event => (senderOf(event) === 'full' ? computers.cancelAdd() : refused))
  ipcMain.handle(COMPUTER_CHANNELS.trustCertificate, (event, hostId) => {
    if (senderOf(event) !== 'full') return refused
    if (!gestureOf(event)) return noGesture
    return computers.trustCertificate(hostId)
  })
  ipcMain.handle(COMPUTER_CHANNELS.remove, (event, hostId) => {
    if (senderOf(event) !== 'full') return refused
    if (!gestureOf(event)) return noGesture
    return computers.remove(hostId)
  })
  app.on('will-quit', () => computers.stop())
  await computers.start()
  // The page storage of a computer that is no longer listed (removed while Chromium still wrote to it).
  const partitions = await readdir(join(userData, 'Partitions')).catch(() => [])
  for (const name of partitions) {
    const match = /^latch-host-([a-z2-7]{52})$/u.exec(name)
    if (match && !computers.known(match[1])) await rm(join(userData, 'Partitions', name), { recursive: true, force: true }).catch(() => {})
  }
  return computers
}

async function start() {
  await hardenSession(session.defaultSession)
  if (process.platform === 'darwin') app.dock?.setIcon(icon)
  const storageProblem = secureStorageProblem(safeStorage)
  if (storageProblem) return fatal(storageProblem)
  if (!hostStatePath) return fatal('缺少 --latch-host-state 参数。请用 pnpm desktop 启动 Latch 桌面端。')
  let state = await readHostStateFile(hostStatePath)
  let checked = state ? await inspectHostState(state) : undefined
  /** @type {{ onChange: (view: object) => void, onActivity: (activity: { running: number, waiting: number }) => void }} */
  const hooks = { onChange: () => {}, onActivity: () => {} }
  let supervisor
  let supervisedId
  if (!checked?.ok) {
    // Not running: the launch record left by an earlier start says how to start it (after a crash, or at login). One
    // attempt, by the supervisor that then watches this Host; when it fails, the page below says so.
    const record = await readLaunchRecord(dirname(hostStatePath), { script: HOST_SCRIPT })
    if (record?.launch) {
      supervisedId = record.hostId
      supervisor = hostSupervisor(record.hostId, hostStatePath, hooks)
      const started = await supervisor.restartNow({ retry: false })
      if (started.ok) {
        state = await readHostStateFile(hostStatePath)
        checked = state ? await inspectHostState(state) : undefined
      }
    }
  }
  if (!state) return fatal('找不到正在运行的 Latch Host（host.json 缺失或格式不正确）。请用 pnpm desktop 启动。')
  if (!checked?.ok) return fatal(`无法验证 Latch Host：${checked?.reason ?? '未知原因'}。请用 pnpm desktop 启动。`)
  previewBrowser.blockHost(state)
  if (!supervisor || supervisedId !== state.hostId) supervisor = hostSupervisor(state.hostId, hostStatePath, hooks)

  let store
  try {
    store = await openCredentialStore({ directory: join(app.getPath('userData'), 'latch-devices'), hostId: state.hostId, safeStorage, log })
  } catch (error) {
    return fatal(`无法打开设备凭据目录：${error instanceof Error ? error.message : '未知错误'}`)
  }

  let socketPath = state.socketPath
  let verifying
  const proxy = createShellProxy({
    hostId: state.hostId,
    store,
    log,
    resolveSocket() {
      if (socketPath) return Promise.resolve(socketPath)
      // After a connection error, accept a restarted Host only if host.json still names the same identity.
      verifying ??= (async () => {
        const next = await readHostStateFile(hostStatePath)
        previewBrowser.blockHost(next)
        if (!next || next.hostId !== state.hostId) throw new Error('Latch 服务未运行')
        const result = await inspectHostState(next)
        if (!result.ok) throw new Error(result.reason)
        socketPath = next.socketPath
        return socketPath
      })().finally(() => {
        verifying = undefined
      })
      return verifying
    },
    invalidateSocket() {
      socketPath = undefined
    },
  })
  protocol.handle('latch', request => proxy.handle(request))
  protocol.handle('latch-frame', request => proxy.previewFrame(request))
  handleFolders(proxy, store)
  // The renderer may only trigger this; main makes the invitation and gives it to the default browser.
  const openInBrowser = createBrowserOpener({
    invite: () => proxy.browserInvitation(),
    open: url => shell.openExternal(url),
    platform: process.platform,
    log,
  })
  ipcMain.handle(OPEN_IN_BROWSER, event =>
    isAppSender(event)
      ? openInBrowser()
      : { ok: false, status: 403, error: 'browser-open-failed', message: '无法在浏览器中打开 Latch，请重试。' },
  )
  // 「复制链接」 for another computer: main makes the invitation and puts the link on the clipboard, concealed.
  const copyComputerLink = createLinkCopier({
    invite: () => proxy.computerInvitation(),
    clipboard: {
      writeConcealed: text => clipboard.write([new ClipboardItem(concealedClipboardEntry(text))]),
      readText: () => clipboard.readText(),
      clear: () => clipboard.clear(),
    },
    platform: process.platform,
    log,
  })
  ipcMain.handle(COPY_COMPUTER_LINK, event =>
    isAppSender(event) ? copyComputerLink() : { ok: false, status: 403, error: 'copy-link-failed', message: '无法复制链接，请重试。' },
  )
  handleFiles(proxy)
  handleBrowserRequests({ ipcMain, trusted, controller: previewBrowser })
  await startComputers({
    localHostId: state.hostId,
    localState: () => (['running', 'unresponsive'].includes(supervisor.view().status) ? 'online' : 'offline'),
  })
  const notifications = createNotifications({
    save: value => writeNotificationPreferences(app.getPath('userData'), value),
    changed: value => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('latch:notifications:state', value)
    },
    snapshot: async () => {
      const response = await hostRequest(proxy, 'GET', '/link/api/snapshot')
      return response.status === 200 ? response.json : undefined
    },
    focused: () => BrowserWindow.getAllWindows().some(window => !window.isDestroyed() && window.isFocused()),
    supported: () => Notification.isSupported(),
    badge: count => {
      if (app.dock) app.dock.setBadge(count ? String(count) : '')
    },
    show: ({ title, body, onClick }) => {
      if (Notification.isSupported()) {
        const item = new Notification({ title, body })
        item.on('click', onClick)
        item.show()
      }
    },
    open: sessionId => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        openWindow()
        mainWindow.webContents.once('did-finish-load', () => mainWindow?.webContents.send('latch:notifications:open', sessionId))
      } else {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
        mainWindow.webContents.send('latch:notifications:open', sessionId)
      }
    },
  })
  notifications.configure(await readNotificationPreferences(app.getPath('userData')))
  handleNotificationRequests({ ipcMain, trusted, controller: notifications })
  const notificationTimer = setInterval(() => void notifications.poll(), CHECK_INTERVAL_MS)
  app.on('will-quit', () => {
    clearInterval(notificationTimer)
    void notifications.close()
  })
  if (store.current()) await proxy.renew()
  proxy.startRenewalTimer()
  const atLogin = await startLifecycle({ supervisor, hooks })
  await startUpdates({ proxy, supervisor })
  ready = true
  // Opened at login, Latch keeps running in the background; the Dock icon opens the window.
  if (!atLogin) openWindow()
}

if (!app.requestSingleInstanceLock()) {
  log('同一数据目录的 Latch 桌面端已在运行。')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    } else if (ready) openWindow()
  })
  app
    .whenReady()
    .then(start)
    .catch(error => fatal(`启动失败：${error instanceof Error ? error.message : '未知错误'}`))
  // The Dock brings back this Mac's window, also while only other computers' windows are open.
  app.on('activate', () => {
    if (ready && (!mainWindow || mainWindow.isDestroyed())) openWindow()
  })
  // On macOS closing the last window leaves the app running, as Mac apps do, so crash restarts and keeping the Mac
  // awake go on; the Dock icon opens the window again and Quit ends the app. The Host keeps running either way. The
  // error page (before `ready`) and other systems end with their last window.
  app.on('window-all-closed', () => {
    if (!ready || process.platform !== 'darwin') app.quit()
  })
}
