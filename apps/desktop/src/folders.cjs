'use strict'
// Projects from the system file manager. The page asks main to pick folders (the native open panel), to add folders
// dropped from Finder (after a native confirmation that lists them), to save a session's own folder as a project
// (after a native confirmation that shows it) or to show a project's folder in Finder. The page never sends a path for
// the adds: the preload reads the dropped File objects' paths, a session's folder comes from the Host, the person
// chooses or confirms in a native dialog, and main adds the folders over host.sock itself: a nonce from
// `POST /folder-grants`, then the body signed with the device key, which the renderer never holds. The Host checks
// every path again (R1–R10 and the project rules); main checks only the shape of what it is handed.
const nodePath = require('node:path')

const APP_PREFIX = 'latch://app/link/'
/** As the preload checks them: project IDs the Host hands out, and folder IDs inside a project. */
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/
const FOLDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
/** Session IDs as the Host hands them out (`task-<uuid>` for Latch 内置 and ACP agents). */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const PATH_BYTES_LIMIT = 4096
const FOLDER_LIMIT = 8
const REVEAL_INTERVAL_MS = 500
const NAME_LIMIT = 80
/** R8, as the Host's paths.ts: C0 and C1 controls, DEL, line and paragraph separators, bidi controls, zero-width characters. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u
const READS = 'Latch 内置可以读取其中的所有文件。'
const REMOTE = '其他设备也可以在这个项目中发起会话。'
const UNPRINTABLE_MESSAGE = '文件夹路径包含不可显示的字符，不能加入项目。'
const INVALID_MESSAGE = '这个路径不能作为文件夹加入项目。'
/** Per-path refusals carry a status only for the page's fallback wording. */
const REFUSED_STATUS = 409

const isPlainObject = value =>
  value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))

/** Exactly these own keys and nothing else, so an input cannot carry anything main did not ask for. */
function hasOnlyKeys(value, keys) {
  if (!isPlainObject(value)) return false
  const own = Object.keys(value)
  return own.length === keys.length && keys.every(key => own.includes(key))
}

function isPrintable(text) {
  return typeof text === 'string' && !UNPRINTABLE.test(text)
}

/** An absolute path of at most 4096 bytes without NUL, the shape the Host can be asked about. */
function isPathShaped(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && !value.includes('\0')
    && Buffer.byteLength(value, 'utf8') <= PATH_BYTES_LIMIT
    && nodePath.isAbsolute(value)
  )
}

/** Why main refuses a path before any dialog or Host call, or undefined when it may go on. */
function pathProblem(value) {
  if (!isPathShaped(value)) return 'invalid'
  if (!isPrintable(value)) return 'workspace-folder-unprintable'
  return undefined
}

/** `null` stays null (none given); a string must match `pattern`; anything else is undefined (refused). */
function optionalId(value, pattern) {
  if (value === null) return null
  return typeof value === 'string' && pattern.test(value) ? value : undefined
}

/** `latch:folders:pick`: `projectId: null` is a new project; `replaceFolderId` re-selects that folder of the project. */
function parsePickInput(input) {
  if (!hasOnlyKeys(input, ['projectId', 'replaceFolderId'])) return undefined
  const projectId = optionalId(input.projectId, PROJECT_ID)
  const replaceFolderId = optionalId(input.replaceFolderId, FOLDER_ID)
  if (projectId === undefined || replaceFolderId === undefined) return undefined
  if (replaceFolderId !== null && projectId === null) return undefined
  return { projectId, replaceFolderId }
}

/**
 * `latch:folders:drop`: 1–8 absolute dropped paths, without repeats. A path with a character a dialog could not show
 * as it is (R8) is refused before the confirmation, so the confirmation always shows exactly what will be added.
 * @returns {{ projectId: string | null; paths: string[] } | { error: string }}
 */
function parseDropInput(input) {
  if (!hasOnlyKeys(input, ['projectId', 'paths']) || !Array.isArray(input.paths)) return { error: 'invalid' }
  const projectId = optionalId(input.projectId, PROJECT_ID)
  if (projectId === undefined || input.paths.length === 0 || input.paths.length > FOLDER_LIMIT) return { error: 'invalid' }
  const paths = [...new Set(input.paths)]
  for (const path of paths) {
    const problem = pathProblem(path)
    if (problem) return { error: problem }
  }
  return { projectId, paths }
}

/** `latch:folders:reveal`: a project and one of its folders by ID; `folderId: null` is the primary folder. */
function parseRevealInput(input) {
  if (!hasOnlyKeys(input, ['projectId', 'folderId'])) return undefined
  const projectId = optionalId(input.projectId, PROJECT_ID)
  const folderId = optionalId(input.folderId, FOLDER_ID)
  if (typeof projectId !== 'string' || folderId === undefined) return undefined
  return { projectId, folderId }
}

/** `latch:folders:save-session`: one session by ID; its folder comes from the Host. */
function parseSaveSessionInput(input) {
  if (!hasOnlyKeys(input, ['sessionId'])) return undefined
  return typeof input.sessionId === 'string' && SESSION_ID.test(input.sessionId) ? { sessionId: input.sessionId } : undefined
}

/**
 * Only the main window's own top-level page may ask: an event from a subframe, a detached frame, another window or a
 * page outside latch://app/link/ is refused.
 * @param {{ sender: unknown; senderFrame: { url: string; detached?: boolean; parent: unknown } | null }} event
 * @param {unknown} mainContents  the main window's webContents
 */
function isTrustedSender(event, mainContents) {
  const frame = event.senderFrame
  if (!frame || frame.detached || frame.parent !== null) return false
  if (event.sender !== mainContents) return false
  return typeof frame.url === 'string' && frame.url.startsWith(APP_PREFIX)
}

/** A name the Host sent, if a dialog can show it as it is; otherwise the dialog leaves it out. */
function shownName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= NAME_LIMIT && isPrintable(name) ? name : undefined
}

/**
 * The native open panel. Never `treatPackageAsDirectory` (an app bundle is not a folder to add), `showHiddenFiles` or
 * `noResolveAliases`; `defaultPath` is always set, since the system default (Downloads) is a protected folder.
 * @param {{ defaultPath: string; project?: { name?: string; remoteStart?: boolean }; replacing?: { name?: string } }} input
 * @returns {Electron.OpenDialogOptions}
 */
function pickDialog({ defaultPath, project, replacing }) {
  if (replacing) {
    const name = shownName(replacing.name)
    return {
      title: name ? `重新选择「${name}」` : '重新选择文件夹',
      buttonLabel: '选择',
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    }
  }
  if (project) {
    const name = shownName(project.name)
    return {
      title: name ? `添加文件夹到「${name}」` : '添加文件夹',
      buttonLabel: '添加',
      message: `可以选择多个文件夹。${READS}${project.remoteStart === true ? REMOTE : ''}`,
      defaultPath,
      properties: ['openDirectory', 'createDirectory', 'multiSelections'],
    }
  }
  return {
    title: '新建项目',
    buttonLabel: '创建项目',
    message: '可以选择多个文件夹。之后可以在设置中更改主文件夹。',
    defaultPath,
    properties: ['openDirectory', 'createDirectory', 'multiSelections'],
  }
}

/**
 * The confirmation main shows before dropped folders join a project or become one, listing every path; cancel is the
 * default and the Escape answer. The paths passed R8, so none can pose as another line.
 * @param {{ paths: string[]; project?: { name?: string; remoteStart?: boolean } }} input
 * @returns {Electron.MessageBoxOptions}
 */
function dropDialog({ paths, project }) {
  const name = project ? shownName(project.name) : undefined
  return {
    type: 'question',
    title: 'Latch',
    message: project ? (name ? `把这些文件夹加入「${name}」？` : '把这些文件夹加入这个项目？') : '用这些文件夹新建项目？',
    detail: `${paths.join('\n')}\n\n${READS}${project?.remoteStart === true ? REMOTE : ''}`,
    buttons: [project ? '添加' : '新建项目', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
}

/**
 * The confirmation main shows before a session's own folder becomes a project: the folder and the session's title as
 * the Host gave them; cancel is the default and the Escape answer. The path passed R8.
 * @param {{ path: string; title?: string }} input
 * @returns {Electron.MessageBoxOptions}
 */
function saveSessionDialog({ path, title }) {
  const name = shownName(title)
  return {
    type: 'question',
    title: 'Latch',
    message: name ? `把「${name}」的文件夹存为项目？` : '把这个会话的文件夹存为项目？',
    detail: `${path}\n\n之后可以在这个项目中新建会话；这个会话本身不变。${READS}`,
    buttons: ['存为项目', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
}

/** A project's folders as the Host listed them; a Host from before several folders lists only `path`. */
function foldersOf(workspace) {
  const folders = Array.isArray(workspace?.folders) ? workspace.folders.filter(folder => isPlainObject(folder)) : []
  if (folders.length > 0) return folders
  return typeof workspace?.path === 'string' ? [{ id: undefined, path: workspace.path }] : []
}

/** A failed Host call as the page sees it: the Host's error code, `host-outdated` for a route it does not have. */
function hostFailure(result) {
  if (result.status === 404 && (result.json?.error === undefined || result.json.error === 'not-found'))
    return { status: 'failed', code: 'host-outdated' }
  return { status: 'failed', code: typeof result.json?.error === 'string' ? result.json.error : 'host-failed' }
}

/** The Host's per-path refusals, in the page's shape. */
function hostRefusals(list) {
  if (!Array.isArray(list)) return []
  return list
    .filter(item => isPlainObject(item) && typeof item.path === 'string' && typeof item.code === 'string')
    .map(item => ({
      path: item.path,
      status: REFUSED_STATUS,
      code: item.code,
      ...(typeof item.message === 'string' ? { message: item.message } : {}),
    }))
}

/**
 * The folder actions behind `latchShell.folders`. Dependencies are injected so the checks run without Electron.
 * @param {object} options
 * @param {(method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>} options.request
 *   a Host API call with the shell's own credential (the proxy's `shellRequest`, which alone reaches the add routes)
 * @param {(body: Record<string, unknown>) => string} options.sign  the device signature of a folder add body
 * @param {(options: Electron.OpenDialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>} options.pick
 * @param {(options: Electron.MessageBoxOptions) => Promise<{ response: number }>} options.confirm
 * @param {(path: string) => void} options.show  shell.showItemInFolder; never openPath
 * @param {(path: string) => Promise<{ real: string; directory: boolean }>} options.inspect  realpath and stat
 * @param {() => string} options.home
 * @param {() => boolean} options.focused  whether the main window has focus; pick and drop need it
 * @param {{ enter(): boolean; leave(): void }} options.gate  one native dialog at a time, shared with external links
 * @param {() => number} [options.now]
 * @param {(message: string) => void} [options.log]
 */
function createFolderActions({ request, sign, pick, confirm, show, inspect, home, focused, gate, now = Date.now, log = () => {} }) {
  let lastParent
  let revealing = false
  let lastReveal = Number.NEGATIVE_INFINITY

  /** One native dialog at a time, with the window in front; failures come back as codes, never as thrown detail. */
  async function withDialog(run) {
    if (!focused()) return { status: 'failed', code: 'not-focused' }
    if (!gate.enter()) return { status: 'busy' }
    try {
      return await run()
    } catch (error) {
      log(`文件夹操作失败：${error instanceof Error ? error.message : '未知错误'}`)
      return { status: 'failed', code: 'shell-failed' }
    } finally {
      gate.leave()
    }
  }

  /** The project as the Host lists it, for the dialog's words and the folders it has; never from the renderer. */
  async function hostProject(projectId) {
    if (projectId === 'default') return { failure: { status: 'failed', code: 'workspace-default' } }
    const result = await request('GET', '/link/api/workspaces')
    if (result.status !== 200 || !Array.isArray(result.json?.workspaces)) return { failure: hostFailure(result) }
    const workspace = result.json.workspaces.find(item => isPlainObject(item) && item.id === projectId)
    if (!workspace) return { failure: { status: 'failed', code: 'not-found' } }
    return { project: workspace }
  }

  /** The nearest folder above `path` that exists (a re-selected folder is usually missing), else home. */
  async function nearestDirectory(path) {
    let current = nodePath.dirname(path)
    for (let depth = 0; depth < 128; depth++) {
      const found = await inspect(current).catch(() => undefined)
      if (found?.directory) return found.real
      const parent = nodePath.dirname(current)
      if (parent === current) break
      current = parent
    }
    return home()
  }

  /**
   * Adds `paths` over host.sock: a nonce, then the body signed with the device key. Folders the Host refuses come
   * back in `refused` (with `refused` from main's own checks first); `added` may be empty.
   * @param {{ project?: any; replace?: string; via: 'picker' | 'drop'; paths: string[]; refused: object[] }} input
   */
  async function submit({ project, replace, via, paths, refused }) {
    const grant = await request('POST', '/link/api/folder-grants', {})
    if (grant.status !== 200 || typeof grant.json?.nonce !== 'string') return hostFailure(grant)
    const body = { nonce: grant.json.nonce, via, paths, ...(replace ? { replace } : {}) }
    const signature = sign(body)
    const target = project ? `/link/api/workspaces/${encodeURIComponent(project.id)}/folders` : '/link/api/workspaces'
    const result = await request('POST', target, { ...body, signature })
    const workspace = result.json?.workspace
    if ((result.status === 200 || result.status === 201) && isPlainObject(workspace) && typeof workspace.id === 'string') {
      const before = new Set(project ? foldersOf(project).map(folder => folder.id) : [])
      const added = foldersOf(workspace)
        .filter(folder => (replace ? folder.id === replace : !before.has(folder.id)))
        .map(folder => ({ id: folder.id, path: folder.path, workspaceId: workspace.id }))
      return { status: 'added', workspaceId: workspace.id, added, refused: [...refused, ...hostRefusals(result.json.refused)] }
    }
    if (result.status === 409 && result.json?.error === 'workspace-folders-refused')
      return {
        status: 'added',
        ...(project ? { workspaceId: project.id } : {}),
        added: [],
        refused: [...refused, ...hostRefusals(result.json.refused)],
      }
    return hostFailure(result)
  }

  return {
    /** The native panel: a new project, more folders for `projectId`, or `replaceFolderId` chosen again. */
    pickFolders(input) {
      const parsed = parsePickInput(input)
      if (!parsed) return Promise.resolve({ status: 'failed', code: 'invalid' })
      return withDialog(async () => {
        let project
        let replacing
        if (parsed.projectId !== null) {
          const found = await hostProject(parsed.projectId)
          if (found.failure) return found.failure
          project = found.project
          if (parsed.replaceFolderId !== null) {
            replacing = foldersOf(project).find(folder => folder.id === parsed.replaceFolderId)
            if (!replacing || typeof replacing.path !== 'string') return { status: 'failed', code: 'not-found' }
          }
        }
        const defaultPath = replacing ? await nearestDirectory(replacing.path) : (lastParent ?? home())
        const chosen = await pick(
          pickDialog({
            defaultPath,
            ...(project ? { project: { name: project.name, remoteStart: project.remoteStart } } : {}),
            ...(replacing ? { replacing: { name: nodePath.basename(replacing.path) } } : {}),
          }),
        )
        const filePaths = Array.isArray(chosen?.filePaths) ? [...new Set(chosen.filePaths)] : []
        if (chosen?.canceled || filePaths.length === 0) return { status: 'canceled' }
        if (filePaths.length > (replacing ? 1 : FOLDER_LIMIT))
          return { status: 'failed', code: replacing ? 'invalid' : 'workspace-folder-limit' }
        const accepted = []
        const refused = []
        for (const path of filePaths) {
          const problem = pathProblem(path)
          if (problem === undefined) accepted.push(path)
          else
            refused.push(
              problem === 'invalid'
                ? { path, status: 400, code: 'workspace-invalid', message: INVALID_MESSAGE }
                : { path, status: 400, code: problem, message: UNPRINTABLE_MESSAGE },
            )
        }
        if (accepted.length > 0) lastParent = nodePath.dirname(accepted[0])
        if (accepted.length === 0) return { status: 'added', ...(project ? { workspaceId: project.id } : {}), added: [], refused }
        return submit({ project, replace: replacing?.id, via: 'picker', paths: accepted, refused })
      })
    },
    /** Folders dropped from Finder (paths the preload read from File objects), after the native confirmation. */
    dropFolders(input) {
      const parsed = parseDropInput(input)
      if ('error' in parsed) return Promise.resolve({ status: 'failed', code: parsed.error })
      return withDialog(async () => {
        let project
        if (parsed.projectId !== null) {
          const found = await hostProject(parsed.projectId)
          if (found.failure) return found.failure
          project = found.project
        }
        const { response } = await confirm(
          dropDialog({ paths: parsed.paths, ...(project ? { project: { name: project.name, remoteStart: project.remoteStart } } : {}) }),
        )
        if (response !== 0) return { status: 'canceled' }
        return submit({ project, via: 'drop', paths: parsed.paths, refused: [] })
      })
    },
    /**
     * 存为项目: the folder the Host made for a session becomes a new project's primary folder, after the native
     * confirmation shows it. The folder is the one the Host reports for the session, never one from the page.
     */
    saveSessionFolder(input) {
      const parsed = parseSaveSessionInput(input)
      if (!parsed) return Promise.resolve({ status: 'failed', code: 'invalid' })
      return withDialog(async () => {
        const found = await request('GET', `/link/api/tasks/${encodeURIComponent(parsed.sessionId)}`)
        if (found.status !== 200) return hostFailure(found)
        const summary = found.json?.summary
        if (!isPlainObject(summary) || summary.sessionFolder !== true || summary.workspaceId !== 'default')
          return { status: 'failed', code: 'session-folder-none' }
        if (pathProblem(summary.cwd) !== undefined) return { status: 'failed', code: 'invalid' }
        const { response } = await confirm(saveSessionDialog({ path: summary.cwd, title: summary.title }))
        if (response !== 0) return { status: 'canceled' }
        const grant = await request('POST', '/link/api/folder-grants', {})
        if (grant.status !== 200 || typeof grant.json?.nonce !== 'string') return hostFailure(grant)
        const body = { nonce: grant.json.nonce, via: 'session', sessionId: parsed.sessionId }
        const result = await request('POST', '/link/api/workspaces', { ...body, signature: sign(body) })
        const workspace = result.json?.workspace
        if (result.status === 201 && isPlainObject(workspace) && typeof workspace.id === 'string')
          return {
            status: 'added',
            workspaceId: workspace.id,
            added: foldersOf(workspace).map(folder => ({ id: folder.id, path: folder.path, workspaceId: workspace.id })),
            refused: [],
          }
        if (result.status === 409 && result.json?.error === 'workspace-folders-refused')
          return { status: 'added', added: [], refused: hostRefusals(result.json.refused) }
        return hostFailure(result)
      })
    },
    /**
     * Finder selects a folder the Host has registered (the primary one when `folderId` is null), by its real path.
     * Reveal only: Finder never opens or runs it. One at a time, at least 500 ms apart.
     */
    async revealFolder(input) {
      const parsed = parseRevealInput(input)
      if (!parsed) return { status: 'failed', code: 'invalid' }
      if (revealing || now() - lastReveal < REVEAL_INTERVAL_MS) return { status: 'busy' }
      revealing = true
      lastReveal = now()
      try {
        const result = await request('GET', '/link/api/workspaces')
        if (result.status !== 200 || !Array.isArray(result.json?.workspaces)) return hostFailure(result)
        const workspace = result.json.workspaces.find(item => isPlainObject(item) && item.id === parsed.projectId)
        const folders = workspace ? foldersOf(workspace) : []
        const folder = parsed.folderId === null ? folders[0] : folders.find(item => item.id === parsed.folderId)
        if (!folder) return { status: 'failed', code: 'not-found' }
        if (!isPathShaped(folder.path)) return { status: 'failed', code: 'invalid' }
        const found = await inspect(folder.path).catch(() => undefined)
        if (!found?.directory || !isPathShaped(found.real)) return { status: 'failed', code: 'missing' }
        show(found.real)
        return { status: 'shown' }
      } catch (error) {
        log(`无法在访达中显示文件夹：${error instanceof Error ? error.message : '未知错误'}`)
        return { status: 'failed', code: 'host-unavailable' }
      } finally {
        revealing = false
      }
    },
  }
}

module.exports = {
  FOLDER_LIMIT,
  REVEAL_INTERVAL_MS,
  isTrustedSender,
  parsePickInput,
  parseDropInput,
  parseRevealInput,
  parseSaveSessionInput,
  pickDialog,
  dropDialog,
  saveSessionDialog,
  createFolderActions,
}
