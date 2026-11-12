'use strict'
// 在编辑器中打开: the person's own code editor on this Mac, for a file the Host has already checked and audited (see
// files.cjs). The editors come from a fixed allow-list of bundle IDs, found as application bundles in the usual
// folders; main remembers the one the person chose. A launch is `/usr/bin/open -a <that checked bundle> <target>`, run without a
// shell, where the target is either a URL main builds from the editor's fixed template (the absolute path encoded
// segment by segment, and the line) or the file's absolute path as the only argument. Never a program found on PATH,
// never a file from the project, never a folder.
const { constants } = require('node:fs')
const { lstat, mkdir, open, rename, rm } = require('node:fs/promises')
const { randomUUID } = require('node:crypto')
const nodePath = require('node:path')

/**
 * The editors Latch knows. `scheme`: the editor documents `<scheme>://file/<absolute path>:<line>`; without it the file
 * is handed over as an argument and the line is not passed.
 */
const EDITORS = Object.freeze(
  [
    { id: 'vscode', name: 'VS Code', bundleIds: ['com.microsoft.VSCode'], scheme: 'vscode', app: /^Visual Studio Code\.app$/u },
    {
      id: 'vscode-insiders',
      name: 'VS Code Insiders',
      bundleIds: ['com.microsoft.VSCodeInsiders'],
      scheme: 'vscode-insiders',
      app: /^Visual Studio Code - Insiders\.app$/u,
    },
    { id: 'cursor', name: 'Cursor', bundleIds: ['com.todesktop.230313mzl4w4u92'], scheme: 'cursor', app: /^Cursor\.app$/u },
    { id: 'windsurf', name: 'Windsurf', bundleIds: ['com.exafunction.windsurf'], scheme: 'windsurf', app: /^Windsurf\.app$/u },
    { id: 'zed', name: 'Zed', bundleIds: ['dev.zed.Zed', 'dev.zed.Zed-Preview'], scheme: 'zed', app: /^Zed( Preview)?\.app$/u },
    { id: 'sublime', name: 'Sublime Text', bundleIds: ['com.sublimetext.4', 'com.sublimetext.3'], app: /^Sublime Text\.app$/u },
    {
      id: 'intellij',
      name: 'IntelliJ IDEA',
      bundleIds: ['com.jetbrains.intellij', 'com.jetbrains.intellij.ce'],
      app: /^IntelliJ IDEA.*\.app$/u,
    },
    { id: 'webstorm', name: 'WebStorm', bundleIds: ['com.jetbrains.WebStorm'], app: /^WebStorm.*\.app$/u },
    { id: 'goland', name: 'GoLand', bundleIds: ['com.jetbrains.goland'], app: /^GoLand.*\.app$/u },
    { id: 'pycharm', name: 'PyCharm', bundleIds: ['com.jetbrains.pycharm', 'com.jetbrains.pycharm.ce'], app: /^PyCharm.*\.app$/u },
    { id: 'xcode', name: 'Xcode', bundleIds: ['com.apple.dt.Xcode'], app: /^Xcode.*\.app$/u },
    { id: 'nova', name: 'Nova', bundleIds: ['com.panic.Nova'], app: /^Nova\.app$/u },
  ].map(editor => Object.freeze({ ...editor, bundleIds: Object.freeze(editor.bundleIds) })),
)
/** Project files an editor evaluates or imports when it opens them: never handed to that editor. */
const JETBRAINS_RUNS = new Set(['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'])
const RUNS_ON_OPEN = Object.freeze({
  xcode: new Set(['Package.swift']),
  intellij: JETBRAINS_RUNS,
  webstorm: JETBRAINS_RUNS,
  goland: JETBRAINS_RUNS,
  pycharm: JETBRAINS_RUNS,
})
const EDITOR_ID = /^[a-z][a-z-]{0,31}$/u
/** Project and workspace definitions an editor opens with their settings and tasks. Mirrors apps/host/src/files/resolve.ts. */
const EDITOR_REFUSED_TYPES = new Set(['code-workspace', 'sublime-project', 'sublime-workspace', 'ipr', 'iws', 'iml'])
const PATH_BYTES_LIMIT = 4096
const LINE_LIMIT = 10_000_000
/** How long one detection answers before the folders are looked at again. */
const DETECTION_MS = 30_000

const editorById = id => (typeof id === 'string' ? EDITORS.find(editor => editor.id === id) : undefined)

/** A line as the page may send it: a whole number from 1; anything else means no line. */
const lineOf = value => (Number.isSafeInteger(value) && value >= 1 && value <= LINE_LIMIT ? value : undefined)

/**
 * An absolute, normalized path main may hand to an editor: at most 4096 bytes, no control characters (C0, DEL, C1) and
 * no line or paragraph separators, so neither a URL nor an argument can carry a second line or a hidden one.
 */
function isEditorPath(path) {
  if (typeof path !== 'string' || path.length === 0 || Buffer.byteLength(path, 'utf8') > PATH_BYTES_LIMIT) return false
  if (!nodePath.posix.isAbsolute(path) || nodePath.posix.normalize(path) !== path || path.endsWith('/')) return false
  return !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(path)
}

/** `<scheme>://file/<segments, each percent-encoded>[:<line>]`: spaces, `#`, `%`, `?`, `:` and non-ASCII all encoded. */
function editorUrl(scheme, path, line) {
  const encoded = path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
  return `${scheme}://file${encoded}${line === undefined ? '' : `:${line}`}`
}

/** An application bundle main found: an absolute `.app` path without control characters. */
const isAppPath = path => isEditorPath(path) && path.endsWith('.app')

/**
 * What `/usr/bin/open` gets to start `editor` at `appPath` (the bundle main found and checked) on `path`: `-a <app>` then
 * one target, the editor's URL or the file's path. `{ code }` when it must not be opened there.
 *
 * VS Code, Cursor and Windsurf read every `:<number>` segment of a `…://file/` path as a position (an empty one counts as
 * 0) and then normalise the rest, so a name with a colon could open another file or a folder: such a path goes as a
 * plain argument, which their macOS open-file handler opens with `gotoLineMode: false` (vscode app.ts), without the
 * line. Zed parses positions (`:n`, `(n)`, `(n,m)`) from plain paths and URLs alike, so those names are refused.
 */
function launchPlan(editor, app, path, line) {
  if (!editor || !app || !editor.bundleIds.includes(app.bundleId) || !isAppPath(app.path) || !isEditorPath(path))
    return { code: 'file-invalid' }
  if (RUNS_ON_OPEN[editor.id]?.has(nodePath.posix.basename(path))) return { code: 'file-type-refused' }
  if (editor.id === 'zed' && (path.includes(':') || /\(\d+(?:,\d+)?\)$/u.test(path))) return { code: 'file-name-refused' }
  const target = editor.scheme && !path.includes(':') ? editorUrl(editor.scheme, path, lineOf(line)) : path
  return { args: ['-a', app.path, target] }
}

/** The arguments alone, or undefined when the plan refuses. */
const launchArgs = (editor, app, path, line) => launchPlan(editor, app, path, line).args

/**
 * The editors installed here: for each, the first bundle in the application folders whose name looks like it and whose
 * Info.plist names one of its bundle IDs.
 * @param {{ listApps(): Promise<string[]>; bundleIdOf(appPath: string): Promise<string | undefined> }} io
 */
async function detectEditors({ listApps, bundleIdOf }) {
  const apps = await listApps().catch(() => [])
  const found = []
  for (const editor of EDITORS) {
    for (const appPath of apps) {
      if (!editor.app.test(nodePath.basename(appPath))) continue
      const bundleId = await bundleIdOf(appPath).catch(() => undefined)
      if (typeof bundleId === 'string' && editor.bundleIds.includes(bundleId)) {
        found.push({ id: editor.id, name: editor.name, bundleId, path: appPath })
        break
      }
    }
  }
  return found
}

/** The remembered choice, `{ version: 1, editor }`; anything else reads as none. */
async function readEditorChoice(directory) {
  let fd
  try {
    const path = nodePath.join(directory, 'editor.json')
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024) return null
    fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = await fd.stat()
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) return null
    const value = JSON.parse((await fd.readFile()).subarray(0, 1024).toString('utf8'))
    const keys = value && typeof value === 'object' ? Object.keys(value) : []
    return keys.length === 2 && value.version === 1 && editorById(value.editor) ? value.editor : null
  } catch {
    return null
  } finally {
    await fd?.close()
  }
}

async function writeEditorChoice(directory, id) {
  if (!editorById(id)) throw new Error('invalid-editor')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = nodePath.join(directory, '.editor-' + randomUUID())
  let fd
  try {
    fd = await open(temporary, 'wx', 0o600)
    await fd.writeFile(JSON.stringify({ version: 1, editor: id }) + '\n')
    await fd.sync()
    await fd.close()
    fd = undefined
    await rename(temporary, nodePath.join(directory, 'editor.json'))
  } finally {
    await fd?.close()
    await rm(temporary, { force: true })
  }
}

/**
 * `latchShell.editors` and the launch behind `latchShell.files.editor`. Dependencies are injected so tests never look
 * at real applications or start one.
 * @param {object} options
 * @param {() => Promise<string[]>} options.listApps  application bundles in the fixed folders
 * @param {(appPath: string) => Promise<string | undefined>} options.bundleIdOf  CFBundleIdentifier from Info.plist
 * @param {(args: string[]) => Promise<void>} options.launch  execFile('/usr/bin/open', args), no shell
 * @param {() => Promise<string | null>} options.readChoice
 * @param {(id: string) => Promise<void>} options.writeChoice
 * @param {string} options.platform
 * @param {() => number} [options.now]
 */
function createEditors({ listApps, bundleIdOf, launch, readChoice, writeChoice, platform, now = Date.now }) {
  let detected
  let chosen
  const installed = async () => {
    if (platform !== 'darwin') return []
    if (!detected || now() - detected.at > DETECTION_MS) detected = { at: now(), list: detectEditors({ listApps, bundleIdOf }) }
    return detected.list
  }
  const choice = async () => {
    if (chosen === undefined) chosen = await readChoice().catch(() => null)
    return chosen
  }

  /** What 设置 and the menus show: the editors found here and the one chosen, if it is still installed. */
  async function list() {
    const editors = await installed()
    const id = await choice()
    return {
      status: 'ok',
      editors: editors.map(editor => ({ id: editor.id, name: editor.name })),
      chosen: editors.some(editor => editor.id === id) ? id : null,
    }
  }

  async function choose(id) {
    if (typeof id !== 'string' || !EDITOR_ID.test(id) || !editorById(id)) return { status: 'failed', code: 'invalid' }
    if (!(await installed()).some(editor => editor.id === id)) return { status: 'refused', code: 'no-editor' }
    await writeChoice(id)
    chosen = id
    return list()
  }

  /** Opens `path`, already checked by the Host and by main, in the chosen editor; `refused` when there is none. */
  async function openPath(path, line) {
    const id = await choice()
    const editor = (await installed()).find(item => item.id === id)
    if (!editor) return { status: 'refused', code: 'no-editor' }
    const plan = launchPlan(editorById(editor.id), { bundleId: editor.bundleId, path: editor.path }, path, line)
    if (!plan.args) return { status: 'refused', code: plan.code }
    await launch(plan.args)
    return { status: 'opened' }
  }

  return { list, choose, openPath, refusedType: ext => EDITOR_REFUSED_TYPES.has(ext) }
}

module.exports = {
  EDITORS,
  EDITOR_REFUSED_TYPES,
  editorById,
  isEditorPath,
  editorUrl,
  launchArgs,
  launchPlan,
  RUNS_ON_OPEN,
  lineOf,
  detectEditors,
  readEditorChoice,
  writeEditorChoice,
  createEditors,
}
