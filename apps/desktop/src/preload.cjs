'use strict'
// The only thing the renderer learns about the shell. Keys and credentials stay in the main process.
// `folders` asks main for the system file manager: the native open panel, dropped folders, saving a session's own
// folder as a project and showing a project's folder in Finder. A dropped File's path is read here, in the isolated
// preload, so the page never handles it; a session's folder is looked up by main.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/
const FOLDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const FOLDER_LIMIT = 8
// A click can reopen the window: its message then arrives before the page has subscribed, and waits for the first subscriber.
let earlySession
const holdEarlySession = (_event, sessionId) => {
  if (typeof sessionId === 'string' && SESSION_ID.test(sessionId)) earlySession = sessionId
}
ipcRenderer.on('latch:notifications:open', holdEarlySession)
const INVALID = Object.freeze({ status: 'failed', code: 'invalid' })
const CANCELED = Object.freeze({ status: 'canceled' })
const NOTIFICATION_CONSENT = new Set(['unasked', 'accepted', 'declined'])
function notificationState(value) {
  const bools = ['completion', 'approval', 'title', 'supported']
  if (
    !value
    || typeof value !== 'object'
    || !Object.keys(value).every(key => bools.includes(key) || key === 'consent')
    || !bools.every(key => Object.hasOwn(value, key) && typeof value[key] === 'boolean')
    || (Object.hasOwn(value, 'consent') && !NOTIFICATION_CONSENT.has(value.consent))
  )
    return undefined
  return {
    completion: value.completion,
    approval: value.approval,
    title: value.title,
    supported: value.supported,
    ...(Object.hasOwn(value, 'consent') ? { consent: value.consent } : {}),
  }
}

// `updates`: main's updater (updater.cjs). Only this checked view crosses: states, versions, counts, notes and codes,
// never a URL or a path. 「检查更新…」 in the menu asks the page to show the update area; a request that arrives before
// the page subscribes waits for the first subscriber.
const UPDATE_STATES = new Set([
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'ready',
  'waiting',
  'installing',
  'failed',
  'unsupported',
])
const UPDATE_STAGES = new Set(['check', 'download', 'verify', 'install', 'gate'])
const UPDATE_REASONS = new Set(['development', 'not-configured', 'unsigned', 'platform'])
const UPDATE_CODE = /^[a-z0-9-]{1,40}$/
const VERSION_TEXT = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/
const count = value => Number.isSafeInteger(value) && value >= 0
const shortText = (value, limit) => typeof value === 'string' && value.length <= limit
const pluginList = value =>
  Array.isArray(value) && value.length <= 64 && value.every(item => item && shortText(item.id, 64) && shortText(item.name, 80))
    ? value.map(item => ({ id: item.id, name: item.name }))
    : undefined
function updateView(value) {
  if (!value || typeof value !== 'object' || !UPDATE_STATES.has(value.state)) return undefined
  if (!shortText(value.appVersion, 32) || typeof value.autoDownload !== 'boolean' || typeof value.installAtQuit !== 'boolean')
    return undefined
  const held = pluginList(value.heldPlugins)
  if (!held) return undefined
  const view = {
    state: value.state,
    appVersion: value.appVersion,
    autoDownload: value.autoDownload,
    installAtQuit: value.installAtQuit,
    heldPlugins: held,
  }
  if (value.reason !== undefined) {
    if (!UPDATE_REASONS.has(value.reason)) return undefined
    view.reason = value.reason
  }
  if (value.checkedAt !== undefined) {
    if (!shortText(value.checkedAt, 40)) return undefined
    view.checkedAt = value.checkedAt
  }
  const release = value.release
  if (release !== undefined) {
    if (!release || !VERSION_TEXT.test(release.version) || !shortText(release.publishedAt, 40) || !count(release.size)) return undefined
    if (!release.notes || !shortText(release.notes['zh-CN'], 4000) || !shortText(release.notes.en, 4000)) return undefined
    if (release.plan !== 'app' && release.plan !== 'host') return undefined
    const incompatible = pluginList(release.incompatiblePlugins)
    if (!incompatible) return undefined
    view.release = {
      version: release.version,
      publishedAt: release.publishedAt,
      notes: { 'zh-CN': release.notes['zh-CN'], en: release.notes.en },
      size: release.size,
      plan: release.plan,
      incompatiblePlugins: incompatible,
    }
  }
  if (value.progress !== undefined) {
    if (!value.progress || !count(value.progress.received) || !count(value.progress.total)) return undefined
    view.progress = { received: value.progress.received, total: value.progress.total }
  }
  if (value.waiting !== undefined) {
    const waiting = value.waiting
    const keys = ['count', 'running', 'waiting', 'unknown', 'queued', 'terminals', 'services']
    if (!waiting || !keys.every(key => count(waiting[key]))) return undefined
    view.waiting = Object.fromEntries(keys.map(key => [key, waiting[key]]))
  }
  if (value.failure !== undefined) {
    if (!value.failure || !UPDATE_STAGES.has(value.failure.stage) || !UPDATE_CODE.test(value.failure.code)) return undefined
    view.failure = { stage: value.failure.stage, code: value.failure.code }
  }
  return view
}
const updateCall = (channel, input) => ipcRenderer.invoke(channel, input).then(updateView)
let earlyShow = false
const holdEarlyShow = () => {
  earlyShow = true
}
ipcRenderer.on('latch:updates:show', holdEarlyShow)

/** Absent is null; a given ID must match, otherwise undefined and the call is refused here. */
function optionalId(value, pattern) {
  if (value === undefined || value === null) return null
  return typeof value === 'string' && pattern.test(value) ? value : undefined
}

const HANDLE = /^[A-Za-z0-9_-]{22}$/
const REFERENCE_LIMIT = 4096
const KNOWN_LIMIT = 64

/**
 * A file action's input: the session and either the reference as the message wrote it (a string) or `{ handle }`
 * from the Host. Only these plain values cross to main; anything else never leaves the preload.
 */
function fileInput(sessionId, target) {
  if (
    sessionId
    && typeof sessionId === 'object'
    && Object.keys(sessionId).length === 2
    && typeof sessionId.workspaceId === 'string'
    && /^[A-Za-z0-9_-]{1,64}$/.test(sessionId.workspaceId)
    && typeof sessionId.harnessId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/.test(sessionId.harnessId)
    && target
    && typeof target === 'object'
    && typeof target.handle === 'string'
    && HANDLE.test(target.handle)
  )
    return { workspaceId: sessionId.workspaceId, harnessId: sessionId.harnessId, handle: target.handle }
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/.test(sessionId)) return undefined
  if (typeof target === 'string') return target.length > 0 && target.length <= REFERENCE_LIMIT ? { sessionId, path: target } : undefined
  const handle = target !== null && typeof target === 'object' ? target.handle : undefined
  return typeof handle === 'string' && HANDLE.test(handle) ? { sessionId, handle } : undefined
}

/** Which references are files: the session and 1–64 references as strings, nothing else. */
function knownInput(sessionId, paths) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/.test(sessionId)) return undefined
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > KNOWN_LIMIT) return undefined
  const copy = Array.from(paths)
  return copy.every(path => typeof path === 'string' && path.length > 0 && path.length <= REFERENCE_LIMIT)
    ? { sessionId, paths: copy }
    : undefined
}

const fileCall = channel => (sessionId, target) => {
  const input = fileInput(sessionId, target)
  return input ? ipcRenderer.invoke(channel, input) : Promise.resolve(INVALID)
}

// `browser`: the preview tabs, which main keeps (browser.cjs). Every call names a tab main handed out (or a project);
// only these plain values cross to main, and only checked events come back.
const BROWSER_TAB = /^brw_[A-Za-z0-9_-]{22}$/
const BROWSER_INVALID = Object.freeze({ ok: false, error: 'invalid' })
const BROWSER_NOTICES = new Set(['permission', 'download', 'popup', 'navigation', 'certificate'])
const browserNumber = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const browserCall = (channel, input) => (input ? ipcRenderer.invoke(channel, input) : Promise.resolve(BROWSER_INVALID))
const browserTab = tabId => (typeof tabId === 'string' && BROWSER_TAB.test(tabId) ? { tabId } : undefined)
const browserProject = projectId => (typeof projectId === 'string' && PROJECT_ID.test(projectId) ? projectId : undefined)
const browserAddress = url => (typeof url === 'string' && url.length > 0 && url.length <= 2048 ? url : undefined)
const browserGo = action => tabId => {
  const tab = browserTab(tabId)
  return browserCall('latch:browser:go', tab && { tabId: tab.tabId, action })
}

/** Exactly x, y, width and height, finite: the panel's rectangle in the page's CSS pixels. */
function browserRect(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 4) return undefined
  const { x, y, width, height } = value
  if (!browserNumber(x, -100_000, 100_000) || !browserNumber(y, -100_000, 100_000)) return undefined
  return browserNumber(width, 0, 100_000) && browserNumber(height, 0, 100_000) ? { x, y, width, height } : undefined
}

function browserState(value) {
  if (!value || typeof value !== 'object') return undefined
  const { url, title, loading, canGoBack, canGoForward, zoom, crashed, error } = value
  if (typeof url !== 'string' || url.length > 8192 || typeof title !== 'string' || title.length > 256) return undefined
  if (![loading, canGoBack, canGoForward, crashed].every(item => typeof item === 'boolean') || !browserNumber(zoom, 0.25, 5))
    return undefined
  if (error !== null && !(Number.isInteger(error) && error < 0 && error > -1000)) return undefined
  return { url, title, loading, canGoBack, canGoForward, zoom, crashed, error }
}

/** A tab's state, a notice (with the permission or the reason it names) or its end; anything else is dropped. */
function browserEvent(value) {
  if (!value || typeof value !== 'object' || typeof value.tabId !== 'string' || !BROWSER_TAB.test(value.tabId)) return undefined
  const tabId = value.tabId
  if (value.type === 'closed') return { type: 'closed', tabId }
  if (value.type === 'state') {
    const state = browserState(value.state)
    return state ? { type: 'state', tabId, state } : undefined
  }
  if (value.type !== 'notice' || !BROWSER_NOTICES.has(value.notice)) return undefined
  const detail = typeof value.detail === 'string' && /^[A-Za-z][A-Za-z-]{0,39}$/.test(value.detail) ? value.detail : undefined
  return { type: 'notice', tabId, notice: value.notice, ...(detail ? { detail } : {}) }
}

/** The disk paths of dropped File objects; anything that is not a File backed by a file on disk drops the whole set. */
function diskPaths(files) {
  let list
  try {
    list = Array.from(files ?? [])
  } catch {
    return []
  }
  if (list.length === 0 || list.length > FOLDER_LIMIT) return []
  const paths = []
  for (const file of list) {
    let path = ''
    try {
      // '' for a File that no file on disk backs (one the page made itself); a throw for anything that is not a File.
      path = webUtils.getPathForFile(file)
    } catch {
      return []
    }
    if (typeof path !== 'string' || !path) return []
    paths.push(path)
  }
  return paths
}

// The channels are OPEN_IN_BROWSER and COPY_COMPUTER_LINK in proxy.cjs, LIFECYCLE_CHANNELS in lifecycle.cjs and CHANNELS in browser.cjs, which
// a sandboxed preload cannot load, and the latch:folders:* handlers in main.cjs; main accepts each only from the
// latch://app/ page in a window's top frame.
contextBridge.exposeInMainWorld(
  'latchShell',
  Object.freeze({
    kind: 'electron',
    devMode: true,
    platform: process.platform,
    previews: Object.freeze({ protocolVersion: 1, htmlScripts: true }),
    folders: Object.freeze({
      protocolVersion: 1,
      /** No project: a new project. A project: more folders for it; with a folder, that folder chosen again. */
      pick: (projectId, replaceFolderId) => {
        const project = optionalId(projectId, PROJECT_ID)
        const replace = optionalId(replaceFolderId, FOLDER_ID)
        if (project === undefined || replace === undefined || (replace !== null && project === null)) return Promise.resolve(INVALID)
        return ipcRenderer.invoke('latch:folders:pick', { projectId: project, replaceFolderId: replace })
      },
      /** `drop(files)` makes a new project of the dropped folders; `drop(projectId, files)` adds them to that project. */
      drop: (projectOrFiles, maybeFiles) => {
        const named = projectOrFiles === undefined || projectOrFiles === null || typeof projectOrFiles === 'string'
        const project = named ? optionalId(projectOrFiles, PROJECT_ID) : null
        if (project === undefined) return Promise.resolve(INVALID)
        const paths = diskPaths(named ? maybeFiles : projectOrFiles)
        return paths.length === 0 ? Promise.resolve(CANCELED) : ipcRenderer.invoke('latch:folders:drop', { projectId: project, paths })
      },
      /** Finder shows one of the project's folders; without a folder, its primary folder. */
      reveal: (projectId, folderId) => {
        const folder = optionalId(folderId, FOLDER_ID)
        if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId) || folder === undefined) return Promise.resolve(INVALID)
        return ipcRenderer.invoke('latch:folders:reveal', { projectId, folderId: folder })
      },
      /** 存为项目: the folder the Host made for this session becomes a new project's primary folder. */
      saveSessionFolder: sessionId => {
        if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return Promise.resolve(INVALID)
        return ipcRenderer.invoke('latch:folders:save-session', { sessionId })
      },
    }),
    // Main makes a one-time invitation and opens the browser with it; the renderer only learns whether that worked.
    openInBrowser: () => ipcRenderer.invoke('latch:open-in-browser'),
    // Main makes a one-time link for another computer and puts it on the clipboard; the renderer never sees the link.
    copyComputerLink: () => ipcRenderer.invoke('latch:copy-computer-link'),
    // Login item, keeping the Mac awake and the Host's restarts (Settings › 通用); main owns all of them.
    lifecycle: Object.freeze({
      get: () => ipcRenderer.invoke('latch:lifecycle'),
      setLoginItem: enabled => ipcRenderer.invoke('latch:lifecycle:login-item', enabled === true),
      setKeepAwake: enabled => ipcRenderer.invoke('latch:lifecycle:keep-awake', enabled === true),
      restartHost: () => ipcRenderer.invoke('latch:lifecycle:restart-host'),
      subscribe: callback => {
        const listener = (_event, value) => callback(value)
        ipcRenderer.on('latch:lifecycle:changed', listener)
        return () => ipcRenderer.removeListener('latch:lifecycle:changed', listener)
      },
    }),
    notifications: Object.freeze({
      get: () => ipcRenderer.invoke('latch:notifications:get').then(notificationState),
      set: value =>
        value
        && Object.keys(value).length === 3
        && ['completion', 'approval', 'title'].every(key => Object.hasOwn(value, key) && typeof value[key] === 'boolean')
          ? ipcRenderer
              .invoke('latch:notifications:set', { completion: value.completion, approval: value.approval, title: value.title })
              .then(notificationState)
          : Promise.resolve(undefined),
      subscribeState: callback => {
        if (typeof callback !== 'function') return () => {}
        const listener = (_event, value) => {
          const state = notificationState(value)
          if (state) callback(state)
        }
        ipcRenderer.on('latch:notifications:state', listener)
        return () => ipcRenderer.removeListener('latch:notifications:state', listener)
      },
      subscribe: callback => {
        const listener = (_event, sessionId) => {
          if (typeof sessionId === 'string' && SESSION_ID.test(sessionId)) callback(sessionId)
        }
        ipcRenderer.removeListener('latch:notifications:open', holdEarlySession)
        ipcRenderer.on('latch:notifications:open', listener)
        const early = earlySession
        earlySession = undefined
        if (early !== undefined) callback(early)
        return () => ipcRenderer.removeListener('latch:notifications:open', listener)
      },
    }),
    // This app's own updates (Settings › 关于). Main owns the feed, the files and the install; the page gets the view.
    updates: Object.freeze({
      get: () => updateCall('latch:updates'),
      check: () => updateCall('latch:updates:check'),
      download: () => updateCall('latch:updates:download'),
      /** 'now' (重启并安装) or 'at-quit' (下次退出时安装). */
      install: when => updateCall('latch:updates:install', when === 'at-quit' ? 'at-quit' : 'now'),
      cancelWaiting: () => updateCall('latch:updates:cancel-waiting'),
      setAutoDownload: enabled => updateCall('latch:updates:auto-download', enabled === true),
      onChange: callback => {
        if (typeof callback !== 'function') return () => {}
        const listener = (_event, value) => {
          const view = updateView(value)
          if (view) callback(view)
        }
        ipcRenderer.on('latch:updates:changed', listener)
        return () => ipcRenderer.removeListener('latch:updates:changed', listener)
      },
      /** 「检查更新…」 was chosen in the menu: the page shows Settings › 关于. */
      onShow: callback => {
        if (typeof callback !== 'function') return () => {}
        const listener = () => callback()
        ipcRenderer.removeListener('latch:updates:show', holdEarlyShow)
        ipcRenderer.on('latch:updates:show', listener)
        if (earlyShow) {
          earlyShow = false
          callback()
        }
        return () => ipcRenderer.removeListener('latch:updates:show', listener)
      },
    }),
    files: Object.freeze({
      protocolVersion: 2,
      inspect: (sessionId, path) =>
        typeof path === 'string' ? fileCall('latch:files:inspect')(sessionId, path) : Promise.resolve(INVALID),
      known: (sessionId, paths) => {
        const input = knownInput(sessionId, paths)
        return input ? ipcRenderer.invoke('latch:files:known', input) : Promise.resolve(INVALID)
      },
      reveal: fileCall('latch:files:reveal'),
      quickLook: fileCall('latch:files:quicklook'),
      open: fileCall('latch:files:open'),
    }),
    // The 浏览器 tab. Main lays each tab's page over the panel rectangle the page sends and keeps every way a guest page
    // could reach the shell or the Host shut.
    browser: Object.freeze({
      protocolVersion: 1,
      /** A new tab in the project's own partition, empty or at an address as typed in the address field. */
      open: (projectId, url) => {
        const project = browserProject(projectId)
        const address = url === undefined || url === null ? null : browserAddress(url)
        return browserCall('latch:browser:open', project && address !== undefined ? { projectId: project, url: address } : undefined)
      },
      close: tabId => browserCall('latch:browser:close', browserTab(tabId)),
      navigate: (tabId, url) => {
        const tab = browserTab(tabId)
        const address = browserAddress(url)
        return browserCall('latch:browser:navigate', tab && address ? { tabId: tab.tabId, url: address } : undefined)
      },
      back: browserGo('back'),
      forward: browserGo('forward'),
      reload: browserGo('reload'),
      stop: browserGo('stop'),
      /** The panel's rectangle in CSS pixels of the page; null hides the tab. */
      setBounds: (tabId, bounds) => {
        const tab = browserTab(tabId)
        const rect = bounds === null ? null : browserRect(bounds)
        return browserCall('latch:browser:bounds', tab && rect !== undefined ? { tabId: tab.tabId, bounds: rect } : undefined)
      },
      /** While an overlay of the page covers the panel: the tab hides, and the frame it showed comes back to stand in. */
      occlude: (tabId, occluded) => {
        const tab = browserTab(tabId)
        return browserCall('latch:browser:occlude', tab && typeof occluded === 'boolean' ? { tabId: tab.tabId, occluded } : undefined)
      },
      focus: tabId => browserCall('latch:browser:focus', browserTab(tabId)),
      capture: tabId => browserCall('latch:browser:capture', browserTab(tabId)),
      /** 标注: the element at a point of the tab, in CSS pixels of the page from the tab's top-left corner. */
      annotate: (tabId, point) => {
        const tab = browserTab(tabId)
        const valid =
          point
          && typeof point === 'object'
          && Object.keys(point).length === 2
          && browserNumber(point.x, 0, 100_000)
          && browserNumber(point.y, 0, 100_000)
        return browserCall('latch:browser:annotate', tab && valid ? { tabId: tab.tabId, point: { x: point.x, y: point.y } } : undefined)
      },
      zoom: (tabId, direction) => {
        const tab = browserTab(tabId)
        const valid = direction === 'in' || direction === 'out' || direction === 'reset'
        return browserCall('latch:browser:zoom', tab && valid ? { tabId: tab.tabId, direction } : undefined)
      },
      devTools: tabId => browserCall('latch:browser:devtools', browserTab(tabId)),
      /** 清除数据 of a project's partition: its storage, cookies, cache and saved credentials. */
      clearData: projectId => {
        const project = browserProject(projectId)
        return browserCall('latch:browser:clear-data', project && { projectId: project })
      },
      state: tabId => browserCall('latch:browser:state', browserTab(tabId)),
      subscribe: callback => {
        if (typeof callback !== 'function') return () => {}
        const listener = (_event, value) => {
          const event = browserEvent(value)
          if (event) callback(event)
        }
        ipcRenderer.on('latch:browser:event', listener)
        return () => ipcRenderer.removeListener('latch:browser:event', listener)
      },
    }),
  }),
)
