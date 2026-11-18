// An Agent's home after the Agent is deleted (docs/CUSTOM-AGENTS.md#删除-agent): removed for good, or first written
// into a zip archive in a folder the desktop's native picker chose. Only a home this Host recorded and that matches its
// record now is ever touched; everything else is left where it is and reported.
//
// Both operations run in `latch-home` (native/macos/LatchHome.swift), which opens the start directory, `helpers` and
// the home without following a link, matches each to the identities the Host read, and works below the home only by
// descriptor (`openat`, `fstatat`, `unlinkat`), so a link inside the home is never followed and a directory swapped for
// a link mid-walk stops it. Without the helper (another platform, a build without it) a home is left and reported.
//
// Order: an export is audited before anything is written and must finish and be verified here (the archive's own
// central directory read back: entry count and bytes equal what the helper read) before anything is deleted. A removal
// is audited before it runs; if that record cannot be written the home is left (nothing is lost, and 设置 › 数据 can
// remove it later). Deleting the Agent itself never waits for or depends on its home.
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentFolderExport, AgentFolderResult, AgentHomeOutcome, LeftoverAgentFolder } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { canonicalPath, latchCodeRoot } from './paths.ts'
import type { LocatedHome, RecordedHome, SessionFolders } from './session-folders.ts'

/** How long a removal may take in the helper, and an export. */
const REMOVE_SECONDS = 120
const EXPORT_SECONDS = 900
/** A finished export's state stays readable this long; a deletion's folder result, for a retry, too. */
const KEEP_MS = 10 * 60_000
const NAME_TRIES = 20

const identityText = z.string().regex(/^\d+:\d+$/u)
const archiveSchema = z.strictObject({
  entries: z.number().int().nonnegative(),
  archived: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
})
const removeSchema = z.strictObject({ removed: z.number().int().nonnegative() })
const failureSchema = z.strictObject({
  error: z.enum(['invalid-input', 'changed', 'unreadable', 'mount', 'busy', 'budget', 'mismatch', 'unwritable', 'too-large']),
  entries: z.number().int().nonnegative().optional(),
  bytes: z.number().int().nonnegative().optional(),
})
type HelperError = z.infer<typeof failureSchema>

/** The helper said no, or did not answer: `code` is what it said, `unavailable` when it could not be run. */
class HomeHelperFailure extends Error {
  constructor(
    readonly code: HelperError['error'] | 'unavailable' | 'cancelled',
    readonly entries?: number,
    readonly bytes?: number,
  ) {
    super(code)
  }
}

export interface HomeHelperRequest {
  root: string
  rootId: string
  helpersId: string
  name: string
  homeId: string
}

/** `latch-home`: one process per operation, an empty environment, a hard deadline. */
export class HomeHelper {
  private constructor(
    readonly available: boolean,
    private readonly binary: string,
  ) {}

  static async open(binary = join(latchCodeRoot(), 'dist/native/latch-home')): Promise<HomeHelper> {
    const info = process.platform === 'darwin' ? await lstat(binary).catch(() => undefined) : undefined
    return new HomeHelper(!!info?.isFile() && !!(info.mode & 0o111), binary)
  }

  archive(request: HomeHelperRequest, top: string, output: FileHandle, signal?: AbortSignal) {
    return this.run({ op: 'archive', ...request, top, seconds: EXPORT_SECONDS }, archiveSchema, output, signal)
  }

  remove(request: HomeHelperRequest, expect?: { entries: number; bytes: number }) {
    return this.run({ op: 'remove', ...request, seconds: REMOVE_SECONDS, ...(expect ? { expect } : {}) }, removeSchema)
  }

  private run<T>(
    input: Record<string, unknown> & { seconds: number },
    schema: z.ZodType<T>,
    output?: FileHandle,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.available) return Promise.reject(new HomeHelperFailure('unavailable'))
    for (const key of ['rootId', 'helpersId', 'homeId']) identityText.parse(input[key])
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, [], { env: {}, stdio: ['pipe', 'pipe', 'ignore', ...(output ? [output.fd] : [])] })
      const stdout = child.stdout!,
        stdin = child.stdin!
      const chunks: Buffer[] = []
      let bytes = 0
      let failure: HomeHelperFailure | undefined
      const stop = (cause: HomeHelperFailure) => {
        failure ??= cause
        child.kill('SIGKILL')
      }
      const aborted = () => stop(new HomeHelperFailure('cancelled'))
      const timer = setTimeout(() => stop(new HomeHelperFailure('budget')), (input.seconds + 5) * 1000)
      signal?.addEventListener('abort', aborted, { once: true })
      stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 4096) stop(new HomeHelperFailure('unavailable'))
        else chunks.push(chunk)
      })
      stdout.on('error', () => stop(new HomeHelperFailure('unavailable')))
      stdin.on('error', () => {})
      child.once('error', () => {
        failure ??= new HomeHelperFailure('unavailable')
      })
      child.once('close', code => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
        if (failure) return reject(failure)
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (code === 0) return resolve(schema.parse(value))
          const parsed = failureSchema.parse(value)
          reject(new HomeHelperFailure(parsed.error, parsed.entries, parsed.bytes))
        } catch {
          reject(new HomeHelperFailure('unavailable'))
        }
      })
      stdin.end(JSON.stringify(input))
      if (signal?.aborted) aborted()
    })
  }
}

/**
 * Reads back the archive's end record and central directory through the handle it was written to: stored entries
 * only, `archived` of them, holding `bytes` in all, the directory ending the file exactly. Anything else fails.
 */
async function verifyArchive(handle: FileHandle, expected: { archived: number; bytes: number }): Promise<boolean> {
  const size = (await handle.stat()).size
  if (size < 22 || size > 0xffff_ffff) return false
  const end = Buffer.alloc(22)
  await handle.read(end, 0, 22, size - 22)
  if (end.readUInt32LE(0) !== 0x06054b50 || end.readUInt16LE(20) !== 0) return false
  const count = end.readUInt16LE(10),
    directorySize = end.readUInt32LE(12),
    directoryStart = end.readUInt32LE(16)
  if (count !== end.readUInt16LE(8) || count !== expected.archived || directoryStart + directorySize !== size - 22) return false
  const directory = Buffer.alloc(directorySize)
  await handle.read(directory, 0, directorySize, directoryStart)
  let offset = 0,
    entries = 0,
    total = 0
  while (offset < directorySize) {
    if (offset + 46 > directorySize || directory.readUInt32LE(offset) !== 0x02014b50) return false
    const method = directory.readUInt16LE(offset + 10),
      compressed = directory.readUInt32LE(offset + 20),
      plain = directory.readUInt32LE(offset + 24),
      local = directory.readUInt32LE(offset + 42)
    if (method !== 0 || compressed !== plain || local >= directoryStart) return false
    total += plain
    entries++
    offset += 46 + directory.readUInt16LE(offset + 28) + directory.readUInt16LE(offset + 30) + directory.readUInt16LE(offset + 32)
  }
  return offset === directorySize && entries === expected.archived && total === expected.bytes
}

/** The archive's folder name inside the zip and the start of the file's name: the Agent's name, made safe for both. */
export function archiveLabel(name: string | undefined): string {
  const cleaned = (name ?? '')
    .replace(/[/\\:\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^\.+/u, '')
    .trim()
  const short = [...cleaned].slice(0, 60).join('').trim()
  return short || 'Agent'
}

/** A home's audit identity: the hashes of its directory name and of its start directory; never a path. */
const homeDetail = (home: Pick<RecordedHome, 'owner' | 'name' | 'rootHash'>) => ({
  customAgentId: home.owner,
  homeHash: sha256Hex(canonicalJson(`helpers/${home.name}`)),
  rootHash: home.rootHash,
})

type HomeIds = { customAgentId: string; homeHash: string; rootHash: string }
/** The audit lines a home's export or removal writes: ids, hashes, an outcome and counts, never a path or a name. */
export type FolderAuditEvent =
  | { action: 'agent.folder.removing'; detail: HomeIds }
  | { action: 'agent.folder.removed'; detail: HomeIds & { outcome: AgentHomeOutcome; entries: number } }
  | { action: 'agent.folder.exporting'; detail: HomeIds & { exportHash: string; destinationHash: string } }
  | {
      action: 'agent.folder.exported'
      detail: HomeIds & {
        exportHash: string
        outcome: 'done' | 'failed' | 'cancelled' | 'too-large' | 'changed'
        entries: number
        bytes: number
      }
    }
/** Writes one line; throws when it could not be written. */
export type FolderAudit = (event: FolderAuditEvent) => Promise<void>

export interface AgentFolderDeps {
  folders: SessionFolders
  helper: () => Promise<HomeHelper>
  /** Every folder the Host recorded for a session: the only source of a path under another start directory. */
  sessionFolders: () => Promise<string[]>
  /** Whether a running or waiting session, or a terminal, uses this canonical path or anything inside it. */
  inUse: (canonical: string) => Promise<boolean>
  now?: () => number
  log: (text: string) => void
}

interface ExportJob {
  state: AgentFolderExport
  deviceId: string
  controller: AbortController
  ended: Promise<void>
  at: number
}

interface Archived {
  home: LocatedHome
  entries: number
  bytes: number
}

/** Agent homes: what is in them, removing them, exporting them, and the ones whose Agent is already gone. */
export class AgentFolders {
  private readonly results = new Map<string, { at: number; result: Promise<AgentFolderResult> }>()
  private readonly jobs = new Map<string, ExportJob>()
  private exporting = false
  private closing = false

  constructor(private readonly deps: AgentFolderDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private async locate(home: RecordedHome): Promise<LocatedHome | 'absent' | 'unverified'> {
    return this.deps.folders.locateHome(home, await this.deps.sessionFolders())
  }

  private async homesOf(owner: string): Promise<RecordedHome[]> {
    return (await this.deps.folders.recordedHomes()).filter(home => home.owner === owner)
  }

  /** Whether the Agent's homes that can be touched hold anything: `none` when there is no such home. */
  async contents(owner: string): Promise<'none' | 'empty' | 'files'> {
    let found: 'none' | 'empty' | 'files' = 'none'
    for (const home of await this.homesOf(owner)) {
      const located = await this.locate(home)
      if (typeof located === 'string') continue
      const names = await readdir(located.path).catch(() => ['?'])
      if (names.length) return 'files'
      found = 'empty'
    }
    return found
  }

  /**
   * After the Agent is gone: each of its recorded homes removed (`delete`), or kept as they are (no choice: a page
   * from before this choice existed, which still says the folder stays). A retry of the same request gets the same
   * answer instead of a second pass.
   */
  afterDeletion(owner: string, requestId: string, choice: 'delete' | undefined, audit: FolderAudit): Promise<AgentFolderResult> {
    for (const [key, kept] of this.results) if (this.now() - kept.at > KEEP_MS) this.results.delete(key)
    const key = `${owner}:${requestId}`
    const known = this.results.get(key)
    if (known) return known.result
    const result =
      choice === 'delete'
        ? this.removeAll(owner, audit)
        : this.homesOf(owner).then(homes => (homes.length ? { outcome: 'kept' as const, removed: 0, left: homes.length } : none()))
    this.results.set(key, { at: this.now(), result })
    result.catch(() => this.results.delete(key))
    return result
  }

  private async removeAll(owner: string, audit: FolderAudit, expect?: Map<string, Archived>): Promise<AgentFolderResult> {
    const outcomes: AgentHomeOutcome[] = []
    for (const home of await this.homesOf(owner)) {
      const archived = expect?.get(home.rootHash)
      outcomes.push(await this.removeOne(home, audit, archived && { entries: archived.entries, bytes: archived.bytes }))
    }
    return summarize(outcomes)
  }

  /** One recorded home: removed if it is still the one recorded and nothing uses it, else left and reported. */
  private async removeOne(home: RecordedHome, audit: FolderAudit, expect?: { entries: number; bytes: number }): Promise<AgentHomeOutcome> {
    const report = async (outcome: AgentHomeOutcome, entries = 0) => {
      await audit({ action: 'agent.folder.removed', detail: { ...homeDetail(home), outcome, entries } }).catch(error =>
        this.deps.log(`Agent 文件夹的删除结果没有写入审计：${error instanceof Error ? error.message : String(error)}`),
      )
      return outcome
    }
    const located = await this.locate(home)
    if (located === 'absent') {
      await this.deps.folders.forgetHome(home).catch(() => {})
      return report('absent')
    }
    if (located === 'unverified') return report('unverified')
    if (await this.deps.inUse(await canonicalPath(located.path).catch(() => located.path))) return report('in-use')
    const helper = await this.deps.helper()
    if (!helper.available) return report('unavailable')
    try {
      await audit({ action: 'agent.folder.removing', detail: homeDetail(home) })
    } catch {
      // Removing for good leaves a record first; without one the folder stays, to be removed from 设置 › 数据 later.
      return report('audit-failed')
    }
    try {
      const { removed } = await helper.remove(requestOf(located), expect)
      await this.deps.folders
        .forgetHome(home)
        .catch(error => this.deps.log(`已删除的 Agent 文件夹没有从记录中移除：${error instanceof Error ? error.message : String(error)}`))
      return report('deleted', removed)
    } catch (error) {
      return report(error instanceof HomeHelperFailure ? helperOutcome(error.code) : 'failed')
    }
  }

  /**
   * The homes of Agents that are gone, that can be touched now. Only from a store read in full: while a write to the
   * Agents is unconfirmed (`agents` throws) nothing is listed, so no home is ever taken for one whose Agent is gone.
   */
  async leftovers(agents: () => ReadonlySet<string>): Promise<Array<LeftoverAgentFolder & { home: RecordedHome }>> {
    const existing = agents()
    const found: Array<LeftoverAgentFolder & { home: RecordedHome }> = []
    for (const home of await this.deps.folders.recordedHomes()) {
      if (home.owner === 'general' || existing.has(home.owner)) continue
      const located = await this.locate(home)
      if (typeof located === 'string') continue
      const names = await readdir(located.path).catch(() => undefined)
      if (names === undefined) continue
      found.push({ key: leftoverKey(home), path: located.path, contents: names.length ? 'files' : 'empty', home })
    }
    return found
  }

  /** 设置 › 数据: one leftover home removed for good, if its Agent is still gone. */
  async removeLeftover(key: string, agents: () => ReadonlySet<string>, audit: FolderAudit): Promise<AgentFolderResult> {
    const found = (await this.leftovers(agents)).find(item => item.key === key)
    if (!found) throw new AppError(404, 'agent-folder-not-found', '找不到这个文件夹，或它已不能删除。')
    return summarize([await this.removeOne(found.home, audit)])
  }

  /**
   * 导出后删除: each home of `owner` (or the one leftover `key`) that holds anything is written into a new zip archive in
   * `parent`; once every archive is verified, `then` runs (the Agent's deletion) and the homes are removed, each only if
   * it still holds what was archived. A failed or cancelled export removes its own archive and deletes nothing.
   */
  async startExport(input: {
    deviceId: string
    requestId: string
    target: { owner: string } | { key: string; agents: () => ReadonlySet<string> }
    label: string
    parent: string
    audit: FolderAudit
    recheck: () => void
    then?: () => Promise<void>
  }): Promise<AgentFolderExport> {
    if (this.closing) throw new AppError(503, 'host-closing', '运行节点正在关闭')
    this.forgetOld()
    const id = sha256Hex(`${input.deviceId}\n${input.requestId}`).slice(0, 32)
    const known = this.jobs.get(id)
    if (known) return this.get(input.deviceId, input.requestId)
    if (this.exporting || [...this.jobs.values()].some(job => job.state.state === 'running'))
      throw new AppError(409, 'export-busy', '另一次导出还在进行，等它结束后再试。')
    this.exporting = true
    try {
      const parent = await realpath(input.parent).catch(() => undefined)
      const info = parent === undefined ? undefined : await lstat(parent).catch(() => undefined)
      if (!parent || !info?.isDirectory()) throw new AppError(400, 'export-folder-invalid', '选择的位置不是一个文件夹。')
      let homes: RecordedHome[]
      if ('owner' in input.target) homes = await this.homesOf(input.target.owner)
      else {
        const key = input.target.key
        const found = (await this.leftovers(input.target.agents)).find(item => item.key === key)
        if (!found) throw new AppError(404, 'agent-folder-not-found', '找不到这个文件夹，或它已不能删除。')
        homes = [found.home]
      }
      const located: LocatedHome[] = []
      for (const home of homes) {
        const found = await this.locate(home)
        if (typeof found === 'string') continue
        if (await this.deps.inUse(await canonicalPath(found.path).catch(() => found.path)))
          throw new AppError(409, 'agent-folder-in-use', '这个 Agent 还有会话在运行或打开着终端，结束后再导出。')
        located.push(found)
      }
      const helper = await this.deps.helper()
      if (located.length && !helper.available)
        throw new AppError(503, 'agent-folder-unavailable', '这台 Host 没有导出 Agent 文件夹的组件。')
      const exportHash = sha256Hex(id)
      input.recheck()
      for (const home of located)
        await input.audit({
          action: 'agent.folder.exporting',
          detail: { ...homeDetail(home), exportHash, destinationHash: sha256Hex(parent) },
        })
      const job: ExportJob = {
        state: { requestId: input.requestId, state: 'running', phase: 'export', archives: [] },
        deviceId: input.deviceId,
        controller: new AbortController(),
        ended: Promise.resolve(),
        at: this.now(),
      }
      this.jobs.set(id, job)
      job.ended = this.runExport(job, located, helper, { ...input, parent, exportHash })
      return this.get(input.deviceId, input.requestId)
    } finally {
      this.exporting = false
    }
  }

  get(deviceId: string, requestId: string): AgentFolderExport {
    const job = this.jobs.get(sha256Hex(`${deviceId}\n${requestId}`).slice(0, 32))
    if (!job || job.deviceId !== deviceId) throw new AppError(404, 'export-not-found', '找不到这次导出。')
    return structuredClone(job.state)
  }

  /** Stops an export still writing; once deletion has begun it runs to its end. */
  async cancel(deviceId: string, requestId: string): Promise<AgentFolderExport> {
    const job = this.jobs.get(sha256Hex(`${deviceId}\n${requestId}`).slice(0, 32))
    if (!job || job.deviceId !== deviceId) throw new AppError(404, 'export-not-found', '找不到这次导出。')
    if (job.state.state === 'running' && job.state.phase === 'export') {
      job.controller.abort()
      await job.ended
    }
    return structuredClone(job.state)
  }

  async close(): Promise<void> {
    this.closing = true
    const running = [...this.jobs.values()].filter(job => job.state.state === 'running')
    for (const job of running) if (job.state.phase === 'export') job.controller.abort()
    await Promise.all(running.map(job => job.ended))
  }

  private forgetOld(): void {
    for (const [id, job] of this.jobs) if (job.state.state !== 'running' && this.now() - job.at > KEEP_MS) this.jobs.delete(id)
  }

  private async runExport(
    job: ExportJob,
    homes: LocatedHome[],
    helper: HomeHelper,
    input: {
      label: string
      parent: string
      exportHash: string
      audit: FolderAudit
      recheck: () => void
      then?: () => Promise<void>
      target: { owner: string } | { key: string }
    },
  ): Promise<void> {
    const archived = new Map<string, Archived>()
    const made: Array<{ path: string; dev: number; ino: number }> = []
    let current: Archived | undefined
    const stamp = new Date(this.now()).toISOString().slice(0, 16).replace('T', ' ').replace(':', '')
    try {
      for (const home of homes) {
        if (job.controller.signal.aborted) throw new HomeHelperFailure('cancelled')
        input.recheck()
        if (!(await readdir(home.path).catch(() => [])).length) continue
        const { handle, path, name } = await createArchive(input.parent, `${input.label} ${stamp}`)
        const info = await handle.stat()
        made.push({ path, dev: info.dev, ino: info.ino })
        try {
          const result = await helper.archive(requestOf(home), input.label, handle, job.controller.signal)
          if (!(await verifyArchive(handle, result))) throw new HomeHelperFailure('changed')
          const atPath = await lstat(path).catch(() => undefined)
          if (!atPath?.isFile() || atPath.dev !== info.dev || atPath.ino !== info.ino) throw new HomeHelperFailure('changed')
          current = { home, entries: result.entries, bytes: result.bytes }
          archived.set(home.rootHash, current)
          job.state.archives!.push(name)
          await input
            .audit({
              action: 'agent.folder.exported',
              detail: { ...homeDetail(home), exportHash: input.exportHash, outcome: 'done', entries: result.entries, bytes: result.bytes },
            })
            .catch(() => this.deps.log('Agent 文件夹的导出结果没有写入审计'))
        } finally {
          await handle.close()
        }
      }
    } catch (error) {
      const failure = error instanceof HomeHelperFailure ? error : new HomeHelperFailure('unavailable')
      const failed = homes.find(home => !archived.has(home.rootHash))
      if (failed)
        await input
          .audit({
            action: 'agent.folder.exported',
            detail: {
              ...homeDetail(failed),
              exportHash: input.exportHash,
              outcome: exportOutcome(failure.code),
              entries: failure.entries ?? 0,
              bytes: failure.bytes ?? 0,
            },
          })
          .catch(() => this.deps.log('Agent 文件夹的导出结果没有写入审计'))
      // Only the archives this export made, each still the file it created.
      for (const file of made) {
        const info = await lstat(file.path).catch(() => undefined)
        if (info?.isFile() && info.dev === file.dev && info.ino === file.ino) await unlink(file.path).catch(() => {})
      }
      job.state = {
        ...job.state,
        archives: [],
        state: failure.code === 'cancelled' ? 'cancelled' : 'failed',
        code: exportCode(failure.code),
        ...(failure.code === 'too-large' && failure.bytes !== undefined ? { bytes: failure.bytes } : {}),
      }
      job.at = this.now()
      return
    }
    // Every archive is closed and verified: only now is anything deleted.
    job.state.phase = 'delete'
    try {
      input.recheck()
      await input.then?.()
      const result =
        'owner' in input.target
          ? await this.removeAll(input.target.owner, input.audit, archived)
          : summarize([await this.removeOne(homes[0]!, input.audit, current && { entries: current.entries, bytes: current.bytes })])
      job.state = { ...job.state, state: 'done', folder: result }
    } catch (error) {
      job.state = { ...job.state, state: 'failed', code: error instanceof AppError ? error.code : 'agent-delete-failed' }
    }
    job.at = this.now()
  }
}

function requestOf(home: LocatedHome): HomeHelperRequest {
  return { root: home.root, rootId: home.ids.root, helpersId: home.ids.helpers, name: home.name, homeId: home.ids.home }
}

/** A new archive file in `parent`, created exclusively and privately, never through a link: `<label> <time>.zip`, then ` 2`… */
async function createArchive(parent: string, base: string): Promise<{ handle: FileHandle; path: string; name: string }> {
  for (let index = 1; index <= NAME_TRIES; index++) {
    const name = `${base}${index > 1 ? ` ${index}` : ''}.zip`
    const path = join(parent, name)
    try {
      const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      return { handle, path, name }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw new HomeHelperFailure('unwritable')
    }
  }
  throw new HomeHelperFailure('unwritable')
}

function leftoverKey(home: Pick<RecordedHome, 'rootHash' | 'owner'>): string {
  return sha256Hex(`${home.rootHash}/${home.owner}`).slice(0, 32)
}

function helperOutcome(code: HomeHelperFailure['code']): AgentHomeOutcome {
  if (code === 'changed' || code === 'mismatch' || code === 'invalid-input') return 'unverified'
  if (code === 'mount') return 'mount'
  if (code === 'unavailable') return 'unavailable'
  if (code === 'too-large') return 'too-large'
  return 'failed'
}

function exportOutcome(code: HomeHelperFailure['code']): 'failed' | 'cancelled' | 'too-large' | 'changed' {
  if (code === 'cancelled') return 'cancelled'
  if (code === 'too-large') return 'too-large'
  if (code === 'changed' || code === 'mismatch' || code === 'mount') return 'changed'
  return 'failed'
}

function exportCode(code: HomeHelperFailure['code']): string {
  if (code === 'cancelled') return 'export-cancelled'
  if (code === 'too-large') return 'agent-folder-too-large'
  if (code === 'changed' || code === 'mismatch') return 'agent-folder-changed'
  if (code === 'mount') return 'agent-folder-mount'
  if (code === 'unwritable') return 'export-folder-invalid'
  return 'export-failed'
}

const none = (): AgentFolderResult => ({ outcome: 'none', removed: 0, left: 0 })

/** Many homes as one answer: removed, nothing there, or left (with the first reason). */
function summarize(outcomes: AgentHomeOutcome[]): AgentFolderResult {
  const removed = outcomes.filter(outcome => outcome === 'deleted').length
  const left = outcomes.filter(outcome => outcome !== 'deleted' && outcome !== 'absent')
  if (left.length) return { outcome: 'left', reason: left[0], removed, left: left.length }
  return removed ? { outcome: 'deleted', removed, left: 0 } : none()
}
