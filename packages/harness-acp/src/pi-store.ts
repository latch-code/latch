/**
 * Latch's own bounded reads of pi's session store (pi 1.5.0 `docs/session-format.md`, `core/session-manager.js`) and of
 * the two facts it needs from pi's agent directory: where sessions are kept and whether a project is trusted. Nothing
 * here starts pi or calls anything of pi's, since pi creates directories as it lists and writes into a session as it
 * opens it. Every read is of one user's own regular files, opened without following a link, within a size bound; a
 * file that is anything else is skipped. The only write is `deletePiSessionFile`, which removes one session file.
 *
 * Only a Host started by the start script reads here (`AcpAgentOptions.cliStore`): test Hosts never touch real data.
 */
import { constants, type Stats } from 'node:fs'
import { lstat, open, readdir, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { z } from 'zod'

/** pi's own bound for a session's first line (`MAX_SESSION_HEADER_SCAN_BYTES`). */
const HEADER_BYTES = 1024 * 1024
/** What a listing reads of each file for its title: the start for the first message, the end for a later name. */
const TITLE_BYTES = 256 * 1024
/** A whole session read for its preview. */
const FILE_BYTES = 64 * 1024 * 1024
const LINE_BYTES = 16 * 1024 * 1024
/** One message's text kept for a preview. */
const MESSAGE_CHARS = 64 * 1024
const MAX_ENTRIES = 200_000
/** Settings and trust files are small; a larger one is not read. */
const SMALL_FILE = 1024 * 1024
/** At most this many project directories and session files are looked at in one listing. */
const MAX_DIRECTORIES = 2_000
const MAX_FILES = 5_000
/** `<time>_<id>.jsonl`, the name pi gives a session file. */
const SESSION_FILE = /^[0-9T:.\-Z]+_([A-Za-z0-9_-]{1,200})\.jsonl$/u

const header = z.object({
  type: z.literal('session'),
  version: z.number().int().optional(),
  id: z.string().min(1).max(200),
  timestamp: z.string().max(100).optional().catch(undefined),
  cwd: z.string().min(1).max(4096),
})
export type PiHeader = z.infer<typeof header>

/** What pi reads from the environment Latch starts it with, and the home it falls back on. */
export interface PiPlace {
  env: Readonly<Record<string, string | undefined>>
  home: string
  uid: number
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

/** pi's agent directory: `PI_CODING_AGENT_DIR`, or `~/.pi/agent` (pi 1.5.0 `config.js`). */
function piAgentDir(place: Pick<PiPlace, 'env' | 'home'>): string {
  const named = place.env.PI_CODING_AGENT_DIR
  return named ? resolve(expandHome(named, place.home)) : join(place.home, '.pi', 'agent')
}

/** pi's directory name for a session folder (`session-manager.js` `getDefaultSessionDirPath`); lossy, so never read back. */
export function piFolderName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`
}

async function ownDirectory(path: string, uid: number): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isDirectory() && !info.isSymbolicLink() && info.uid === uid
  } catch {
    return false
  }
}

/** One own regular file, opened without following a link, at most `limit` bytes; undefined for anything else. */
async function openOwn(path: string, uid: number, limit: number): Promise<{ handle: FileHandle; info: Stats } | undefined> {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return undefined
  }
  try {
    const info = await handle.stat()
    if (info.isFile() && info.uid === uid && info.size <= limit) return { handle, info }
  } catch {
    /* Closed below. */
  }
  await handle.close().catch(() => {})
  return undefined
}

async function readSmallJson(path: string, uid: number): Promise<unknown> {
  const opened = await openOwn(path, uid, SMALL_FILE)
  if (!opened) return undefined
  try {
    const text = (await opened.handle.readFile('utf8')).replace(/^﻿/u, '')
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  } finally {
    await opened.handle.close().catch(() => {})
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Only these keys of pi's global settings are read; the rest of the file is dropped as it is parsed. */
async function piSettings(place: PiPlace): Promise<{ sessionDir?: string; defaultProjectTrust?: string }> {
  const value = await readSmallJson(join(piAgentDir(place), 'settings.json'), place.uid)
  if (!isRecord(value)) return {}
  return {
    ...(typeof value.sessionDir === 'string' && value.sessionDir ? { sessionDir: value.sessionDir } : {}),
    ...(typeof value.defaultProjectTrust === 'string' ? { defaultProjectTrust: value.defaultProjectTrust } : {}),
  }
}

/**
 * Where pi keeps the sessions of a process Latch starts: `PI_CODING_AGENT_SESSION_DIR`, else the global `sessionDir`
 * setting (both flat, one directory for every folder), else `<agent dir>/sessions/<folder name>/`. A project's own
 * `.pi/settings.json` may name another directory when pi trusts the project; those sessions are not found here.
 */
export async function piSessionRoot(place: PiPlace): Promise<{ root: string; flat: boolean } | undefined> {
  const named = place.env.PI_CODING_AGENT_SESSION_DIR
  if (named) {
    const path = expandHome(named, place.home)
    return isAbsolute(path) ? { root: resolve(path), flat: true } : undefined
  }
  const setting = (await piSettings(place)).sessionDir
  if (setting) {
    const path = expandHome(setting, place.home)
    return isAbsolute(path) ? { root: resolve(path), flat: true } : undefined
  }
  return { root: join(piAgentDir(place), 'sessions'), flat: false }
}

/** Lines of `text`, the last one only when `complete`. */
function linesOf(text: string, complete: boolean): string[] {
  const lines = text.split('\n')
  if (!complete) lines.pop()
  return lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line)).filter(line => line.trim())
}

async function readSlice(handle: FileHandle, start: number, length: number): Promise<string> {
  if (length <= 0) return ''
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, start)
  return buffer.subarray(0, bytesRead).toString('utf8')
}

/** The file's first line as a pi session header, with the file's ID from its name when it has pi's shape. */
async function readHeaderOf(handle: FileHandle, size: number): Promise<PiHeader | undefined> {
  const head = await readSlice(handle, 0, Math.min(size, HEADER_BYTES))
  const newline = head.indexOf('\n')
  const first = newline >= 0 ? head.slice(0, newline) : size <= HEADER_BYTES ? head : ''
  try {
    const parsed = header.safeParse(JSON.parse(first))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** The ID in a session file's name, when the name is pi's. */
export function piFileId(path: string): string | undefined {
  return SESSION_FILE.exec(basename(path))?.[1]
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap(block => {
      if (!isRecord(block)) return []
      if (block.type === 'text' && typeof block.text === 'string') return [block.text]
      if (block.type === 'image') return ['[图片]']
      return []
    })
    .join('')
}

/** A session's title as pi shows it: its latest name, else its first message of the person's. */
function titleFrom(lines: readonly string[]): { name?: string; first?: string } {
  let name: string | undefined
  let first: string | undefined
  for (const line of lines) {
    if (!line.includes('"session_info"') && !line.includes('"user"')) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(value)) continue
    if (value.type === 'session_info') name = typeof value.name === 'string' ? value.name.trim() || undefined : undefined
    else if (first === undefined && value.type === 'message' && isRecord(value.message) && value.message.role === 'user') {
      const text = textOf(value.message.content).replace(/\s+/gu, ' ').trim()
      if (text) first = text
    }
  }
  return { ...(name !== undefined ? { name } : {}), ...(first !== undefined ? { first } : {}) }
}

export interface PiListed {
  path: string
  cwd: string
  title?: string
  updatedAt: string
}

/** Whether `cwd` is `root` or below it, by its words: the Host checks the real path before anything is loaded. */
function within(cwd: string, root: string): boolean {
  const base = resolve(root)
  const path = resolve(cwd)
  return path === base || path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/** One session file as a listing row, or undefined when it is not a session of pi's that this reads. */
async function listedFile(path: string, uid: number): Promise<{ header: PiHeader; title?: string; updatedAt: string } | undefined> {
  const id = piFileId(path)
  if (!id) return undefined
  const opened = await openOwn(path, uid, Number.MAX_SAFE_INTEGER)
  if (!opened) return undefined
  const { handle, info } = opened
  try {
    const read = await readHeaderOf(handle, info.size)
    // Version 3 is what pi 1.x writes; it migrates an older file by rewriting it, which an import must not cause.
    if (!read || read.id !== id || read.version !== 3 || !isAbsolute(read.cwd)) return undefined
    const head = await readSlice(handle, 0, Math.min(info.size, TITLE_BYTES))
    const tailStart = Math.max(0, info.size - TITLE_BYTES)
    const tail = tailStart > TITLE_BYTES ? await readSlice(handle, tailStart, info.size - tailStart) : ''
    const fromHead = titleFrom(linesOf(head, info.size <= TITLE_BYTES))
    // The first line of the tail may be cut, so it is left out.
    const fromTail = tail ? titleFrom(linesOf(tail, true).slice(1)) : {}
    const title = (fromTail.name ?? fromHead.name ?? fromHead.first)?.slice(0, 400)
    return { header: read, ...(title ? { title } : {}), updatedAt: info.mtime.toISOString() }
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * pi's sessions whose recorded folder is one of `roots` or below it, newest first. In pi's default layout only the
 * directories named like a root (or a folder below it) are opened; the name is lossy, so the header's `cwd` decides.
 */
export async function listPiSessions(
  place: PiPlace,
  roots: readonly string[],
  limit: number,
): Promise<{ sessions: PiListed[]; truncated: boolean }> {
  const store = await piSessionRoot(place)
  if (!store || !(await ownDirectory(store.root, place.uid)) || !roots.length) return { sessions: [], truncated: false }
  const directories: string[] = []
  if (store.flat) directories.push(store.root)
  else {
    const prefixes = roots.map(root => piFolderName(resolve(root)).slice(0, -2))
    let names: string[]
    try {
      names = await readdir(store.root)
    } catch {
      names = []
    }
    for (const name of names.toSorted()) {
      if (directories.length >= MAX_DIRECTORIES) break
      if (!prefixes.some(prefix => name === `${prefix}--` || name.startsWith(`${prefix}-`))) continue
      const path = join(store.root, name)
      if (await ownDirectory(path, place.uid)) directories.push(path)
    }
  }
  const files: string[] = []
  let truncated = false
  for (const directory of directories) {
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      if (files.length >= MAX_FILES) {
        truncated = true
        break
      }
      files.push(join(directory, name))
    }
  }
  const sessions: PiListed[] = []
  for (const path of files) {
    const read = await listedFile(path, place.uid)
    if (!read || !roots.some(root => within(read.header.cwd, root))) continue
    sessions.push({ path, cwd: read.header.cwd, ...(read.title ? { title: read.title } : {}), updatedAt: read.updatedAt })
  }
  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  if (sessions.length > limit) {
    truncated = true
    sessions.length = limit
  }
  return { sessions, truncated }
}

/** The header of one session file, opened as `openOwn` does; undefined for a file that is not a session of pi's. */
export async function readPiHeader(path: string, uid: number): Promise<PiHeader | undefined> {
  if (!isAbsolute(path) || path.includes('\0')) return undefined
  const opened = await openOwn(path, uid, Number.MAX_SAFE_INTEGER)
  if (!opened) return undefined
  try {
    return await readHeaderOf(opened.handle, opened.info.size)
  } catch {
    return undefined
  } finally {
    await opened.handle.close().catch(() => {})
  }
}

interface Kept {
  id: string
  parentId: string | null
  type: string
  role?: string
  text?: string
  tools?: Array<{ id: string; name: string; args: unknown }>
  toolCallId?: string
  toolName?: string
  isError?: boolean
  at?: string
}

/** ACP session updates, as an agent's replay would send them, with the time each was written. */
export interface PiReplay {
  updates: Array<{ update: { sessionUpdate: string } & Record<string, unknown>; at: string }>
  model?: string
}

const TOOL_KINDS: Readonly<Record<string, string>> = {
  read: 'read',
  edit: 'edit',
  write: 'edit',
  bash: 'execute',
  grep: 'search',
  find: 'search',
  ls: 'search',
}

function toolTitle(tool: string, args: unknown): string {
  const input = isRecord(args) ? args : {}
  const subject = [input.command, input.path, input.pattern].find(value => typeof value === 'string' && value.trim())
  return (typeof subject === 'string' ? `${tool} ${subject}` : tool).slice(0, 500)
}

function keptEntry(value: Record<string, unknown>): Kept | undefined {
  if (typeof value.id !== 'string' || (value.parentId !== null && typeof value.parentId !== 'string') || typeof value.type !== 'string')
    return undefined
  const kept: Kept = {
    id: value.id,
    parentId: value.parentId as string | null,
    type: value.type,
    ...(typeof value.timestamp === 'string' ? { at: value.timestamp.slice(0, 100) } : {}),
  }
  if (value.type === 'model_change' && typeof value.provider === 'string' && typeof value.modelId === 'string')
    kept.text = `${value.provider}/${value.modelId}`.slice(0, 600)
  if (value.type !== 'message' || !isRecord(value.message)) return kept
  const message = value.message
  if (typeof message.role !== 'string') return kept
  kept.role = message.role
  if (message.role === 'user' || message.role === 'assistant') kept.text = textOf(message.content).slice(0, MESSAGE_CHARS)
  if (message.role === 'assistant' && Array.isArray(message.content))
    kept.tools = message.content.flatMap(block =>
      isRecord(block) && block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string'
        ? [{ id: block.id.slice(0, 256), name: block.name.slice(0, 256), args: isRecord(block.arguments) ? block.arguments : {} }]
        : [],
    )
  if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
    kept.toolCallId = message.toolCallId.slice(0, 256)
    if (typeof message.toolName === 'string') kept.toolName = message.toolName.slice(0, 256)
    kept.isError = message.isError === true
  }
  return kept
}

/** Splits a stream of chunks into lines, giving up on a line longer than the bound. */
async function eachLine(handle: FileHandle, size: number, take: (line: string) => boolean): Promise<boolean> {
  let pending: Buffer[] = []
  let pendingBytes = 0
  const chunk = Buffer.alloc(1024 * 1024)
  for (let position = 0; position < size;) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position)
    if (!bytesRead) break
    position += bytesRead
    let start = 0
    const data = chunk.subarray(0, bytesRead)
    for (let newline = data.indexOf(0x0a); newline !== -1; newline = data.indexOf(0x0a, start)) {
      const piece = data.subarray(start, newline)
      start = newline + 1
      if (pendingBytes + piece.length > LINE_BYTES) return false
      const line = pendingBytes ? Buffer.concat([...pending, piece]) : piece
      pending = []
      pendingBytes = 0
      const text = line.toString('utf8').trim()
      if (text && !take(text)) return false
    }
    if (start < data.length) {
      const rest = Buffer.from(data.subarray(start))
      if (pendingBytes + rest.length > LINE_BYTES) return false
      pending.push(rest)
      pendingBytes += rest.length
    }
  }
  const last = Buffer.concat(pending).toString('utf8').trim()
  return !last || take(last)
}

/**
 * One session file read in full within its bounds, as the updates a replay would send: the branch pi is on (from the
 * last entry back along `parentId`), its messages of the person's and the model's as text, and each tool call by its
 * name and how it ended. Undefined when the file is not a version 3 session of `cwd` or is past a bound.
 */
export async function readPiSession(path: string, uid: number, cwd: string): Promise<PiReplay | undefined> {
  const id = piFileId(path)
  if (!id || !isAbsolute(path)) return undefined
  const opened = await openOwn(path, uid, FILE_BYTES)
  if (!opened) return undefined
  const { handle, info } = opened
  const byId = new Map<string, Kept>()
  let last: string | undefined
  let first = true
  let ok = false
  try {
    ok = await eachLine(handle, info.size, line => {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        // pi itself skips a line it cannot parse.
        return true
      }
      if (first) {
        first = false
        const read = header.safeParse(value)
        return read.success && read.data.id === id && read.data.version === 3 && resolve(read.data.cwd) === resolve(cwd)
      }
      if (!isRecord(value)) return true
      const kept = keptEntry(value)
      if (!kept) return true
      if (byId.size >= MAX_ENTRIES) return false
      byId.set(kept.id, kept)
      last = kept.id
      return true
    })
  } catch {
    ok = false
  } finally {
    await handle.close().catch(() => {})
  }
  if (!ok || first) return undefined
  const branch: Kept[] = []
  for (let at = last; at !== undefined && branch.length <= byId.size;) {
    const entry = byId.get(at)
    if (!entry) break
    branch.push(entry)
    at = entry.parentId ?? undefined
  }
  branch.reverse()
  const updates: PiReplay['updates'] = []
  const fallback = info.mtime.toISOString()
  let model: string | undefined
  let messageCount = 0
  for (const entry of branch) {
    const at = entry.at ?? fallback
    if (entry.type === 'model_change' && entry.text) model = entry.text
    if (entry.type !== 'message') continue
    if ((entry.role === 'user' || entry.role === 'assistant') && entry.text)
      updates.push({
        at,
        update: {
          sessionUpdate: entry.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          messageId: `pi-${++messageCount}`,
          content: { type: 'text', text: entry.text },
        },
      })
    for (const tool of entry.tools ?? [])
      updates.push({
        at,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: tool.id,
          title: toolTitle(tool.name, tool.args),
          kind: TOOL_KINDS[tool.name] ?? 'other',
          status: 'in_progress',
        },
      })
    if (entry.role === 'toolResult' && entry.toolCallId)
      updates.push({
        at,
        update: { sessionUpdate: 'tool_call_update', toolCallId: entry.toolCallId, status: entry.isError ? 'failed' : 'completed' },
      })
  }
  return { updates, ...(model ? { model } : {}) }
}

/**
 * Removes one session file of pi's, the whole of that session's record (pi's own documented way to delete one): only an
 * own regular file with pi's name, in an own real directory under pi's session store, whose header names the ID in its
 * name and the folder `cwd`, and that is still the file checked when it goes. Anything else is left; the answer says
 * whether it went.
 */
export async function deletePiSessionFile(path: string, cwd: string, place: PiPlace): Promise<boolean> {
  if (!isAbsolute(path) || path.includes('\0') || resolve(path) !== path) return false
  const id = piFileId(path)
  if (!id) return false
  const store = await piSessionRoot(place)
  const directory = dirname(path)
  if (!store) return false
  // Its own directory: the flat store itself, or one folder's directory directly in it.
  if (store.flat ? directory !== store.root : dirname(directory) !== store.root) return false
  if (!(await ownDirectory(store.root, place.uid)) || !(await ownDirectory(directory, place.uid))) return false
  const opened = await openOwn(path, place.uid, Number.MAX_SAFE_INTEGER)
  if (!opened) return false
  try {
    const read = await readHeaderOf(opened.handle, opened.info.size)
    if (!read || read.id !== id || resolve(read.cwd) !== resolve(cwd)) return false
    const now = await lstat(path)
    if (!now.isFile() || now.isSymbolicLink() || now.dev !== opened.info.dev || now.ino !== opened.info.ino) return false
    await unlink(path)
    return true
  } catch {
    return false
  } finally {
    await opened.handle.close().catch(() => {})
  }
}

/**
 * Whether pi loads a project's own `.pi` settings, extensions, MCP servers and skills when Latch starts it in `cwd`: the
 * nearest decision in pi's `trust.json` for `cwd` or a folder above it, else the global `defaultProjectTrust`. pi's RPC
 * mode has nobody to ask, so `ask` and no setting are both not trusted (pi 1.5.0 `project-trust.js`).
 */
export async function piProjectTrust(place: PiPlace, cwd: string): Promise<'trusted' | 'untrusted'> {
  const file = await readSmallJson(join(piAgentDir(place), 'trust.json'), place.uid)
  if (isRecord(file)) {
    for (let at = resolve(cwd); ; at = dirname(at)) {
      const decision = file[at]
      if (decision === true) return 'trusted'
      if (decision === false) return 'untrusted'
      if (dirname(at) === at) break
    }
  }
  return (await piSettings(place)).defaultProjectTrust === 'always' ? 'trusted' : 'untrusted'
}
