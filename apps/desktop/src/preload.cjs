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

/** Absent is null; a given ID must match, otherwise undefined and the call is refused here. */
function optionalId(value, pattern) {
  if (value === undefined || value === null) return null
  return typeof value === 'string' && pattern.test(value) ? value : undefined
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

contextBridge.exposeInMainWorld(
  'latchShell',
  Object.freeze({
    kind: 'electron',
    devMode: true,
    platform: process.platform,
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
  }),
)
