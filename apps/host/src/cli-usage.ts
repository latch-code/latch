/**
 * The one place Latch reads a Harness CLI's own record of a session: the token counts DeepSeek Harness writes in the
 * session log of a session Latch started with its preset, for a turn its ACP adapter reported no usage for
 * (`@deepseek-ai/dsh-acp` sends only the context's size). Nothing else of the record leaves this module.
 *
 * What is read, and how:
 * 1. One file, at a path built from fixed parts and two things Latch holds: `~/.dsh/sessions/<project>/<id>/
 *    session.v4.jsonl.zstd` (`@deepseek-ai/dsh-session-persistence-jsonl` 0.2.2-rc.1: `projectKey` of the `cwd` Latch
 *    sent in `session/new`, the session ID dsh-acp answered, format 4, Zstandard). No directory is listed or searched.
 *    `DSH_HOME`, or DeepSeek Harness's own composition saying its session store is not as shipped (`dsh-config.ts`),
 *    ends the read before anything is opened.
 * 2. Every directory on the way is a real directory owned by this user; the file is opened without following a link,
 *    must be a regular file owned by this user and at most 64 MiB, and is decompressed and split into lines a chunk at
 *    a time, giving up past 256 MiB of text or a line past 16 MiB (`BOUNDS`).
 * 3. The header must name this ID, this folder and format 4. Of the events only `turn/start`, `turn/end`,
 *    `assistant/message` and `subagent/catalog` are looked at; an assistant message is parsed for its `turn`, `time` and
 *    `usage` numbers, and its text is dropped with the line. Only token counts are returned.
 *
 * A turn is dsh's own turns that both began and ended inside Latch's turn. Anything uncertain is nothing: a dsh turn
 * crossing either edge, no complete turn, an assistant message without usage, a subagent in the session (its usage is
 * in a child's log Latch holds no ID for), a line of another shape, or a failed read. Failures say nothing.
 */
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'
import { z } from 'zod'
import type { TokenUsage } from '@latch/protocol'
import type { DshConfigVerdict } from './dsh-config.ts'

const DSH_DIR = '.dsh'
const SESSIONS = 'sessions'
const LOG_FILE = 'session.v4.jsonl.zstd'
const FORMAT_VERSION = 4
/** The compressed file, all its text, and one line: past any of them the turn is not known. */
const BOUNDS = { file: 64 * 1024 * 1024, text: 256 * 1024 * 1024, line: 16 * 1024 * 1024 }
type Bounds = typeof BOUNDS
const MAX_CWD = 4096
/** The session IDs dsh-acp makes (`randomUUID()`), which its path encoding keeps as they are. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
/** The plugin whose layers decide where session logs are and how they are written (`dshConfigCheck`). */
export const DSH_STORE_PLUGINS = ['session-persistence-jsonl'] as const
/** The start of an event line: its `type` first, as the v4 encoder writes it. */
const EVENT_TYPE = /^\{"type":"([^"\\]{1,128})"/u
const WANTED = new Set(['turn/start', 'turn/end', 'assistant/message', 'subagent/catalog'])

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const header = z.object({ type: z.literal('session'), version: z.literal(FORMAT_VERSION), id: z.string(), cwd: z.string() })
const turnEvent = z.object({ time, data: z.object({ turn: count }) })
const assistantEvent = z.object({
  time,
  data: z.object({
    turn: count,
    usage: z
      .object({
        inputTokens: count,
        outputTokens: count,
        cacheReadTokens: count.optional(),
        cacheWriteTokens: count.optional(),
        reasoningTokens: count.optional(),
      })
      .optional(),
  }),
})

/** dsh's directory name for a project folder (`projectKey`, dsh-session-persistence-jsonl 0.2.2-rc.1 `format.ts`). */
export function dshProjectKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/u, '') || 'root').slice(0, 251)}--`
}

/** A directory that is itself a directory (not a link) owned by `uid`. */
export async function ownDirectory(path: string, uid: number): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isDirectory() && !info.isSymbolicLink() && info.uid === uid
  } catch {
    return false
  }
}

/** More events of these kinds than a session of Latch's runs to is not a record this reads. */
const MAX_EVENTS = 100_000

function tooMany(facts: Facts): boolean {
  return facts.messages.length > MAX_EVENTS || facts.starts.size > MAX_EVENTS || facts.ends.size > MAX_EVENTS
}

interface Facts {
  starts: Map<number, number>
  ends: Map<number, number>
  messages: { turn: number; time: number; usage?: TokenUsage }[]
  subagentAt?: number
}

/** The record's facts, line by line; undefined when the file or any line is not what format 4 writes. */
async function readFacts(
  path: string,
  uid: number,
  expect: { id: string; cwd: string },
  bounds: Bounds,
  signal: AbortSignal,
): Promise<Facts | undefined> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return undefined
  }
  const facts: Facts = { starts: new Map(), ends: new Map(), messages: [] }
  let first = true
  const take = (line: string): boolean => {
    if (first) {
      first = false
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        return false
      }
      const parsed = header.safeParse(value)
      return parsed.success && parsed.data.id === expect.id && parsed.data.cwd === expect.cwd
    }
    const type = EVENT_TYPE.exec(line)?.[1]
    if (type === undefined) return false
    if (!WANTED.has(type)) return true
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return false
    }
    if (type === 'subagent/catalog') {
      const at = time.safeParse((value as { time?: unknown }).time)
      if (!at.success) return false
      facts.subagentAt = Math.min(facts.subagentAt ?? at.data, at.data)
      return true
    }
    if (type === 'assistant/message') {
      const parsed = assistantEvent.safeParse(value)
      if (!parsed.success) return false
      const { turn, usage } = parsed.data.data
      facts.messages.push({ turn, time: parsed.data.time, ...(usage ? { usage: latchTokens(usage) } : {}) })
      return true
    }
    const parsed = turnEvent.safeParse(value)
    if (!parsed.success) return false
    const into = type === 'turn/start' ? facts.starts : facts.ends
    if (into.has(parsed.data.data.turn)) return false
    into.set(parsed.data.data.turn, parsed.data.time)
    return true
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== uid || info.size > bounds.file) return undefined
    const source = handle.createReadStream({ start: 0, end: Math.max(0, info.size - 1), autoClose: false })
    let readFailed = false
    source.once('error', () => void (readFailed = true))
    let text = 0
    let pending: Buffer[] = []
    let pendingBytes = 0
    // One chain: an abort, a failed read or a stop here ends every part of it, so nothing waits on a stream left open.
    const outcome = await pipeline(
      source,
      createZstdDecompress(),
      async (decoded: AsyncIterable<Buffer>) => {
        for await (const chunk of decoded) {
          if (signal.aborted) return 'stop'
          text += chunk.byteLength
          if (text > bounds.text) return 'stop'
          let from = 0
          for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, from)) {
            pending.push(chunk.subarray(from, at))
            pendingBytes += at - from
            if (pendingBytes > bounds.line) return 'stop'
            const line = Buffer.concat(pending).toString('utf8')
            pending = []
            pendingBytes = 0
            from = at + 1
            if (!take(line) || tooMany(facts)) return 'stop'
          }
          if (from < chunk.byteLength) {
            pending.push(chunk.subarray(from))
            pendingBytes += chunk.byteLength - from
            if (pendingBytes > bounds.line) return 'stop'
          }
        }
        return 'done'
      },
      { signal },
    ).catch(() =>
      // A frame cut short as dsh appends: the complete lines before it stand, as they do for dsh itself. An abort or a
      // failed read is no such frame.
      signal.aborted || readFailed ? 'stop' : 'torn',
    )
    if (outcome === 'stop') return undefined
    return first ? undefined : facts
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => {})
  }
}

/** dsh's counts are disjoint (input without its cached part); Latch's input holds the cached part. */
function latchTokens(usage: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number | undefined
  cacheWriteTokens?: number | undefined
  reasoningTokens?: number | undefined
}): TokenUsage {
  const read = usage.cacheReadTokens ?? 0
  const write = usage.cacheWriteTokens ?? 0
  return {
    inputTokens: usage.inputTokens + read + write,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
  }
}

const PARTS = ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

/** The tokens of the dsh turns inside `[from, to]`; undefined whenever that is not certain. */
function attributeTurn(facts: Facts, from: number, to: number): TokenUsage | undefined {
  if (facts.subagentAt !== undefined && facts.subagentAt <= to) return undefined
  const inside: number[] = []
  for (const [turn, start] of facts.starts) {
    const end = facts.ends.get(turn)
    if (start >= from && start <= to) {
      // Begun in Latch's turn: it must have ended in it too.
      if (end === undefined || end > to || end < start) return undefined
      inside.push(turn)
    } else if (start < from && (end === undefined || end >= from)) return undefined
  }
  if (!inside.length) return undefined
  const messages = facts.messages.filter(message => inside.includes(message.turn))
  if (!messages.length || messages.some(message => !message.usage || message.time < from || message.time > to)) return undefined
  const total: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  for (const part of PARTS) if (messages.every(message => message.usage![part] !== undefined)) total[part] = 0
  for (const { usage } of messages) {
    total.inputTokens += usage!.inputTokens
    total.outputTokens += usage!.outputTokens
    for (const part of PARTS) if (total[part] !== undefined) total[part] += usage![part]!
  }
  const whole = [total.inputTokens, total.outputTokens, ...PARTS.map(part => total[part] ?? 0)].every(Number.isSafeInteger)
  return whole ? total : undefined
}

/**
 * The tokens DeepSeek Harness recorded for the turn of its session `sessionId` (started by Latch in `cwd`) that ran
 * from `from` to `to` (milliseconds), or undefined: not known. `env` is what DeepSeek Harness inherits.
 */
export async function readDshTurnUsage(input: {
  accountDirectory?: string | undefined
  home: string
  env: Readonly<Record<string, string | undefined>>
  uid: number
  cwd: string
  sessionId: string
  from: number
  to: number
  signal: AbortSignal
  /** What DeepSeek Harness's own composition says of `DSH_STORE_PLUGINS`. */
  config: () => Promise<DshConfigVerdict>
  /** Tests only: smaller bounds. */
  bounds?: Bounds
}): Promise<TokenUsage | undefined> {
  const { home, env, uid, cwd, sessionId, from, to, signal } = input
  if ((env.DSH_HOME?.trim() || undefined) !== input.accountDirectory) return undefined
  if (!SESSION_ID.test(sessionId)) return undefined
  if (!cwd.startsWith('/') || cwd.length > MAX_CWD || cwd.includes('\0')) return undefined
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) return undefined
  const dir = input.accountDirectory ?? join(home, DSH_DIR)
  if (!(await ownDirectory(dir, uid))) return undefined
  if ((await input.config()) !== 'official') return undefined
  const sessions = join(dir, SESSIONS)
  const project = join(sessions, dshProjectKey(cwd))
  const own = join(project, sessionId)
  for (const path of [sessions, project, own]) if (!(await ownDirectory(path, uid))) return undefined
  if (signal.aborted) return undefined
  const facts = await readFacts(join(own, LOG_FILE), uid, { id: sessionId, cwd }, input.bounds ?? BOUNDS, signal)
  return facts ? attributeTurn(facts, from, to) : undefined
}
