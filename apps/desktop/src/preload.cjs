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
const INVALID = Object.freeze({ status: 'failed', code: 'invalid' })
const CANCELED = Object.freeze({ status: 'canceled' })
const NOTIFICATION_CONSENT = new Set(['unasked', 'pending', 'accepted', 'declined'])
function notificationState(value) {
  const bools = ['completion', 'approval', 'title', 'supported', 'needsConsent']
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
    needsConsent: value.needsConsent,
    ...(Object.hasOwn(value, 'consent') ? { consent: value.consent } : {}),
  }
}

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

// The channels are OPEN_IN_BROWSER in proxy.cjs and LIFECYCLE_CHANNELS in lifecycle.cjs, which a sandboxed preload
// cannot load, and the latch:folders:* handlers in main.cjs; main accepts each only from the latch://app/ page in a
// window's top frame.
contextBridge.exposeInMainWorld(
  'latchShell',
  Object.freeze({
    kind: 'electron',
    devMode: true,
    platform: process.platform,
    previews: Object.freeze({ protocolVersion: 1, htmlScripts: true }),
    confirmations: Object.freeze({
      protocolVersion: 1,
      confirm: id =>
        typeof id === 'string' && /^cfm_[A-Za-z0-9_-]{22}$/.test(id)
          ? ipcRenderer.invoke('latch:confirmations:confirm', id)
          : Promise.resolve(INVALID),
    }),
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
      respond: value =>
        value
        && typeof value === 'object'
        && Object.keys(value).length === 1
        && Object.hasOwn(value, 'choice')
        && ['enable', 'decline'].includes(value.choice)
          ? ipcRenderer.invoke('latch:notifications:respond', { choice: value.choice }).then(notificationState)
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
        ipcRenderer.on('latch:notifications:open', listener)
        return () => ipcRenderer.removeListener('latch:notifications:open', listener)
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
  }),
)
