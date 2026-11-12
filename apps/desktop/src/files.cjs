'use strict'
// Files a message refers to, in the system's own tools: 在访达中显示 (shell.showItemInFolder), 快速查看 (Quick Look,
// BrowserWindow.previewFile), 用默认应用打开 (shell.openPath) and 在编辑器中打开 (the person's chosen editor, editors.cjs).
// The page sends only the session ID and the reference as the message wrote it (or a handle the Host gave); main asks
// the Host over host.sock with its own credential. The Host decides whether it is a regular file inside the session's
// folders and what may be done with it, records the action in the audit log, and only then gives main the real path.
// Main checks again before it calls the shell: the file is still a regular file at that real path, its type is on
// main's own allow-list, and its first bytes agree with its extension (text, for an editor). Never shell.openExternal,
// never a folder. The one application main starts is an editor from editors.cjs's allow-list, for the main window's
// `latch://app/` page after a real click or key there, through `/usr/bin/open -a <the checked bundle>` with a URL main builds
// from the editor's fixed template or the file's path as the only argument; never a program from PATH or the project.
// The type lists and header checks mirror apps/host/src/files/kinds.ts and sniff.ts; change them together.
const nodePath = require('node:path')
const { EDITOR_REFUSED_TYPES, lineOf } = require('./editors.cjs')

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/
const HANDLE = /^[A-Za-z0-9_-]{22}$/
const PATH_BYTES_LIMIT = 4096
/** Native actions: one at a time, at least this far apart. */
const ACTION_INTERVAL_MS = 500
/** Checks only read the Host's answer, so several run side by side (a double click, two chips); at most this many. */
const INSPECTIONS_LIMIT = 8
/** How many leading bytes main reads to compare the content with the extension. */
const HEAD_BYTES = 64 * 1024

/** Quick Look shows a file with whatever previewer the system has for its type, Apple's or another app's extension. */
const QUICK_LOOK_TYPES = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'heic',
  'tif',
  'tiff',
  'bmp',
  'mp3',
  'm4a',
  'wav',
  'aac',
  'flac',
  'mp4',
  'mov',
  'm4v',
  'key',
  'pages',
  'numbers',
  'csv',
  'tsv',
  'txt',
  'json',
  'log',
])
/** Office documents and Markdown can point at the network; Quick Look takes them once a check shows it fetches nothing. */
const PREVIEW_UNVERIFIED = new Set(['docx', 'pptx', 'xlsx', 'md'])
const OPEN_TYPES = new Set([...QUICK_LOOK_TYPES, ...PREVIEW_UNVERIFIED, 'yaml', 'yml', 'ipynb'])
const FAMILY_OF = Object.freeze({
  pdf: 'pdf',
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
  heic: 'heic',
  tif: 'tiff',
  tiff: 'tiff',
  bmp: 'bmp',
  mp3: 'mp3',
  m4a: 'isobmff',
  wav: 'wav',
  aac: 'aac',
  flac: 'flac',
  mp4: 'isobmff',
  mov: 'isobmff',
  m4v: 'isobmff',
  docx: 'zip',
  pptx: 'zip',
  xlsx: 'zip',
  key: 'zip',
  pages: 'zip',
  numbers: 'zip',
  csv: 'text',
  tsv: 'text',
  txt: 'text',
  md: 'text',
  json: 'text',
  log: 'text',
  yaml: 'text',
  yml: 'text',
  ipynb: 'text',
})

const isPlainObject = value =>
  value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))

function hasOnlyKeys(value, keys) {
  if (!isPlainObject(value)) return false
  const own = Object.keys(value)
  return own.length === keys.length && keys.every(key => own.includes(key))
}

const hasControl = text => {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** A reference as a message wrote it: 1–4096 bytes, no control characters. The Host does the rest. */
function isAcceptableReference(value) {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= PATH_BYTES_LIMIT && !hasControl(value)
}

/** `{ sessionId, path }` or `{ sessionId, handle }`, with exactly those keys; anything else is refused whole. */
function parseFileInput(input) {
  if (hasOnlyKeys(input, ['workspaceId', 'harnessId', 'handle'])) {
    if (
      typeof input.workspaceId !== 'string'
      || !/^[A-Za-z0-9_-]{1,64}$/.test(input.workspaceId)
      || typeof input.harnessId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/.test(input.harnessId)
      || typeof input.handle !== 'string'
      || !HANDLE.test(input.handle)
    )
      return undefined
    return { workspaceId: input.workspaceId, harnessId: input.harnessId, handle: input.handle }
  }
  if (hasOnlyKeys(input, ['sessionId', 'path'])) {
    if (typeof input.sessionId !== 'string' || !SESSION_ID.test(input.sessionId) || !isAcceptableReference(input.path)) return undefined
    return { sessionId: input.sessionId, path: input.path }
  }
  if (hasOnlyKeys(input, ['sessionId', 'handle'])) {
    if (typeof input.sessionId !== 'string' || !SESSION_ID.test(input.sessionId)) return undefined
    if (typeof input.handle !== 'string' || !HANDLE.test(input.handle)) return undefined
    return { sessionId: input.sessionId, handle: input.handle }
  }
  return undefined
}

/** References one question about which of them are files may carry: what one resolve request takes. */
const KNOWN_LIMIT = 64

/** `{ sessionId, paths }` with exactly those keys: 1–64 references as messages wrote them. */
function parseKnownInput(input) {
  if (!hasOnlyKeys(input, ['sessionId', 'paths'])) return undefined
  if (typeof input.sessionId !== 'string' || !SESSION_ID.test(input.sessionId)) return undefined
  const paths = input.paths
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > KNOWN_LIMIT || !paths.every(isAcceptableReference)) return undefined
  return { sessionId: input.sessionId, paths: [...new Set(paths)] }
}

/** The lowercased extension without its dot; '' without one (`Makefile`, `.env`). */
function extensionOf(name) {
  const dot = name.lastIndexOf('.')
  return dot <= 0 || dot === name.length - 1 ? '' : name.slice(dot + 1).toLowerCase()
}

const ascii = (bytes, offset, text) =>
  bytes.length >= offset + text.length && [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0))

function looksLikeText(bytes) {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return true
  const window = bytes.subarray(0, 8192)
  if (window.includes(0)) return false
  let end = window.length
  if (bytes.length > 8192) {
    let back = 0
    while (back < 3 && end - back - 1 >= 0 && (window[end - back - 1] & 0xc0) === 0x80) back++
    if (end - back - 1 >= 0 && window[end - back - 1] >= 0xc0) end -= back + 1
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(window.subarray(0, end))
    return true
  } catch {
    return false
  }
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'])
const QUICKTIME_ATOMS = ['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']

/** Whether `bytes`, the start of a file, look like the family its extension names. */
function matchesFamily(family, bytes) {
  switch (family) {
    case 'zip':
      return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
    case 'pdf':
      return ascii(bytes, 0, '%PDF-')
    case 'png':
      return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
    case 'jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    case 'gif':
      return ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')
    case 'webp':
      return ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')
    case 'heic':
      return ascii(bytes, 4, 'ftyp') && HEIC_BRANDS.has(String.fromCharCode(...bytes.subarray(8, 12)))
    case 'tiff':
      return (
        bytes.length >= 4
        && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00)
          || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
      )
    case 'bmp':
      return ascii(bytes, 0, 'BM')
    case 'mp3':
      return ascii(bytes, 0, 'ID3') || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
    case 'aac':
      return ascii(bytes, 0, 'ID3') || ascii(bytes, 0, 'ADIF') || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0)
    case 'flac':
      return ascii(bytes, 0, 'fLaC') || ascii(bytes, 0, 'ID3')
    case 'wav':
      return ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')
    case 'isobmff':
      return ascii(bytes, 4, 'ftyp') || QUICKTIME_ATOMS.some(atom => ascii(bytes, 4, atom))
    case 'text':
      return looksLikeText(bytes)
    default:
      return false
  }
}

/**
 * Whether this computer offers the action for a file of that extension: Quick Look and an editor only on macOS; opening
 * with the default application on macOS and Linux (Windows file associations are not checked yet, so it is not offered
 * there).
 */
function offeredHere(action, platform, ext) {
  if (action === 'reveal') return true
  if (action === 'editor') return platform === 'darwin' && !EDITOR_REFUSED_TYPES.has(ext)
  if (action === 'quicklook') return platform === 'darwin' && QUICK_LOOK_TYPES.has(ext)
  return (platform === 'darwin' || platform === 'linux') && OPEN_TYPES.has(ext)
}

/** An absolute real path from the Host: at most 4096 bytes, no NUL or other control character. */
function isAcceptableRealPath(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= PATH_BYTES_LIMIT
    && nodePath.isAbsolute(value)
    && !hasControl(value)
  )
}

const errorCodeOf = json => (typeof json?.error === 'string' && /^[a-z0-9-]{1,64}$/.test(json.error) ? json.error : undefined)

/**
 * What a failed resolve tells the page. A Host from before file actions has no such route (404 `not-found`): the
 * page says to restart it. Another refusal (the session's folder left the projects, the device lacks the scope) is a
 * refusal; a busy or broken Host is a failure.
 */
function resolveFailure({ status, json }) {
  const code = errorCodeOf(json)
  if (status === 404 && code === 'not-found') return { status: 'failed', code: 'host-outdated' }
  if (status >= 400 && status < 500 && status !== 429 && code !== undefined) return { status: 'refused', code }
  return { status: 'failed', code: code ?? 'host-unavailable' }
}

/**
 * The file actions behind `latchShell.files`. Dependencies are injected so the checks run without Electron.
 * @param {object} options
 * @param {(method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>} options.request
 *   a Host API call with the shell's own credential over host.sock
 * @param {(path: string) => void} options.show  e.g. shell.showItemInFolder
 * @param {(path: string, name: string) => void} options.quickLook  e.g. BrowserWindow#previewFile
 * @param {(path: string) => Promise<string>} options.open  e.g. shell.openPath ('' on success, else the error)
 * @param {(path: string, line?: number) => Promise<{ status: string; code?: string }>} [options.editor]
 *   editors.cjs's openPath: the chosen editor, or `refused` with `no-editor`
 * @param {(path: string) => Promise<{ real: string; file: boolean; symlink: boolean }>} options.inspect  lstat and realpath
 * @param {(path: string, bytes: number) => Promise<Uint8Array>} options.readHead  the file's first bytes
 * @param {string} options.platform  process.platform
 * @param {() => number} [options.now]
 * @param {(message: string) => void} [options.log]
 */
function createFileActions({ request, show, quickLook, open, editor, inspect, readHead, platform, now = Date.now, log = () => {} }) {
  let inspecting = 0
  let acting = false
  let lastAction = Number.NEGATIVE_INFINITY

  /** The Host's answer for one reference: `{ entry }` or a result to give the page as it is. */
  async function resolveOne(sessionId, path) {
    const result = await request('POST', `/link/api/tasks/${encodeURIComponent(sessionId)}/files/resolve`, { paths: [path] })
    const entry = Array.isArray(result.json?.files) ? result.json.files[0] : undefined
    if (result.status !== 200) return { result: resolveFailure(result) }
    if (!isPlainObject(entry)) return { result: { status: 'failed', code: 'host-unavailable' } }
    if (entry.status !== 'ok' || !isPlainObject(entry.file))
      return { result: { status: 'refused', code: errorCodeOf({ error: entry.code }) ?? 'file-invalid' } }
    return { entry }
  }

  /** What the page may offer for a reference: the file's name and which actions this computer has for it. */
  async function inspectFile(input) {
    const parsed = parseFileInput(input)
    if (!parsed || !('path' in parsed)) return { status: 'failed', code: 'invalid' }
    if (inspecting >= INSPECTIONS_LIMIT) return { status: 'busy' }
    inspecting++
    try {
      const { entry, result } = await resolveOne(parsed.sessionId, parsed.path)
      if (result) return result
      const file = entry.file
      const name = typeof file.name === 'string' ? file.name : ''
      const ext = extensionOf(name)
      const offered = action => file.actions?.[action] === true && offeredHere(action, platform, ext)
      const refusal = action => (offered(action) ? undefined : (errorCodeOf({ error: file.refused?.[action] }) ?? 'unsupported'))
      const refused = Object.fromEntries(
        [['quickLook', refusal('quicklook')], ['open', refusal('open')], ...(editor ? [['editor', refusal('editor')]] : [])].filter(
          ([, code]) => code !== undefined,
        ),
      )
      return {
        status: 'ok',
        name,
        actions: {
          reveal: offered('reveal'),
          quickLook: offered('quicklook'),
          open: offered('open'),
          ...(editor ? { editor: offered('editor') } : {}),
        },
        ...(Object.keys(refused).length > 0 ? { refused } : {}),
      }
    } catch {
      log('无法检查文件')
      return { status: 'failed', code: 'host-unavailable' }
    } finally {
      inspecting--
    }
  }

  /**
   * Which of a reply's references (inline code, a tool's targets) are files the Host would act on: the page learns
   * only that, as the references it sent, and draws a chip for those. Main asks once for the whole batch.
   */
  async function knownFiles(input) {
    const parsed = parseKnownInput(input)
    if (!parsed) return { status: 'failed', code: 'invalid' }
    if (inspecting >= INSPECTIONS_LIMIT) return { status: 'busy' }
    inspecting++
    try {
      const result = await request('POST', `/link/api/tasks/${encodeURIComponent(parsed.sessionId)}/files/resolve`, { paths: parsed.paths })
      if (result.status !== 200) return resolveFailure(result)
      const entries = Array.isArray(result.json?.files) ? result.json.files : []
      const found = new Set(entries.filter(entry => isPlainObject(entry) && entry.status === 'ok').map(entry => entry.input))
      return { status: 'ok', known: parsed.paths.filter(path => found.has(path)) }
    } catch {
      log('无法检查文件')
      return { status: 'failed', code: 'host-unavailable' }
    } finally {
      inspecting--
    }
  }

  /**
   * One native action: resolve (unless the page gave a handle), ask the Host for the real path (it audits first),
   * check the file again here, then call the shell.
   */
  async function act(action, input, line) {
    const parsed = parseFileInput(input)
    if (!parsed) return { status: 'failed', code: 'invalid' }
    if (acting || now() - lastAction < ACTION_INTERVAL_MS) return { status: 'busy' }
    acting = true
    lastAction = now()
    try {
      let handle = parsed.handle
      if (handle === undefined) {
        const { entry, result } = await resolveOne(parsed.sessionId, parsed.path)
        if (result) return result
        if (entry.file.actions?.[action] !== true)
          return { status: 'refused', code: errorCodeOf({ error: entry.file.refused?.[action] }) ?? 'file-type-refused' }
        if (typeof entry.file.handle !== 'string' || !HANDLE.test(entry.file.handle)) return { status: 'failed', code: 'host-unavailable' }
        handle = entry.file.handle
      }
      const answer = await request('POST', `/link/api/files/${handle}/local`, {
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : { workspaceId: parsed.workspaceId, harnessId: parsed.harnessId }),
        action,
      })
      if (answer.status !== 200) {
        const code = errorCodeOf(answer.json) ?? 'host-unavailable'
        return answer.status >= 400 && answer.status < 500 && answer.status !== 429
          ? { status: 'refused', code }
          : { status: 'failed', code }
      }
      const path = answer.json?.file?.path
      if (!isAcceptableRealPath(path)) return { status: 'failed', code: 'host-unavailable' }
      const name = nodePath.basename(path)
      const ext = extensionOf(name)
      if (!offeredHere(action, platform, ext)) return { status: 'refused', code: 'file-type-refused' }
      // Still the regular file the Host resolved, at its real path: not a folder, an app bundle or a symlink now.
      const found = await inspect(path).catch(() => undefined)
      if (!found || !found.file || found.symlink || found.real !== path) return { status: 'refused', code: 'file-changed' }
      if (action === 'editor') {
        if (!editor) return { status: 'refused', code: 'unsupported' }
        if (!matchesFamily('text', await readHead(path, HEAD_BYTES))) return { status: 'refused', code: 'file-not-text' }
        const opened = await editor(path, line)
        if (opened.status !== 'opened') log('无法用编辑器打开文件')
        return opened
      }
      if (action !== 'reveal' && !matchesFamily(FAMILY_OF[ext], await readHead(path, HEAD_BYTES)))
        return { status: 'refused', code: 'file-content-mismatch' }
      if (action === 'reveal') {
        show(path)
        return { status: 'shown' }
      }
      if (action === 'quicklook') {
        quickLook(path, name)
        return { status: 'shown' }
      }
      const failure = await open(path)
      if (failure) {
        log('无法用默认应用打开文件')
        return { status: 'failed', code: 'open-failed' }
      }
      return { status: 'opened' }
    } catch {
      log('文件操作失败')
      return { status: 'failed', code: 'shell-failed' }
    } finally {
      acting = false
    }
  }

  return {
    inspectFile,
    knownFiles,
    revealFile: input => act('reveal', input),
    quickLookFile: input => act('quicklook', input),
    openFile: input => act('open', input),
    /** `{ ...file input, line? }`: the line, when known, goes to an editor that takes one. */
    editorFile: input => {
      if (!isPlainObject(input) || !Object.hasOwn(input, 'line')) return act('editor', input)
      const { line, ...rest } = input
      if (line !== null && lineOf(line) === undefined) return Promise.resolve({ status: 'failed', code: 'invalid' })
      return act('editor', rest, line === null ? undefined : line)
    },
  }
}

module.exports = {
  ACTION_INTERVAL_MS,
  INSPECTIONS_LIMIT,
  QUICK_LOOK_TYPES,
  PREVIEW_UNVERIFIED,
  OPEN_TYPES,
  FAMILY_OF,
  parseFileInput,
  parseKnownInput,
  extensionOf,
  matchesFamily,
  offeredHere,
  createFileActions,
}
