/**
 * The Host's reads, and its few removals, in the stores Harness CLIs keep for themselves, beside `cli-quota.ts` and
 * `cli-usage.ts`. Each one is on only where the start script passes the person's home (`ServerOptions.cliStore`); a
 * test Host has none, so nothing here ever touches a real store there.
 *
 * - goose: whether opening a session again (`session/load`, its only way back) would go on by itself with a turn that
 *   stopped on a tool confirmation (1.57.0 `resume_state_machine_turn_inner`); and the subagent sessions of a session,
 *   which `session/delete` leaves. Read-only, from its SQLite database.
 * - DeepSeek Harness: removes the directory and cached record of a session Latch itself opened, since dsh has no way to
 *   delete one (`session-persistence-jsonl` README, "Known Limitations"), after checking the log's header names it.
 * - Qwen Code: what its managed npm update runs instead of the installed program (0.27.4 `scripts/cli-entry.js`), so a
 *   silent update changes the launch fingerprint.
 *
 * Nothing of a record's content leaves this module: only verdicts, session IDs and a digest.
 */
import { createHash } from 'node:crypto'
import { constants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { lstat, open, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'
import type { TokenUsage } from '@latch/protocol'
import { dshProjectKey, ownDirectory } from './cli-usage.ts'
import type { DshConfigVerdict } from './dsh-config.ts'

/** The variables the Harness inherits that move its home (its profile's `inheritEnv`), as it receives them. */
export type Inherited = Readonly<Record<string, string | undefined>>

// ---- goose ------------------------------------------------------------------------------------------------------

/** goose's session IDs (`20261119_3`, or a UUID for older ones): never a path or a pattern. */
const GOOSE_ID = /^[A-Za-z0-9_.-]{1,128}$/u
/** Past these, a turn is not one this reads: the session is treated as one that might resume. */
const GOOSE_BOUNDS = { rows: 20_000, bytes: 64 * 1024 * 1024 }
const MAX_CHILDREN = 1000

/**
 * goose's database, by its own rules (1.57.0 `config/paths.rs`): `GOOSE_PATH_ROOT` when absolute, else the XDG data
 * directory (`etcetera`'s XDG strategy, which macOS gets too).
 */
export function gooseSessionsDb(home: string, env: Inherited): string {
  const root = env.GOOSE_PATH_ROOT
  if (root && isAbsolute(root)) return join(root, 'data', 'sessions', 'sessions.db')
  const xdg = env.XDG_DATA_HOME
  const data = xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'share')
  return join(data, 'goose', 'sessions', 'sessions.db')
}

/**
 * The database opened read-only, after checking it is a file of this user's and not a link; undefined otherwise. goose
 * writes with WAL. While its write-ahead log exists, SQLite reads through it and the index beside it, as goose does;
 * without one everything is in the file, which is then read as it is (`immutable`), since a read-only connection would
 * otherwise create both files beside the person's database.
 */
function openGooseDb(path: string, uid: number): DatabaseSync | undefined {
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.uid !== uid) return undefined
    const logged = lstatSync(`${path}-wal`, { throwIfNoEntry: false }) !== undefined
    const target = logged ? path : Object.assign(pathToFileURL(path), { search: '?immutable=1' })
    // Loaded here, not at import: a runtime without SQLite then only refuses to read, and the Host still starts.
    const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite') | undefined
    if (!sqlite) return undefined
    return new sqlite.DatabaseSync(target, { readOnly: true, timeout: 2000 })
  } catch {
    return undefined
  }
}

type GooseContent = { type?: unknown; id?: unknown; data?: { actionType?: unknown; id?: unknown } }

function parseContent(text: string): GooseContent[] | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) && value.every(item => typeof item === 'object' && item !== null) ? (value as GooseContent[]) : undefined
  } catch {
    return undefined
  }
}

/** goose reads a message's metadata leniently: anything it cannot read is the default, which is visible. */
function userVisible(metadata: unknown): boolean {
  if (typeof metadata !== 'string') return true
  try {
    const value: unknown = JSON.parse(metadata)
    if (typeof value !== 'object' || value === null) return true
    const visible = (value as { userVisible?: unknown }).userVisible
    return typeof visible === 'boolean' ? visible : true
  } catch {
    return true
  }
}

/**
 * Whether goose, opening the session `sessionId`, would find nothing to go on with. goose resumes the turn that began at
 * the last message the person could see that is not a tool's answer (`active_turn_messages`) when it holds a confirmation
 * not yet answered, or an answer to one whose tool has not run (`pending_tool_confirmations`,
 * `has_unapplied_tool_confirmation_response`). This asks less: any confirmation or answer in that turn whose tool has no
 * result. `clear` only when the session is there and nothing of the kind is; anything not certain is `blocked`.
 */
export function gooseResumeState(input: { home: string; env: Inherited; uid: number; sessionId: string }): 'clear' | 'blocked' {
  if (!GOOSE_ID.test(input.sessionId)) return 'blocked'
  const db = openGooseDb(gooseSessionsDb(input.home, input.env), input.uid)
  if (!db) return 'blocked'
  try {
    if (!db.prepare('SELECT 1 AS found FROM sessions WHERE id = ?').get(input.sessionId)) return 'blocked'
    const rows = db
      .prepare('SELECT role, content_json, metadata_json FROM messages WHERE session_id = ? ORDER BY created_timestamp DESC, id DESC')
      .iterate(input.sessionId)
    const answered = new Set<string>()
    const asked = new Set<string>()
    let count = 0
    let bytes = 0
    for (const row of rows) {
      const { role, content_json: content, metadata_json: metadata } = row as Record<string, unknown>
      if (++count > GOOSE_BOUNDS.rows || typeof content !== 'string') return 'blocked'
      bytes += content.length
      if (bytes > GOOSE_BOUNDS.bytes) return 'blocked'
      // goose leaves out any other role when it reads a conversation.
      if (role !== 'user' && role !== 'assistant') continue
      const parts = parseContent(content)
      if (!parts) return 'blocked'
      for (const part of parts) {
        if (part.type === 'toolResponse' && typeof part.id === 'string') answered.add(part.id)
        if (part.type !== 'actionRequired') continue
        const kind = part.data?.actionType
        if (kind !== 'toolConfirmation' && kind !== 'toolConfirmationResponse') continue
        if (typeof part.data?.id !== 'string') return 'blocked'
        asked.add(part.data.id)
      }
      const turnStart = role === 'user' && userVisible(metadata) && !parts.some(part => part.type === 'toolResponse')
      if (turnStart) break
    }
    for (const id of asked) if (!answered.has(id)) return 'blocked'
    return 'clear'
  } catch {
    return 'blocked'
  } finally {
    db.close()
  }
}

/**
 * The sessions goose started as subagents of `sessionIds`, at any depth (`parent_session_id`, 1.57.0 `summon.rs`), which
 * neither `session/list` nor `session/delete` reaches. Empty when the database cannot be read.
 */
export function gooseChildSessions(input: { home: string; env: Inherited; uid: number; sessionIds: readonly string[] }): string[] {
  const roots = input.sessionIds.filter(id => GOOSE_ID.test(id))
  if (!roots.length) return []
  const db = openGooseDb(gooseSessionsDb(input.home, input.env), input.uid)
  if (!db) return []
  try {
    const children = db.prepare('SELECT id FROM sessions WHERE parent_session_id = ?')
    const seen = new Set(roots)
    const found: string[] = []
    for (let queue = [...roots]; queue.length && found.length < MAX_CHILDREN;) {
      const parent = queue.shift()!
      for (const row of children.iterate(parent)) {
        const id = (row as { id?: unknown }).id
        if (typeof id !== 'string' || !GOOSE_ID.test(id) || seen.has(id)) continue
        seen.add(id)
        found.push(id)
        queue.push(id)
      }
    }
    return found
  } catch {
    return []
  } finally {
    db.close()
  }
}

/** One model call's tokens in goose's ledger (`usage_ledger`); input already holds the cached part (`Usage`). */
const ledgerCount = (value: unknown): number | undefined =>
  value === null || value === undefined ? undefined : Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : Number.NaN

/**
 * The tokens of goose's model calls in the session `sessionId` between `from` and `to` (milliseconds), from its ledger:
 * one row per call, stamped to the second (`record_usage`, `strftime('%s','now')`), the session's own calls only (a
 * subagent's are in its own session). A call in the second the turn began may be the turn before's, so a row there
 * makes the turn unknown, as does any count that is not one, or no call at all.
 */
export function gooseTurnUsage(input: {
  home: string
  env: Inherited
  uid: number
  sessionId: string
  from: number
  to: number
}): TokenUsage | undefined {
  const { sessionId, from, to } = input
  if (!GOOSE_ID.test(sessionId) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) return undefined
  const db = openGooseDb(gooseSessionsDb(input.home, input.env), input.uid)
  if (!db) return undefined
  try {
    const first = Math.floor(from / 1000)
    const rows = db
      .prepare(
        'SELECT created_timestamp, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM usage_ledger WHERE session_id = ? AND created_timestamp >= ? AND created_timestamp <= ? LIMIT 10001',
      )
      .all(sessionId, first, Math.floor(to / 1000)) as Array<Record<string, unknown>>
    if (!rows.length || rows.length > 10_000) return undefined
    const total: TokenUsage = { inputTokens: 0, outputTokens: 0 }
    let read = 0
    let written = 0
    let cached = true
    let writes = true
    for (const row of rows) {
      if (row.created_timestamp === first) return undefined
      const input = ledgerCount(row.input_tokens)
      const output = ledgerCount(row.output_tokens)
      if (input === undefined || output === undefined || Number.isNaN(input) || Number.isNaN(output)) return undefined
      total.inputTokens += input
      total.outputTokens += output
      const cacheRead = ledgerCount(row.cache_read_tokens)
      const cacheWrite = ledgerCount(row.cache_write_tokens)
      if (Number.isNaN(cacheRead) || Number.isNaN(cacheWrite)) return undefined
      if (cacheRead === undefined) cached = false
      else read += cacheRead
      if (cacheWrite === undefined) writes = false
      else written += cacheWrite
    }
    if (cached) total.cacheReadTokens = read
    if (writes) total.cacheWriteTokens = written
    const whole = [total.inputTokens, total.outputTokens, read, written].every(Number.isSafeInteger)
    return whole ? total : undefined
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

// ---- DeepSeek Harness -------------------------------------------------------------------------------------------

const DSH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const LOG_FILE = 'session.v4.jsonl.zstd'
const MAX_HEADER = 64 * 1024
const MAX_SIBLINGS = 2000

/** The first line of a session log: its header, or undefined when it is not one this user's file holds. */
async function dshHeader(path: string, uid: number): Promise<{ id?: unknown; cwd?: unknown; parentSession?: unknown } | undefined> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return undefined
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== uid) return undefined
    const chunks: Buffer[] = []
    let size = 0
    // One chain, as `cli-usage.ts` reads: a failed read or the stop at the first line ends every part of it.
    let found = false
    // Stopping at the first line ends the chain with an abort, which is no failure once the line is there.
    await pipeline(
      handle.createReadStream({ start: 0, autoClose: false }),
      createZstdDecompress(),
      async (decoded: AsyncIterable<Buffer>) => {
        for await (const chunk of decoded) {
          const end = chunk.indexOf(10)
          chunks.push(end === -1 ? chunk : chunk.subarray(0, end))
          size += chunk.byteLength
          if (end !== -1) {
            found = true
            return
          }
          if (size > MAX_HEADER) return
        }
      },
    ).catch(() => {})
    if (!found) return undefined
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'session' ? value : undefined
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Removes what DeepSeek Harness keeps of the session `sessionId` that Latch opened in `cwd`, and of the subagent sessions
 * it started there: each session's directory (`sessions/<project>/<id>/`, its log and lock) and its cached projection
 * (`storages/session_projcache/sessions/<id>.json`). Only where the log's header names this ID and folder, every
 * directory on the way is this user's own and no layer of the person's moves the session store; never the attachments,
 * which other sessions may share. Call it only after the process is gone. False when nothing was removed.
 */
export async function removeDshSession(input: {
  accountDirectory?: string | undefined
  home: string
  env: Inherited
  uid: number
  sessionId: string
  cwd: string
  /** What DeepSeek Harness's own composition says of its session store (`DSH_STORE_PLUGINS`). */
  config: () => Promise<DshConfigVerdict>
}): Promise<boolean> {
  const { home, env, uid, sessionId, cwd } = input
  if (
    (env.DSH_HOME?.trim() || undefined) !== input.accountDirectory
    || !DSH_ID.test(sessionId)
    || !cwd.startsWith('/')
    || cwd.length > 4096
    || cwd.includes('\0')
  )
    return false
  const dir = input.accountDirectory ?? join(home, '.dsh')
  if (!(await ownDirectory(dir, uid))) return false
  if ((await input.config()) !== 'official') return false
  const sessions = join(dir, 'sessions')
  const project = join(sessions, dshProjectKey(cwd))
  for (const path of [sessions, project]) if (!(await ownDirectory(path, uid))) return false
  const header = await dshHeader(join(project, sessionId, LOG_FILE), uid)
  if (!header || header.id !== sessionId || header.cwd !== cwd) return false
  const doomed = [sessionId, ...(await dshChildren(project, uid, sessionId))]
  const cache = join(dir, 'storages', 'session_projcache', 'sessions')
  const cacheOk = (await ownDirectory(join(dir, 'storages'), uid)) && (await ownDirectory(cache, uid))
  let removed = false
  for (const id of doomed) {
    const own = join(project, id)
    if (!(await ownDirectory(own, uid))) continue
    await rm(own, { recursive: true, force: true })
    removed = true
    if (!cacheOk) continue
    const record = join(cache, `${id}.json`)
    const info = await lstat(record).catch(() => undefined)
    if (info?.isFile() && info.uid === uid) await rm(record, { force: true })
  }
  return removed
}

/** The subagent sessions of `parent` at any depth among the sessions of the same folder, by their headers. */
async function dshChildren(project: string, uid: number, parent: string): Promise<string[]> {
  let names: string[]
  try {
    names = (await readdir(project)).filter(name => DSH_ID.test(name) && name !== parent).slice(0, MAX_SIBLINGS)
  } catch {
    return []
  }
  const parents = new Map<string, string>()
  for (const name of names) {
    const header = await dshHeader(join(project, name, LOG_FILE), uid)
    if (header?.id === name && typeof header.parentSession === 'string') parents.set(name, header.parentSession)
  }
  const found: string[] = []
  const within = new Set([parent])
  for (let grew = true; grew;) {
    grew = false
    for (const [id, of] of parents)
      if (within.has(of) && !within.has(id)) {
        within.add(id)
        found.push(id)
        grew = true
      }
  }
  return found
}

// ---- Qwen Code --------------------------------------------------------------------------------------------------

const QWEN_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const MAX_SMALL_FILE = 64 * 1024

function smallText(path: string): string | undefined {
  try {
    const info = statSync(path)
    if (!info.isFile() || info.size > MAX_SMALL_FILE) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** `QWEN_HOME` from the first of Qwen Code's own home files that sets it (`preResolveQwenHome`); the rest is not kept. */
function qwenHomeFromFiles(home: string): string | undefined {
  for (const file of [join(home, '.qwen', '.env'), join(home, '.env')]) {
    const text = smallText(file)
    if (text === undefined) continue
    const match = /^\s*(?:export\s+)?QWEN_HOME\s*[=:]\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#'"]+))/mu.exec(text.replace(/^﻿/u, ''))
    const value = match?.[1] ?? match?.[2] ?? match?.[3]
    if (value) return value
  }
  return undefined
}

function qwenHome(home: string, env: Inherited): string {
  const configured = env.QWEN_HOME ?? qwenHomeFromFiles(home)
  if (!configured) return join(home, '.qwen')
  if (configured === '~') return home
  if (configured.startsWith('~/')) return join(home, configured.slice(2))
  return isAbsolute(configured) ? configured : join(process.cwd(), configured)
}

/**
 * A digest of what Qwen Code's managed npm update makes `command` run instead of itself, or undefined when it runs
 * itself. The installed entry looks for `<QWEN_HOME>/updates/npm/<first 16 hex of sha256(entry path)>/active.json` and
 * runs the version it names from `versions/` (0.27.4 `scripts/cli-entry.js`, `getManagedNpmInstallation`); the digest
 * covers that file and the version's package manifest. Read whenever a launch is fingerprinted, so it stays small.
 */
export function qwenRunningCode(input: { home: string; env: Inherited; command: string }): string | undefined {
  let entry: string
  try {
    entry = realpathSync(input.command)
  } catch {
    return undefined
  }
  const root = join(qwenHome(input.home, input.env), 'updates', 'npm', createHash('sha256').update(entry).digest('hex').slice(0, 16))
  const active = smallText(join(root, 'active.json'))
  if (active === undefined) return undefined
  let version: unknown
  try {
    version = (JSON.parse(active) as { version?: unknown }).version
  } catch {
    version = undefined
  }
  const manifest =
    typeof version === 'string' && QWEN_VERSION.test(version)
      ? smallText(join(root, 'versions', version, 'node_modules', '@qwen-code', 'qwen-code', 'package.json'))
      : undefined
  return createHash('sha256')
    .update(JSON.stringify([active, manifest ?? null]))
    .digest('hex')
}
