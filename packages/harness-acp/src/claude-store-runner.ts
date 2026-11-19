/**
 * Latch's reader of Claude Code's own store: its session transcripts, its settings and its registry of running processes.
 * The Claude Agent SDK's session functions read `CLAUDE_CONFIG_DIR` from the process they run in, so the Host never calls
 * them: `claude-store.ts` starts this file with Node, in a process group of its own and with the environment the session's
 * `claude` gets, and so it reads the same store `claude` writes. One JSON request on stdin, one JSON answer on stdout.
 * Node runs it as it is from the package's sources (type stripping only) and from `dist/harness/claude-store-runner.js`
 * in a build.
 *
 * - Never read: Claude's login (credentials, the keychain) and the registry's `.key` files. Settings leave as facts
 *   (booleans, rule texts, numbers, model names), never an `env` value or a command.
 * - Written: only what the request names — a fork of one session (`forkSession`), the deletion of one (`deleteSession`).
 */
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HELP = `latch-claude-store: reads Claude Code's own store for Latch. One JSON request on stdin, one JSON answer on stdout.
Requests: list, info, messages, fork, delete, settings, busy.
`

if (process.argv.includes('--help')) {
  process.stdout.write(HELP)
  process.exit(0)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const MAX_TEXT = 200_000
const MAX_RULES = 40
/** The commands Claude Code runs itself, never a prompt of the person's: a replay leaves them out (as the adapter). */
const NOT_FOUND = /not found|no such|ENOENT/iu

type Json = Record<string, unknown>

interface Sdk {
  listSessions(options: Json): Promise<Json[]>
  getSessionInfo(id: string, options: Json): Promise<Json | undefined>
  getSessionMessages(id: string, options: Json): Promise<Json[]>
  forkSession(id: string, options: Json): Promise<{ sessionId: string }>
  deleteSession(id: string, options: Json): Promise<void>
  importSessionToStore(id: string, store: Json, options: Json): Promise<void>
  resolveSettings(options: Json): Promise<{ effective: Json; provenance: Json; sources: Array<{ source: string; settings?: Json }> }>
  filterEscalatingDefaultMode(resolved: unknown): Json
}

let loaded: Sdk | undefined
async function sdk(): Promise<Sdk> {
  // A variable, so a bundler leaves the import to run time: the package is resolved where this file is.
  const specifier = '@anthropic-ai/claude-agent-sdk'
  loaded ??= (await import(specifier)) as Sdk
  return loaded
}

class Refused extends Error {}

const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text)
const str = (value: unknown, limit = 4096) => (typeof value === 'string' ? clip(value, limit) : undefined)

function sessionId(request: Json, field = 'sessionId'): string {
  const value = request[field]
  if (typeof value !== 'string' || !UUID.test(value)) throw new Refused(`${field} is not a session ID`)
  return value
}

function dirOf(request: Json): string | undefined {
  return typeof request.dir === 'string' && request.dir.startsWith('/') ? request.dir : undefined
}

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** One block of a message as Latch reads it: words, tool calls and results; an image's bytes never leave. */
function block(value: unknown): Json | undefined {
  if (typeof value === 'string') return { type: 'text', text: clip(value, MAX_TEXT) }
  if (!isRecord(value)) return undefined
  switch (value.type) {
    case 'text':
      return typeof value.text === 'string' ? { type: 'text', text: clip(value.text, MAX_TEXT) } : undefined
    case 'tool_use':
      return typeof value.id === 'string' && typeof value.name === 'string'
        ? { type: 'tool_use', id: value.id, name: clip(value.name, 200), input: value.input ?? {} }
        : undefined
    case 'tool_result': {
      if (typeof value.tool_use_id !== 'string') return undefined
      const content = Array.isArray(value.content) ? value.content.map(block).filter(item => item !== undefined) : block(value.content)
      return { type: 'tool_result', tool_use_id: value.tool_use_id, is_error: value.is_error === true, content: content ?? [] }
    }
    case 'image':
    case 'document':
      return { type: value.type }
    default:
      return undefined
  }
}

/** A message of the transcript, cut to what a replay shows. */
function compact(message: Json): Json | undefined {
  const said = isRecord(message.message) ? message.message : {}
  const content = typeof said.content === 'string' ? [block(said.content)] : Array.isArray(said.content) ? said.content.map(block) : []
  return {
    type: message.type,
    uuid: message.uuid,
    ...(typeof message.parent_tool_use_id === 'string' ? { parentToolUseId: message.parent_tool_use_id } : {}),
    ...(message.is_meta === true || message.isMeta === true ? { meta: true } : {}),
    ...(message.isCompactSummary === true ? { compactSummary: true } : {}),
    ...(typeof message.subtype === 'string' ? { subtype: message.subtype } : {}),
    ...(typeof said.id === 'string' ? { id: said.id } : {}),
    ...(typeof said.model === 'string' ? { model: clip(said.model, 200) } : {}),
    ...(typeof message.timestamp === 'string' ? { timestamp: message.timestamp } : {}),
    content: content.filter(item => item !== undefined),
  }
}

async function list(request: Json): Promise<Json> {
  const limit = typeof request.limit === 'number' && request.limit > 0 ? Math.min(request.limit, 500) : 100
  const offset = typeof request.offset === 'number' && request.offset > 0 ? request.offset : 0
  // As the terminal's `/resume`: sessions an SDK started (Latch's own among them) are not offered.
  const rows = await (await sdk()).listSessions({ includeProgrammatic: false, limit: limit + 1, offset })
  const sessions = rows.slice(0, limit).flatMap(row =>
    typeof row.sessionId === 'string' && typeof row.cwd === 'string'
      ? [
          {
            sessionId: row.sessionId,
            cwd: row.cwd,
            ...(str(row.summary, 400) ? { title: str(row.summary, 400) } : {}),
            ...(typeof row.lastModified === 'number' ? { updatedAt: new Date(row.lastModified).toISOString() } : {}),
          },
        ]
      : [],
  )
  return { sessions, more: rows.length > limit }
}

async function info(request: Json): Promise<Json> {
  const id = sessionId(request)
  const dir = dirOf(request)
  const api = await sdk()
  const found = (dir ? await api.getSessionInfo(id, { dir }) : undefined) ?? (await api.getSessionInfo(id, {}))
  if (found) return { exists: true, ...(typeof found.lastModified === 'number' ? { lastModified: found.lastModified } : {}) }
  // A session with nothing to name it by (no summary, no prompt in words) has no info, yet its messages are there.
  const near = dir ? await api.getSessionMessages(id, { dir, limit: 1 }) : []
  const any = near.length ? near : await api.getSessionMessages(id, { limit: 1 })
  return { exists: any.length > 0 }
}

async function messages(request: Json): Promise<Json> {
  const id = sessionId(request)
  const dir = dirOf(request)
  const maxBytes = typeof request.maxBytes === 'number' ? request.maxBytes : 8 * 1024 * 1024
  const api = await sdk()
  let read = dir ? await api.getSessionMessages(id, { dir, includeSystemMessages: true }) : []
  if (!read.length) read = await api.getSessionMessages(id, { includeSystemMessages: true })
  const kept: Json[] = []
  let bytes = 0
  let dropped = 0
  // The newest within the bound; what is older stays in Claude's record only.
  for (let index = read.length - 1; index >= 0; index--) {
    const item = compact(read[index]!)
    if (!item) continue
    const size = JSON.stringify(item).length
    if (kept.length && bytes + size > maxBytes) {
      dropped = index + 1
      break
    }
    bytes += size
    kept.unshift(item)
  }
  // Claude's read starts after the last compaction, which it gives as a system message.
  const compacted = read.some(item => item.type === 'system')
  return { messages: kept, dropped, ...(compacted ? { compacted: true } : {}) }
}

/** Every entry of the session's own transcript, compaction and all (`getSessionMessages` keeps only the last part). */
async function entries(id: string, dir: string | undefined): Promise<Json[]> {
  const all: Json[] = []
  const store = {
    append: async (_key: unknown, batch: unknown) => {
      if (Array.isArray(batch)) for (const item of batch) if (isRecord(item)) all.push(item)
    },
    load: async () => null,
  }
  await (await sdk()).importSessionToStore(id, store, { ...(dir ? { dir } : {}), includeSubagents: false })
  return all.filter(item => item.isSidechain !== true && typeof item.uuid === 'string')
}

/** A prompt of the person's: a user entry that is not a tool's result, a summary or a note Claude adds itself. */
function isPrompt(entry: Json): boolean {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isCompactSummary === true) return false
  const said = isRecord(entry.message) ? entry.message.content : undefined
  if (typeof said === 'string') return true
  return Array.isArray(said) && !said.some(item => isRecord(item) && item.type === 'tool_result')
}

/** The chain from the first entry to the last one written, across compactions (`logicalParentUuid`). */
function chain(all: Json[]): Json[] {
  const byId = new Map(all.map(entry => [entry.uuid as string, entry]))
  const last = all.findLast(entry => entry.type === 'user' || entry.type === 'assistant')
  const path: Json[] = []
  const seen = new Set<string>()
  for (let at: Json | undefined = last; at && !seen.has(at.uuid as string);) {
    seen.add(at.uuid as string)
    path.push(at)
    const parent =
      typeof at.parentUuid === 'string' ? at.parentUuid : typeof at.logicalParentUuid === 'string' ? at.logicalParentUuid : undefined
    at = parent ? byId.get(parent) : undefined
  }
  return path.reverse()
}

/**
 * Claude's own fork of the session through the turn Latch's message `through` opened: everything up to the last entry
 * before the next prompt. Refused when the transcript does not hold that message or the copy does not end there.
 */
async function fork(request: Json): Promise<Json> {
  const id = sessionId(request)
  const through = sessionId(request, 'through')
  const dir = dirOf(request)
  const api = await sdk()
  const path = chain(await entries(id, dir))
  const start = path.findIndex(entry => entry.uuid === through)
  if (start < 0) return { refused: 'missing' }
  const next = path.findIndex((entry, index) => index > start && isPrompt(entry))
  const kept = (next < 0 ? path : path.slice(0, next)).filter(
    (entry, index) => index >= start && (entry.type === 'user' || entry.type === 'assistant') && entry.isCompactSummary !== true,
  )
  const upTo = kept.at(-1)?.uuid as string | undefined
  if (!upTo) return { refused: 'missing' }
  const forked = await api.forkSession(id, { ...(dir ? { dir } : {}), upToMessageId: upTo })
  const copied = chain(await entries(forked.sessionId, dir)).at(-1)
  const from = isRecord(copied?.forkedFrom) ? copied.forkedFrom.messageUuid : undefined
  if (from !== upTo) {
    await api.deleteSession(forked.sessionId, dir ? { dir } : {}).catch(() => {})
    return { refused: 'end' }
  }
  return { sessionId: forked.sessionId }
}

async function remove(request: Json): Promise<Json> {
  const id = sessionId(request)
  const dir = dirOf(request)
  const api = await sdk()
  for (const options of dir ? [{ dir }, {}] : [{}]) {
    try {
      await api.deleteSession(id, options)
      return { deleted: true }
    } catch (error) {
      if (!NOT_FOUND.test(error instanceof Error ? error.message : String(error))) throw error
    }
  }
  return { deleted: false }
}

/** What Claude's settings say for a session in `cwd`, as facts: never an `env` value, a helper's command or a hook. */
async function settings(request: Json): Promise<Json> {
  const cwd = typeof request.cwd === 'string' && request.cwd.startsWith('/') ? request.cwd : undefined
  if (!cwd) throw new Refused('cwd is not a path')
  const api = await sdk()
  const resolved = await api.resolveSettings({ cwd, settingSources: ['user', 'project', 'local'] })
  const effective = resolved.effective
  const filtered = api.filterEscalatingDefaultMode(resolved)
  const permissions = isRecord(effective.permissions) ? effective.permissions : {}
  const startMode = isRecord(filtered.permissions) ? str(filtered.permissions.defaultMode, 64) : undefined
  const provenance = (key: string) => {
    const entry = resolved.provenance[key]
    return isRecord(entry) && typeof entry.source === 'string' ? entry.source : undefined
  }
  const allow: Array<{ rule: string; source: string }> = []
  let hooks = false
  let managed = false
  let managedModels: string[] | undefined
  for (const layer of resolved.sources) {
    const values = isRecord(layer.settings) ? layer.settings : undefined
    if (!values) continue
    if (layer.source === 'managed' && Object.keys(values).length) managed = true
    if (isRecord(values.hooks) && Object.keys(values.hooks).length) hooks = true
    const rules = isRecord(values.permissions) && Array.isArray(values.permissions.allow) ? values.permissions.allow : []
    for (const rule of rules)
      if (typeof rule === 'string' && allow.length < MAX_RULES) allow.push({ rule: clip(rule, 200), source: layer.source })
    if (layer.source === 'managed' && Array.isArray(values.availableModels))
      managedModels = values.availableModels.filter((item): item is string => typeof item === 'string').slice(0, 200)
  }
  const env = isRecord(effective.env) ? effective.env : {}
  return {
    disableBypass: permissions.disableBypassPermissionsMode === 'disable',
    disableAuto: permissions.disableAutoMode === 'disable' || effective.disableAutoMode === 'disable',
    ...(startMode ? { startMode } : {}),
    allow,
    hooks,
    managed,
    ...(typeof effective.cleanupPeriodDays === 'number' ? { cleanupPeriodDays: effective.cleanupPeriodDays } : {}),
    ...(str(effective.maxEffortLevel, 64) ? { maxEffortLevel: str(effective.maxEffortLevel, 64) } : {}),
    ...(provenance('apiKeyHelper') === 'managed' ? { managedKeyHelper: true } : {}),
    ...(managedModels ? { managedModels } : {}),
    ...(str(effective.model, 200) ? { model: str(effective.model, 200), modelSource: provenance('model') } : {}),
    ...(typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL ? { ownEndpoint: true } : {}),
    ...(typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR ? { configDirInSettings: true } : {}),
  }
}

function processStart(pid: number): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { timeout: 1000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' } },
      (_e, out) =>
        resolve(
          String(out ?? '')
            .trim()
            .replace(/\s+/gu, ' ') || undefined,
        ),
    )
  })
}

/**
 * Whether a running `claude` holds the session, from its registry `<config>/sessions/<pid>.json` read as the adapter
 * reads it: only those files (never a `.key`), the process alive, and its recorded start the live one's.
 */
async function busy(request: Json): Promise<Json> {
  const id = sessionId(request)
  const dir = join(configDir(), 'sessions')
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    const match = /^(\d+)\.json$/u.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    let record: unknown
    try {
      record = JSON.parse(await readFile(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    if (!isRecord(record) || record.pid !== pid || record.sessionId !== id || pid === process.pid) continue
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') continue
    }
    if (typeof record.procStart === 'string') {
      const live = await processStart(pid)
      if (live && live !== record.procStart.trim().replace(/\s+/gu, ' ')) continue
    }
    return { busy: true }
  }
  return { busy: false }
}

const OPS: Record<string, (request: Json) => Promise<Json>> = { list, info, messages, fork, delete: remove, settings, busy }

async function main(): Promise<void> {
  let input = ''
  for await (const chunk of process.stdin) input += String(chunk)
  let answer: Json
  try {
    const request: unknown = JSON.parse(input)
    if (!isRecord(request) || typeof request.op !== 'string' || !Object.hasOwn(OPS, request.op)) throw new Refused('unknown request')
    answer = { ok: true, result: await OPS[request.op]!(request) }
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error)
    answer = { ok: false, error: clip(said, 1000), ...(error instanceof Refused ? { refused: true } : {}) }
  }
  process.stdout.write(`${JSON.stringify(answer)}\n`)
}

await main()
