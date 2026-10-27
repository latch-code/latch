// Where the changes engine keeps its records, inside the data directory's private `snapshots` entry:
//   <project>/objects/<xx>/<sha256>           retained file contents (objects.ts)
//   <project>/sessions/<session>/head.json    the session's files as last recorded
//   <project>/sessions/<session>/turns.json   its retained turns, oldest first
// Project and session directories are named by a hash of their IDs. Directories are 0700, files 0600.
import { chmod, lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { sha256Hex, writeFileAtomic } from '@latch/core/node-kit'
import { RUN_ID } from '../session-meta.ts'

export const SNAPSHOTS_DIR = 'snapshots'
/** Changed files kept per change set; a turn with more is marked partial. */
export const CHANGE_LIMIT = 20_000
/** Line hashes of the agent's own edits kept per file. */
export const AGENT_LINE_LIMIT = 5000

/** One file at one moment. */
export interface FileState {
  size: number
  /** Permission bits. */
  mode: number
  /** SHA-256 of the content, when the Host read it (never for a secret-looking name). */
  hash?: string
  /**
   * `stored`: the content is in the project's objects. Otherwise the reason it is not: `secret`, `large` (past the
   * clone limit, or past the copy limit on a volume that cannot clone), `cap` (the project cap), `skipped` (unreadable,
   * changing while read, or out of time).
   */
  kept: 'stored' | 'secret' | 'large' | 'cap' | 'skipped'
  /** `dev:ino:size:mtime:ctime` when recorded. */
  sig?: string
}
export interface Entry extends FileState {
  sig: string
}
export interface Folder {
  id: string
  /** The real path when recorded. */
  path: string
}
export interface Manifest {
  capturedAt: string
  folders: Folder[]
  /** Folders walked to the end; in any other, a file missing here may still exist. */
  complete: string[]
  /** By `fileKey(root, path)`. */
  files: Record<string, Entry>
}
export interface Change {
  root: string
  path: string
  /** Absent: no file. */
  before?: FileState
  after?: FileState
  /** Turn changes whose edits were known: who made the change. */
  by?: 'agent' | 'command' | 'mixed'
  /** For `mixed`: the agent's added and removed lines, as hashes. */
  agentLines?: { added: string[]; removed: string[] }
}
export interface Receipt {
  sessionId: string
  turnId: string
  requestId: string
  action: 'undo' | 'redo'
  restored: number
  removed: number
  skipped: number
  at: string
}
export interface TurnRecord {
  turnId: string
  startedAt: string
  settledAt?: string
  /** `running` until settled; a record still `running` after a Host restart is settled as interrupted. */
  state: 'running' | 'settled'
  outcome?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  /** Some changes may be missing: a walk or change set hit a limit. */
  partial?: true
  /** The turn's edits were given at settlement, so `Change.by` is set. */
  attributed: boolean
  /** Changes between the previous record and this turn's start. */
  between: Change[]
  /** This turn's own changes, once settled. */
  changes: Change[]
  undone?: { at: string; requestId: string }
  /** Recent undo and redo answers, replayed for a retried request ID. */
  receipts: Receipt[]
}

const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
const digest = z.string().regex(/^[0-9a-f]{64}$/u)
const sig = z.string().regex(/^\d+:\d+:\d+:\d+:\d+$/u)
const folderId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/u)
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const count = z.number().int().min(0).max(1_000_000)
const lineHashes = z.array(z.string().regex(/^[0-9a-f]{16}$/u)).max(AGENT_LINE_LIMIT)
const kept = z.enum(['stored', 'secret', 'large', 'cap', 'skipped'])
const fileState = z.strictObject({
  size: z.number().int().min(0),
  mode: z.number().int().min(0).max(0o777),
  hash: digest.optional(),
  kept,
  sig: sig.optional(),
})
const entry = z.strictObject({
  size: z.number().int().min(0),
  mode: z.number().int().min(0).max(0o777),
  hash: digest.optional(),
  kept,
  sig,
})
const manifestSchema = z.strictObject({
  capturedAt: isoTime,
  folders: z.array(z.strictObject({ id: folderId, path: z.string().min(1).max(4096) })).max(8),
  complete: z.array(folderId).max(8),
  files: z.record(z.string().max(4200), entry),
})
const changeSchema = z.strictObject({
  root: folderId,
  path: z.string().min(1).max(4096),
  before: fileState.optional(),
  after: fileState.optional(),
  by: z.enum(['agent', 'command', 'mixed']).optional(),
  agentLines: z.strictObject({ added: lineHashes, removed: lineHashes }).optional(),
})
const receiptSchema = z.strictObject({
  sessionId: z.string().min(1).max(256),
  turnId: z.string().regex(RUN_ID),
  requestId,
  action: z.enum(['undo', 'redo']),
  restored: count,
  removed: count,
  skipped: count,
  at: isoTime,
})
const turnSchema = z.strictObject({
  turnId: z.string().regex(RUN_ID),
  startedAt: isoTime,
  settledAt: isoTime.optional(),
  state: z.enum(['running', 'settled']),
  outcome: z.enum(['completed', 'failed', 'cancelled', 'interrupted']).optional(),
  partial: z.literal(true).optional(),
  attributed: z.boolean(),
  between: z.array(changeSchema).max(CHANGE_LIMIT),
  changes: z.array(changeSchema).max(CHANGE_LIMIT),
  undone: z.strictObject({ at: isoTime, requestId }).optional(),
  receipts: z.array(receiptSchema).max(8),
})
const ownerShape = { v: z.literal(1), sessionId: z.string().min(1).max(256), projectId: z.string().min(1).max(256) }
const headSchema = z.strictObject({ ...ownerShape, manifest: manifestSchema })
const turnsSchema = z.strictObject({ ...ownerShape, turns: z.array(turnSchema).max(64) })

/** A directory name for an ID; IDs can hold any character or differ only in case, so they never become a path. */
export const directoryKey = (id: string) => sha256Hex(id).slice(0, 32)

const errorCode = (error: unknown) => (error instanceof Error && 'code' in error ? error.code : undefined)

/** Makes sure `path` is a directory for this user alone: created 0700, or an existing real directory we own. */
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (errorCode(error) !== 'EEXIST') throw error
  })
  const info = await lstat(path)
  const uid = process.getuid?.()
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid))
    throw new AppError(500, 'changes-store-insecure', '改动记录目录不是本用户的普通目录。')
  if ((info.mode & 0o077) !== 0) await chmod(path, 0o700)
}

async function load<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  const parsed = schema.safeParse(
    (() => {
      try {
        return JSON.parse(text) as unknown
      } catch {
        return undefined
      }
    })(),
  )
  return parsed.success ? parsed.data : undefined
}

export interface ScannedSession {
  sessionId: string
  projectId: string
  head?: Manifest
  turns: TurnRecord[]
}

/** One session's two record files. A missing or damaged file reads as empty; the next turn records afresh. */
export class SessionFiles {
  constructor(
    readonly directory: string,
    readonly sessionId: string,
    readonly projectId: string,
  ) {}

  /** Whatever a session directory holds, for scans across a project. */
  static async scan(directory: string): Promise<ScannedSession | undefined> {
    const [head, turns] = await Promise.all([
      load(join(directory, 'head.json'), headSchema),
      load(join(directory, 'turns.json'), turnsSchema),
    ])
    const owner = turns ?? head
    if (!owner) return undefined
    const sameOwner = head !== undefined && head.sessionId === owner.sessionId && head.projectId === owner.projectId
    return {
      sessionId: owner.sessionId,
      projectId: owner.projectId,
      ...(sameOwner ? { head: head.manifest as Manifest } : {}),
      turns: (turns?.turns ?? []) as TurnRecord[],
    }
  }

  private owns(value: { sessionId: string; projectId: string } | undefined): boolean {
    return value?.sessionId === this.sessionId && value.projectId === this.projectId
  }

  async readHead(): Promise<Manifest | undefined> {
    const file = await load(join(this.directory, 'head.json'), headSchema)
    return this.owns(file) ? (file!.manifest as Manifest) : undefined
  }

  async readTurns(): Promise<TurnRecord[]> {
    const file = await load(join(this.directory, 'turns.json'), turnsSchema)
    return this.owns(file) ? (file!.turns as TurnRecord[]) : []
  }

  async writeHead(head: Manifest | undefined): Promise<void> {
    const path = join(this.directory, 'head.json')
    if (!head) await rm(path, { force: true })
    else await writeFileAtomic(path, JSON.stringify({ v: 1, sessionId: this.sessionId, projectId: this.projectId, manifest: head }))
  }

  async writeTurns(turns: readonly TurnRecord[]): Promise<void> {
    await writeFileAtomic(
      join(this.directory, 'turns.json'),
      JSON.stringify({ v: 1, sessionId: this.sessionId, projectId: this.projectId, turns }),
    )
  }

  async remove(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true })
  }
}
