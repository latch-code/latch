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
  dialog,
  ipcMain,
  nativeImage,
  Notification,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  safeStorage,
  session,
  shell,
} = electron
const { constants: fsConstants } = require('node:fs')
const { lstat, open: openFile, realpath, stat } = require('node:fs/promises')
const { dirname, join, resolve } = require('node:path')
const { readHostStateFile, inspectHostState, readBody, socketRequest } = require('./host.cjs')
const { openCredentialStore, secureStorageProblem } = require('./credentials.cjs')
const { createFolderActions, isTrustedSender } = require('./folders.cjs')
const { createConfirmationActions } = require('./confirmations.cjs')
const {
  createNotifications,
  readPreferences: readNotificationPreferences,
  writePreferences: writeNotificationPreferences,
  handleNotificationRequests,
} = require('./notifications.cjs')
const { createFileActions } = require('./files.cjs')
const { createNetworkSink } = require('./network.cjs')
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
  createBrowserOpener,
  createExternalGesture,
  createExternalOpener,
  createShellProxy,
  debugFlagProblems,
  htmlErrorPage,
  isAllowedRendererDetails,
  isPreviewFrameUrl,
  isAppSender,
  isAppUrl,
  unexpectedArguments,
} = require('./proxy.cjs')

const APP_URL = 'latch://app/link/'
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

function createWindow({ width = 1250, height = 850, preload = true } = {}) {
  return new BrowserWindow({
    width,
    height,
    minWidth: Math.min(width, 760),
    minHeight: Math.min(height, 560),
    title: 'Latch',
    // The window's own colour (--sidebar in @latch/ui), so the window shows no flash before the first paint.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0b' : '#f7f7f8',
    icon,
    webPreferences: {
      ...(preload ? { preload: join(__dirname, 'preload.cjs') } : {}),
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

function openWindow() {
  mainWindow = createWindow()
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

async function hardenSession(target) {
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  target.setPermissionCheckHandler(() => false)
  target.setDevicePermissionHandler(() => false)
  // The renderer has no network of its own; every Host connection goes through main.
  target.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRendererDetails(details, { packaged: app.isPackaged }) })
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

app.on('web-contents-created', (_event, contents) => {
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  const gesture = createExternalGesture()
  contents.on('before-mouse-event', (_event, input) => gesture.mouse(input))
  contents.on('before-input-event', (_event, input) => gesture.key(input))
  contents.on('blur', () => gesture.clear())
  contents.on('did-start-navigation', () => gesture.clear())
  contents.setWindowOpenHandler(({ url }) => {
    const userGesture = contents === mainWindow?.webContents && isAppUrl(contents.getURL()) && gesture.take()
    void openExternal(url, BrowserWindow.fromWebContents(contents) ?? undefined, { userGesture })
    return { action: 'deny' }
  })
  const guard = (event, url) => {
    if (!isAppUrl(event.url ?? url)) event.preventDefault()
  }
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  contents.on('will-frame-navigate', event => {
    if (event.isMainFrame) {
      if (!isAppUrl(event.url)) event.preventDefault()
    } else if (!isPreviewFrameUrl(event.url)) event.preventDefault()
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
    readState: () => readHostStateFile(statePath),
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
    const value = lifecycleView()
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send(LIFECYCLE_CHANNELS.changed, value)
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
  const systemQuit = createSystemQuit()
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
        if (!next || next.hostId !== state.hostId) throw new Error('Latch Host 未运行')
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
  const confirmations = createConfirmationActions({
    request: (method, path, body) => proxy.shellRequest(method, path, body),
    sign: (id, hash) => store.signConfirmation(id, hash),
    identity: () => {
      const current = store.current()
      return current ? { hostId: store.hostId, deviceId: current.deviceId } : undefined
    },
    focused: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()),
    gate: dialogGate,
    confirm: options => dialog.showMessageBox(mainWindow, options),
  })
  ipcMain.handle('latch:confirmations:confirm', (event, id) =>
    trusted(event) ? confirmations.confirm(id) : { status: 'failed', code: 'shell-refused' },
  )
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
  handleFiles(proxy)
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
  ready = true
  // Opened at login, Latch keeps running in the background; the Dock icon opens the window.
  if (!atLogin) openWindow()
}

if (!app.requestSingleInstanceLock()) {
  log('同一数据目录的 Latch 桌面端已在运行。')
  app.quit()
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    } else if (ready) openWindow()
  })
  app
    .whenReady()
    .then(start)
    .catch(error => fatal(`启动失败：${error instanceof Error ? error.message : '未知错误'}`))
  app.on('activate', () => {
    if (ready && BrowserWindow.getAllWindows().length === 0) openWindow()
  })
  // On macOS closing the last window leaves the app running, as Mac apps do, so crash restarts and keeping the Mac
  // awake go on; the Dock icon opens the window again and Quit ends the app. The Host keeps running either way. The
  // error page (before `ready`) and other systems end with their last window.
  app.on('window-all-closed', () => {
    if (!ready || process.platform !== 'darwin') app.quit()
  })
}
