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

const { app, BrowserWindow, dialog, nativeImage, nativeTheme, protocol, safeStorage, session, shell } = electron
const { join, resolve } = require('node:path')
const { readHostStateFile, inspectHostState } = require('./host.cjs')
const { openCredentialStore, secureStorageProblem } = require('./credentials.cjs')
const {
  HTML_CSP,
  createExternalOpener,
  createShellProxy,
  debugFlagProblems,
  htmlErrorPage,
  isAllowedRendererRequest,
  isAppUrl,
  unexpectedArguments,
} = require('./proxy.cjs')

const APP_URL = 'latch://app/link/'
const log = text => console.error(`[Latch] ${text}`)

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
    // The page's ground colour (--bg-app in @latch/ui), so the window shows no flash before the first paint.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141413' : '#f2f1ee',
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

function openWindow() {
  void createWindow().loadURL(APP_URL)
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
    callback({ cancel: !isAllowedRendererRequest(details.url, { packaged: app.isPackaged }) })
  })
  await target.setProxy({ mode: 'direct' })
}

const openExternal = createExternalOpener({
  confirm: (options, parent) => (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)),
  open: url => shell.openExternal(url),
  log,
})

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    void openExternal(url, BrowserWindow.fromWebContents(contents) ?? undefined)
    return { action: 'deny' }
  })
  const guard = (event, url) => {
    if (!isAppUrl(event.url ?? url)) event.preventDefault()
  }
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  contents.on('will-frame-navigate', guard)
  contents.on('will-attach-webview', event => event.preventDefault())
})

async function start() {
  await hardenSession(session.defaultSession)
  if (process.platform === 'darwin') app.dock?.setIcon(icon)
  const storageProblem = secureStorageProblem(safeStorage)
  if (storageProblem) return fatal(storageProblem)
  if (!hostStatePath) return fatal('缺少 --latch-host-state 参数。请用 pnpm desktop 启动 Latch 桌面端。')
  const state = await readHostStateFile(hostStatePath)
  if (!state) return fatal('找不到正在运行的 Latch Host（host.json 缺失或格式不正确）。请用 pnpm desktop 启动。')
  const checked = await inspectHostState(state)
  if (!checked.ok) return fatal(`无法验证 Latch Host：${checked.reason}。请用 pnpm desktop 启动。`)

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
  if (store.current()) await proxy.renew()
  proxy.startRenewalTimer()
  ready = true
  openWindow()
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
    }
  })
  app
    .whenReady()
    .then(start)
    .catch(error => fatal(`启动失败：${error instanceof Error ? error.message : '未知错误'}`))
  app.on('activate', () => {
    if (ready && BrowserWindow.getAllWindows().length === 0) openWindow()
  })
  // Closing the window ends the shell only; the Host keeps running and keeps its sessions.
  app.on('window-all-closed', () => app.quit())
}
