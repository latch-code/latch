// The desktop app's file actions: 在访达中显示, 快速查看, 用默认应用打开 and 在编辑器中打开 for a file a message refers to. Only the desktop
// app's main process calls these routes, over host.sock with its own device credential; the shell proxy refuses them
// from the page (apps/desktop/src/proxy.cjs). The Host decides whether the file is a regular file inside the session's
// folders and what may be done with it, records the action in the audit log, and only then tells main the real path.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { stat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  FILE_EDIT_LIMIT,
  imageDimensions,
  isLocalListener,
  type Device,
  type DeviceScope,
  type ListenerClass,
  type TaskDetail,
  type FileContext,
  type FileDirectoryListing,
  type FileEditResult,
  readsProjectFiles,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { sha256Hex } from '@latch/core/node-kit'
import { authFailure, localOnly, scopeRequired, type RateLimiter } from '../access.ts'
import type { AuditActor, AuditLog } from '../audit.ts'
import { KIB, json, jsonBody, safeDecode } from '../http-util.ts'
import { FileHandles, HANDLE, type HandleEntry } from './handles.ts'
import { type FileDirectoryReader, validDirectory } from './directory.ts'
import { auditType } from './kinds.ts'
import { mixedLineEndings, readCurrent, replaceFile, shapeContent, sha256, fileChanged, validContent } from './edit.ts'
import { isInsidePath, isProtectedWorkspacePath } from '../paths.ts'
import { canTruncate, contentLimit, fileEtag, fileFormat } from './metadata.ts'
import { isReferenced, isReferenceListed, outsideReference, sessionReferences } from './references.ts'
import { outsideKey, resolveOutside, type OutsideBinding, type OutsideGuard } from './outside.ts'
import { openContent, sendContent } from './read.ts'
import { FileReadQuota } from './quota.ts'
import { FileSearchIndex, tooManyHung, trackHung } from './search.ts'
import { GREP_LIMITS, GREP_QUERY_MAX, grepFiles, type GrepLimits } from './grep.ts'
import {
  ProtectedPaths,
  fileVerdicts,
  parseReference,
  resolveRecorded,
  resolveReference,
  type ResolvedFile,
  type FileRoot,
  type ResolveOptions,
  type ResolveStatus,
} from './resolve.ts'

export type { FileRoot } from './resolve.ts'

/** References one resolve request may carry. */
export const RESOLVE_LIMIT = 64
const FILE_ACTIONS = ['reveal', 'quicklook', 'open', 'editor'] as const
export type FileAction = (typeof FILE_ACTIONS)[number]

const resolveSchema = z.strictObject({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(RESOLVE_LIMIT),
  rootId: z.string().min(1).max(32).optional(),
  showSecret: z.boolean().optional(),
})
const searchSchema = z.strictObject({ q: z.string().max(512), limit: z.number().int().min(1).max(100).default(100) })
const editSchema = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  baseHash: z.string().regex(/^[0-9a-f]{64}$/u),
  content: z.string().max(FILE_EDIT_LIMIT),
})
/** JSON escapes at most six bytes for one, and the rest of the body is small. */
const EDIT_BODY_LIMIT = 6 * FILE_EDIT_LIMIT + 4 * KIB
const EDIT_KINDS = new Set(['text', 'code', 'markdown'])
const EDIT_RECEIPTS = 512
const EDIT_RECEIPT_MS = 60 * 60 * 1000
const workspaceResolveSchema = resolveSchema.extend({ harnessId: z.string().min(1).max(128) })
const workspaceSearchSchema = searchSchema.extend({ harnessId: z.string().min(1).max(128) })
/** The text to find is data: literal, one line, never a pattern or an option. */
const grepSchema = z.strictObject({
  q: z.string().min(1).max(GREP_QUERY_MAX),
  caseSensitive: z.boolean().default(false),
  wholeWord: z.boolean().default(false),
})
const workspaceGrepSchema = grepSchema.extend({ harnessId: z.string().min(1).max(128) })
const actSchema = z
  .strictObject({
    sessionId: z.string().min(1).max(256).optional(),
    workspaceId: z.string().min(1).max(256).optional(),
    harnessId: z.string().min(1).max(128).optional(),
    action: z.enum(FILE_ACTIONS),
  })
  .refine(value =>
    value.sessionId ? value.workspaceId === undefined && value.harnessId === undefined : !!value.workspaceId && !!value.harnessId,
  )

/** Why a reference is not a file the Host will act on, as the error code the clients' copy is chosen by. */
const STATUS_CODE: Record<Exclude<ResolveStatus, 'ok'>, { status: number; code: string; message: string }> = {
  missing: { status: 404, code: 'file-missing', message: '找不到这个文件' },
  outside: { status: 403, code: 'file-outside-folders', message: '这个文件不在会话的文件夹里' },
  protected: { status: 403, code: 'file-protected', message: '这是 Latch 的私有数据' },
  folder: { status: 409, code: 'file-folder', message: '这是文件夹' },
  'not-file': { status: 409, code: 'file-not-regular', message: '这不是普通文件' },
  unreadable: { status: 403, code: 'file-unreadable', message: 'Latch 没有读取这个文件的权限' },
  invalid: { status: 400, code: 'file-invalid', message: '这不是有效的文件路径' },
}
const REFUSAL_MESSAGE = {
  'file-secret': '这个文件可能含密钥，Latch 不替你打开它',
  'file-type-refused': '为安全起见，Latch 不直接打开这种文件',
  'file-preview-unverified': '快速查看暂不用于这种文件：还没有确认系统的预览不会加载文件里引用的网络资源',
  'file-content-mismatch': '文件内容与扩展名不符，Latch 不直接打开它',
  'file-not-text': '这不是文本文件，Latch 不用编辑器打开它',
} as const

interface FileCaller {
  connection: { listener: ListenerClass }
  device?: Device
}

/** What a person's edit of a session file needs from the rest of the Host. */
export interface FileEditHooks {
  /** What sending input to the session needs: the run scope, the session's access, not archived, its folders there. */
  assertInput(caller: FileCaller, sessionId: string): Promise<void>
  /**
   * A turn runs in a folder that holds `realPath`: this session's, or another session's in the same folder. `wait`:
   * a turn of the session still being recorded is waited for; without it (under the changes lock) it counts as running.
   */
  turnRunning(sessionId: string, realPath: string, wait: boolean): Promise<boolean>
  /** The session takes input: false for a read-only one (from a removed Agent), which offers no editing. */
  writable(sessionId: string): boolean
  /**
   * Runs `write` under the changes engine's lock, then records the edit for 「你的修改」 and the next turn's note.
   * `write` answers the new content's hash, or undefined when it wrote nothing.
   */
  record(
    sessionId: string,
    file: { root: string; path: string; display: string },
    write: () => Promise<string | undefined>,
  ): Promise<{ noteNextTurn: boolean }>
}

export interface FileRoutesOptions {
  /** The person's text edits (`PUT tasks/:id/files/:handle`); without them the route does not exist. */
  edits?: FileEditHooks
  /** The Latch program folder (canonical): its files are never edited here. */
  codeRoot?: string
  requestSignal?(caller: FileCaller): AbortSignal | undefined
  contentChunkBytes?(caller: FileCaller): 65_536 | undefined
  /** Latch's private paths: the same list the built-in file tools refuse. */
  protectedPaths: readonly string[]
  /**
   * Files a session's messages named outside its folders (`outside.ts`): `excluded` are never opened (Latch's data and
   * program folders, credential stores), `cliHomes` show everything but their login files and databases. Without it none are opened.
   */
  outsidePaths?: { excluded: readonly string[]; cliHomes: readonly string[] }
  home: string
  now: () => number
  audit: Pick<AuditLog, 'append'>
  limiter: Pick<RateLimiter, 'take'>
  /**
   * The session's folders, primary first; undefined when the Host has no such session, `removed` when its folder is no
   * longer the start directory or a registered, enabled project.
   */
  sessionRoots(sessionId: string): Promise<FileRoot[] | 'removed' | undefined>
  /** Additional session privacy gates (for example an agent's memory); applies also to an already issued handle. */
  sessionAccess?(caller: FileCaller, sessionId: string): void | Promise<void>
  workspaceRoots?(workspaceId: string, harnessId: string): Promise<FileRoot[] | 'removed' | undefined>
  /** Synchronous configuration generation, checked again after every awaited operation. */
  contextRevision?(context: FileContext): string
  directoryReader?: FileDirectoryReader
  /** Throws when the device was revoked, lost the scope or no longer has the data scope all while the request waited. */
  recheck(caller: FileCaller, scope: DeviceScope): void
  actorOf(caller: FileCaller): AuditActor
  /** Persisted session history supplies the references a work-scope device may read. */
  sessionDetail?(sessionId: string): Promise<TaskDetail>
  referencePaths?(sessionId: string, roots: readonly FileRoot[]): Promise<ReadonlySet<string>>
  /** Test seam only; the Host never sets it. */
  hooks?: ResolveOptions['hooks']
  /** Test seam only: runs after an edit's temporary file is written, before the final check and the rename. */
  editHooks?: { beforeRename?(): Promise<void> }
  /** Test seam only: smaller bounds for the content search. */
  grepLimits?: GrepLimits
  /** Test seam only: how long a content search may hold its slot. */
  grepSlotMs?: number
}

/** Desktop app on host.sock, a device with the scope and the data scope `all` (the whole of the session's folders). */
function admit(caller: FileCaller, scope: DeviceScope): asserts caller is FileCaller & { device: Device } {
  if (!isLocalListener(caller.connection.listener)) throw localOnly()
  if (!caller.device) throw authFailure('unauthorized')
  if (!caller.device.scopes.includes(scope)) throw scopeRequired(scope)
  if (!readsProjectFiles(caller.device.dataScope)) throw new AppError(403, 'file-scope', '这台设备的数据范围不包括会话文件夹中的文件')
}

function admitRead(caller: FileCaller): asserts caller is FileCaller & { device: Device } {
  if (!caller.device) throw authFailure('unauthorized')
  if (!caller.device.scopes.includes('view')) throw scopeRequired('view')
}

const scopeOf = (action: FileAction): DeviceScope => (action === 'open' || action === 'editor' ? 'run' : 'view')

const EDIT_REFUSALS = {
  'file-edit-elevated': { status: 403, message: '这个文件需要能批准高风险操作的设备。' },
  'file-mixed-eol': { status: 409, message: '混用换行符的文件不能在这里编辑。' },
} as const
type EditRefusal = keyof typeof EDIT_REFUSALS

/**
 * Writes Latch treats as R2 (its own code, hooks, manifests, CI, agent settings, environment files) require a device
 * that may approve R2. Selecting Latch's source as a project does not grant that scope.
 */
export function editProtection(
  device: Device,
  file: Pick<ResolvedFile, 'realPath' | 'relativePath'>,
  root: FileRoot,
  codeRoot: string | undefined,
): { protection: 'none' | 'protected-path' } | { refusal: EditRefusal } {
  const code =
    codeRoot !== undefined
    && (isInsidePath(file.realPath, codeRoot) || isInsidePath(root.path, codeRoot) || isInsidePath(codeRoot, root.path))
  if (!code && !isProtectedWorkspacePath(file.relativePath, root.path)) return { protection: 'none' }
  return device.scopes.includes('approve:elevated') ? { protection: 'protected-path' } : { refusal: 'file-edit-elevated' }
}
const refuseEdit = (code: EditRefusal) => new AppError(EDIT_REFUSALS[code].status, code, EDIT_REFUSALS[code].message)

export function createFileRoutes(options: FileRoutesOptions) {
  const handles = new FileHandles(options.now)
  const guard = new ProtectedPaths(options.protectedPaths)
  const outsideGuard: OutsideGuard | undefined = options.outsidePaths
    ? { excluded: new ProtectedPaths(options.outsidePaths.excluded), cliHomes: new ProtectedPaths(options.outsidePaths.cliHomes) }
    : undefined
  const searchIndex = new FileSearchIndex()
  const quota = new FileReadQuota(options.now)
  const audited = new Map<string, number>()
  /** Answers to edits by device, session and request ID, so a retry gets the same answer instead of a conflict. */
  const editReceipts = new Map<string, { fingerprint: string; until: number; answer: Promise<FileEditResult> }>()
  const pendingListAudits = new Map<string, Promise<void>>()
  let activeEnumerations = 0
  const enumeratingDevices = new Map<string, number>()

  /**
   * Content searches have slots of their own, apart from the tree and the name search: one per device, two at a time for
   * remote callers and two for this Mac's own, so remote searches never leave the local window waiting.
   */
  const searchingDevices = new Set<string>()
  const searchingTotal = { local: 0, remote: 0 }
  /**
   * A search holds its slot at most this long, even when a read or a directory listing never settles (a hung mount):
   * then it is aborted, the slot is freed and the caller is told; whatever was still waiting ends when it settles.
   */
  const slotMs = () => options.grepSlotMs ?? (options.grepLimits?.ms ?? GREP_LIMITS.ms) + 7000
  async function searching(caller: FileCaller, operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    admitRead(caller)
    if (!readsProjectFiles(caller.device.dataScope))
      throw new AppError(403, 'file-scope', '这台设备只能打开本会话提到过的文件，不能搜索文件内容')
    const id = caller.device.id,
      side = isLocalListener(caller.connection.listener) ? 'local' : 'remote'
    // While file operations that timed out still hang (a hung mount), nothing new is started to join them.
    if (searchingDevices.has(id) || searchingTotal[side] >= 2 || tooManyHung())
      throw new AppError(429, 'file-grep-busy', '正在进行的内容搜索过多，请稍后再试')
    searchingDevices.add(id)
    searchingTotal[side]++
    const hard = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        hard.abort()
        trackHung(running)
        reject(new AppError(503, 'file-grep-timeout', '内容搜索没有及时结束，请稍后再试'))
      }, slotMs())
      timer.unref()
    })
    const running = operation(hard.signal)
    running.catch(() => {})
    expired.catch(() => {})
    try {
      await Promise.race([running, expired])
    } finally {
      clearTimeout(timer)
      searchingTotal[side]--
      searchingDevices.delete(id)
    }
  }

  async function enumerate(caller: FileCaller, operation: () => Promise<void>): Promise<void> {
    admitRead(caller)
    if (!readsProjectFiles(caller.device.dataScope))
      throw new AppError(403, 'file-scope', '这台设备没有枚举项目文件夹的权限，只能打开本会话提到过的文件')
    const id = caller.device.id,
      active = enumeratingDevices.get(id) ?? 0
    if (activeEnumerations >= 4 || active >= 2) throw new AppError(429, 'file-list-busy', '同时读取的文件夹过多，请稍后再试')
    activeEnumerations++
    enumeratingDevices.set(id, active + 1)
    try {
      await operation()
    } finally {
      activeEnumerations--
      const remaining = enumeratingDevices.get(id)! - 1
      if (remaining === 0) enumeratingDevices.delete(id)
      else enumeratingDevices.set(id, remaining)
    }
  }

  const sessionContext = (sessionId: string): FileContext => ({ kind: 'session', sessionId })
  function entryContext(entry: HandleEntry): FileContext {
    if (entry.workspaceId && entry.harnessId) return { kind: 'workspace', workspaceId: entry.workspaceId, harnessId: entry.harnessId }
    if (entry.sessionId) return sessionContext(entry.sessionId)
    throw new AppError(410, 'file-handle-expired', '文件已不可用，请重新打开')
  }
  const contextKey = (context: FileContext) => (context.kind === 'session' ? context.sessionId : context.workspaceId)
  const revisionOf = (context: FileContext) => options.contextRevision?.(context) ?? ''
  function check(caller: FileCaller, context: FileContext, revision: string): void {
    options.recheck(caller, 'view')
    if (revision !== revisionOf(context)) throw new AppError(409, 'file-roots-changed', '项目或 Agent 的文件夹配置已变化，请重新打开')
    if (context.kind === 'workspace' && !readsProjectFiles(caller.device?.dataScope))
      throw new AppError(403, 'file-scope', '这台设备只能打开本会话提到过的文件，不能浏览项目文件夹')
  }
  async function contextRoots(caller: FileCaller, context: FileContext, checkAccess: () => void): Promise<FileRoot[]> {
    if (context.kind === 'session') {
      await options.sessionAccess?.(caller, context.sessionId)
      checkAccess()
    }
    const roots =
      context.kind === 'session' ? await rootsOf(context.sessionId) : await options.workspaceRoots?.(context.workspaceId, context.harnessId)
    if (context.kind === 'session') await options.sessionAccess?.(caller, context.sessionId)
    checkAccess()
    if (!roots) throw new AppError(404, 'workspace-not-found', '找不到该项目')
    if (roots === 'removed') throw new AppError(409, 'file-folder-removed', '这个项目的文件夹已不可用')
    const canonical = []
    for (const root of roots) {
      const path = await realpath(root.path).catch(() => undefined)
      checkAccess()
      if (!path) throw new AppError(409, 'file-folder-removed', '文件夹已不可用')
      canonical.push({ id: root.id, path })
    }
    return canonical
  }
  async function rootsHash(roots: readonly FileRoot[], checkAccess: () => void): Promise<string> {
    const identities = []
    for (const root of roots) {
      const info = await stat(root.path, { bigint: true }).catch(() => undefined)
      checkAccess()
      if (!info?.isDirectory()) throw new AppError(409, 'file-folder-removed', '文件夹已不可用')
      identities.push([root.id, root.path, String(info.dev), String(info.ino)])
    }
    return sha256Hex(JSON.stringify(identities))
  }
  async function contextLease(caller: FileCaller, context: FileContext, entry?: HandleEntry) {
    const revision = entry?.revision ?? revisionOf(context)
    options.recheck(caller, 'view')
    const roots = await contextRoots(caller, context, () => options.recheck(caller, 'view'))
    check(caller, context, revision)
    const hash = await rootsHash(roots, () => check(caller, context, revision))
    check(caller, context, revision)
    if (entry?.rootsHash !== undefined && entry.rootsHash !== hash)
      throw new AppError(409, 'file-roots-changed', '文件夹已变化，请重新打开')
    return {
      roots,
      hash,
      revision,
      check: () => check(caller, context, revision),
      async recheck() {
        check(caller, context, revision)
        const current = await contextRoots(caller, context, () => check(caller, context, revision))
        check(caller, context, revision)
        const currentHash = await rootsHash(current, () => check(caller, context, revision))
        check(caller, context, revision)
        if (hash !== currentHash) throw new AppError(409, 'file-roots-changed', '文件夹已变化，请重新打开')
      },
    }
  }

  async function referencesOf(sessionId: string, roots: readonly FileRoot[]): Promise<ReadonlySet<string>> {
    if (options.referencePaths) return options.referencePaths(sessionId, roots)
    return options.sessionDetail ? sessionReferences(await options.sessionDetail(sessionId), roots, options.home) : new Set()
  }

  /** A handle's file again: a folder's by its recorded path, a named outside file by its binding. */
  function resolveEntry(entry: HandleEntry, roots: readonly FileRoot[]) {
    if (entry.outside) {
      if (!outsideGuard) return Promise.resolve({ status: 'missing' as const })
      return resolveOutside(entry.outside.path, outsideGuard, { expect: entry.outside, ...(options.hooks ? { hooks: options.hooks } : {}) })
    }
    return resolveRecorded(entry.rootId, entry.relativePath, {
      roots,
      protectedPaths: guard,
      home: options.home,
      ...(options.hooks ? { hooks: options.hooks } : {}),
    })
  }

  /** Every device, whatever its data scope, opens an outside file only while the session's messages name it. */
  async function assertNamed(context: FileContext, roots: readonly FileRoot[], binding: OutsideBinding): Promise<void> {
    if (
      context.kind !== 'session'
      || !options.sessionDetail
      || !(await referencesOf(context.sessionId, roots)).has(outsideKey(binding.path))
    )
      throw new AppError(403, 'file-not-referenced', '这台设备只能查看本会话提到过的文件')
  }

  /** Where the file is, as the client shows it: a folder's relative path, or an outside file's name and folder. */
  const placeOf = (file: ResolvedFile, outside: OutsideBinding | undefined) =>
    outside ? { path: basename(outside.path), folder: dirname(outside.path) } : { path: file.relativePath }

  async function auditRead(
    caller: FileCaller & { device: Device },
    context: FileContext,
    file: ResolvedFile,
    limit: number,
    grep?: { lines: number },
  ): Promise<void> {
    if (isLocalListener(caller.connection.listener)) return
    const key = JSON.stringify([caller.device.id, context, file.rootId, file.relativePath])
    const now = options.now()
    for (const [id, until] of audited) if (until <= now) audited.delete(id)
    if (audited.has(key)) return
    options.recheck(caller, 'view')
    await options.audit.append({
      action: 'file.view',
      actor: options.actorOf(caller),
      target: contextKey(context),
      detail: {
        ...(context.kind === 'session'
          ? { sessionId: context.sessionId }
          : { workspaceId: context.workspaceId, harnessId: context.harnessId }),
        pathHash: sha256Hex(file.realPath),
        type: auditType(file.ext),
        bytes: Math.min(file.size, limit),
        ...(grep ? { via: 'grep' as const, lines: grep.lines } : {}),
      },
    })
    if (audited.size >= 4096) audited.delete(audited.keys().next().value!)
    audited.set(key, now + 15 * 60 * 1000)
  }

  async function auditList(
    caller: FileCaller & { device: Device },
    context: FileContext,
    root: FileRoot,
    dir: string,
    hidden: boolean,
    count: number,
    truncated: boolean,
    checkAccess: () => void,
  ) {
    if (isLocalListener(caller.connection.listener)) return
    const key = JSON.stringify(['list', caller.device.id, context, root.id]),
      time = options.now()
    for (const [key, until] of audited) if (until <= time) audited.delete(key)
    if (audited.has(key)) return
    const pending = pendingListAudits.get(key)
    if (pending) {
      await pending
      checkAccess()
      return
    }
    const operation = (async () => {
      checkAccess()
      await options.audit.append({
        action: 'file.list',
        actor: options.actorOf(caller),
        target: contextKey(context),
        detail: {
          ...(context.kind === 'session'
            ? { sessionId: context.sessionId }
            : { workspaceId: context.workspaceId, harnessId: context.harnessId }),
          rootHash: sha256Hex(root.path),
          dirHash: sha256Hex(dir),
          hidden,
          count,
          truncated,
        },
      })
      checkAccess()
      if (audited.size >= 4096) audited.delete(audited.keys().next().value!)
      audited.set(key, time + 15 * 60 * 1000)
    })()
    pendingListAudits.set(key, operation)
    try {
      await operation
    } finally {
      if (pendingListAudits.get(key) === operation) pendingListAudits.delete(key)
    }
  }

  async function rootsOf(sessionId: string): Promise<FileRoot[]> {
    const roots = await options.sessionRoots(sessionId)
    if (!roots) {
      handles.forgetSession(sessionId)
      throw new AppError(404, 'task-not-found', '找不到该会话')
    }
    // A folder that left the projects takes its handles with it.
    if (roots === 'removed') {
      handles.forgetSession(sessionId)
      throw new AppError(409, 'file-folder-removed', '这个会话的文件夹已不在项目中')
    }
    return roots
  }

  /** `POST /tasks/:id/files/resolve { paths }`: what each reference names, with a handle for each regular file. */
  async function resolveFiles(
    req: IncomingMessage,
    res: ServerResponse,
    caller: FileCaller,
    context: FileContext,
    supplied?: z.infer<typeof resolveSchema>,
  ): Promise<void> {
    if (options.sessionDetail) admitRead(caller)
    else admit(caller, 'view')
    const input = supplied ?? resolveSchema.parse(await jsonBody(req, 320 * KIB))
    options.limiter.take(caller.device.id)
    const access = await contextLease(caller, context)
    const { roots } = access
    const references =
      context.kind === 'session' && caller.device.dataScope === 'work' && options.sessionDetail
        ? await referencesOf(context.sessionId, roots)
        : undefined
    access.check()
    const resolveOptions: ResolveOptions = {
      roots: input.rootId ? roots.filter(root => root.id === input.rootId) : roots,
      protectedPaths: guard,
      home: options.home,
      ...(options.hooks ? { hooks: options.hooks } : {}),
    }
    // Outside files exist only in a session's own words; every data scope needs the messages to name them.
    let named = references
    const outsideNamed = async (path: string) => {
      if (context.kind !== 'session' || !outsideGuard || !options.sessionDetail) return undefined
      const parsed = parseReference(path, options.home)
      if (!parsed || !isAbsolute(parsed.path)) return undefined
      named ??= await referencesOf(context.sessionId, roots)
      access.check()
      return outsideReference(path, named, options.home)
    }
    const files = []
    for (const path of [...new Set(input.paths)]) {
      let result: Awaited<ReturnType<typeof resolveReference>> | undefined
      let outside: OutsideBinding | undefined
      if (references && !isReferenceListed(path, references, resolveOptions.roots, options.home)) {
        const target = await outsideNamed(path)
        if (!target) {
          files.push({ input: path, status: 'not-referenced', code: 'file-not-referenced' })
          continue
        }
        result = { status: 'outside' }
      } else {
        access.check()
        result = await resolveReference(path, resolveOptions)
        access.check()
      }
      const position = {
        ...(result.line === undefined ? {} : { line: result.line }),
        ...(result.column === undefined ? {} : { column: result.column }),
      }
      // A folder filter (`rootId`) that leaves no folder answers `missing` for the same path.
      if (result.status === 'outside' || result.status === 'missing') {
        const target = await outsideNamed(path)
        if (target) {
          const found = await resolveOutside(target, outsideGuard!, options.hooks ? { hooks: options.hooks } : {})
          access.check()
          const parsed = parseReference(path, options.home)
          if (parsed?.line !== undefined) position.line = parsed.line
          if (parsed?.column !== undefined) position.column = parsed.column
          if (found.status === 'ok') {
            result = { status: 'ok', file: found.file }
            outside = found.binding
          } else result = found
        }
      }
      if (result.status !== 'ok') {
        files.push({ input: path, status: result.status, code: STATUS_CODE[result.status].code, ...position })
        continue
      }
      const { file } = result
      if (references && !outside && !isReferenced(references, file)) {
        files.push({ input: path, status: 'not-referenced', code: 'file-not-referenced', ...position })
        continue
      }
      const verdicts = fileVerdicts(file)
      const local = isLocalListener(caller.connection.listener)
      const format = fileFormat(file)
      const limit = contentLimit(format.kind, local)
      // A secret outside the folders is never resolved at all; the local override is for a folder's own files.
      const secretAllowed = local && input.showSecret === true && !outside
      const canRead = (!file.secret || secretAllowed) && (file.size <= limit || canTruncate(format.kind))
      const dimensions = format.kind === 'image' ? imageDimensions(file.head, format.mime) : undefined
      const imageTooLarge = !!dimensions && dimensions.width * dimensions.height > (local ? 100_000_000 : 50_000_000)
      const imageUnknown = format.kind === 'image' && !dimensions
      const editableFile =
        !!options.edits
        && !outside
        && context.kind === 'session'
        && options.edits.writable(context.sessionId)
        && !file.secret
        && EDIT_KINDS.has(format.kind)
        && file.size <= FILE_EDIT_LIMIT
      // A text file this device may read but not edit: the client names the reason instead of hiding 编辑.
      const scopeRefusal = !editableFile
        ? undefined
        : !caller.device.scopes.includes('run')
          ? 'file-edit-scope'
          : !readsProjectFiles(caller.device.dataScope)
            ? 'file-edit-data-scope'
            : undefined
      const offered = editableFile && scopeRefusal === undefined
      const editRoot = access.roots.find(root => root.id === file.rootId)
      const gate = offered && editRoot ? editProtection(caller.device, file, editRoot, options.codeRoot) : undefined
      const editRefusal: EditRefusal | undefined =
        gate && 'refusal' in gate ? gate.refusal : offered && mixedLineEndings(file.head) ? 'file-mixed-eol' : undefined
      const editable = offered && !!gate && !editRefusal
      if (options.sessionDetail && canRead) await auditRead(caller, context, file, limit)
      const refused: Record<string, string> = Object.fromEntries(
        Object.entries(verdicts).flatMap(([action, verdict]) => (verdict.ok ? [] : [[action, verdict.code]])),
      )
      if (imageTooLarge || imageUnknown) refused.preview = imageTooLarge ? 'file-too-large' : 'file-image-dimensions'
      if (editRefusal ?? scopeRefusal) refused.edit = (editRefusal ?? scopeRefusal)!
      files.push({
        input: path,
        status: 'ok',
        ...position,
        file: {
          handle: handles.issue({
            deviceId: caller.device.id,
            ...(context.kind === 'session'
              ? { sessionId: context.sessionId }
              : { workspaceId: context.workspaceId, harnessId: context.harnessId }),
            rootsHash: access.hash,
            revision: access.revision,
            rootId: file.rootId,
            relativePath: file.relativePath,
            ...(secretAllowed ? { allowSecret: true as const } : {}),
            ...(outside ? { outside } : {}),
          }),
          name: file.name,
          root: file.rootId,
          ...placeOf(file, outside),
          ext: file.ext,
          size: file.size,
          secret: file.secret,
          ...(options.sessionDetail
            ? {
                ...format,
                mtime: file.mtimeMs,
                etag: fileEtag(file),
                limit,
                ...(file.size > limit && canTruncate(format.kind) ? { truncated: true } : {}),
                ...dimensions,
              }
            : {}),
          actions: {
            reveal: local && verdicts.reveal.ok,
            quicklook: local && verdicts.quicklook.ok,
            open: local && verdicts.open.ok,
            editor: local && verdicts.editor.ok,
            ...(options.sessionDetail
              ? {
                  download: canRead && file.size <= limit && !imageTooLarge,
                  preview: canRead && !imageTooLarge && !imageUnknown && format.kind !== 'binary',
                  ...(options.edits && !outside ? { edit: editable } : {}),
                }
              : {}),
          },
          ...(Object.keys(refused).length ? { refused } : {}),
        },
      })
    }
    await access.recheck()
    json(res, { files })
  }

  /**
   * `POST /files/:handle/local { sessionId, action }`: resolves the handle's file again, checks the action, writes
   * `file.<action>` to the audit log and only then answers with the real path for main to act on. A failed audit
   * write refuses the action.
   */
  async function act(req: IncomingMessage, res: ServerResponse, caller: FileCaller, handle: string): Promise<void> {
    admit(caller, 'view')
    const input = actSchema.parse(await jsonBody(req))
    const scope = scopeOf(input.action)
    admit(caller, scope)
    options.limiter.take(caller.device.id)
    if (!HANDLE.test(handle)) throw new AppError(400, 'file-invalid', '这不是有效的文件路径')
    const found = handles.use(handle, caller.device.id)
    if (!found.ok && found.reason === 'foreign') throw new AppError(403, 'file-handle-foreign', '这个文件句柄不属于这台设备')
    if (!found.ok) throw new AppError(410, 'file-handle-expired', '文件已不可用，请重新打开')
    const context: FileContext = input.sessionId
      ? sessionContext(input.sessionId)
      : { kind: 'workspace', workspaceId: input.workspaceId!, harnessId: input.harnessId! }
    if (JSON.stringify(entryContext(found.entry)) !== JSON.stringify(context))
      throw new AppError(403, 'file-handle-foreign', '这个文件句柄不属于这个上下文')
    const access = await contextLease(caller, context, found.entry)
    const { roots } = access
    const result = await resolveEntry(found.entry, roots)
    access.check()
    if (result.status !== 'ok') {
      const failure = STATUS_CODE[result.status]
      throw new AppError(failure.status, failure.code, failure.message)
    }
    if (found.entry.outside) {
      await assertNamed(context, roots, found.entry.outside)
      access.check()
    }
    const verdict = fileVerdicts(result.file)[input.action]
    if (!verdict.ok) throw new AppError(403, verdict.code, REFUSAL_MESSAGE[verdict.code])
    options.recheck(caller, scope)
    await options.audit.append({
      action: `file.${input.action}`,
      actor: options.actorOf(caller),
      target: contextKey(context),
      detail: {
        ...(context.kind === 'session'
          ? { sessionId: context.sessionId }
          : { workspaceId: context.workspaceId, harnessId: context.harnessId }),
        pathHash: sha256Hex(result.file.realPath),
        type: auditType(result.file.ext),
      },
    })
    await access.recheck()
    options.recheck(caller, scope)
    json(res, { file: { path: result.file.realPath, name: result.file.name, ext: result.file.ext } })
  }

  async function authorizedFile(caller: FileCaller & { device: Device }, handle: string) {
    if (!HANDLE.test(handle)) throw new AppError(400, 'file-invalid', '这不是有效的文件句柄')
    const found = handles.use(handle, caller.device.id)
    if (!found.ok)
      throw new AppError(
        found.reason === 'foreign' ? 403 : 410,
        found.reason === 'foreign' ? 'file-handle-foreign' : 'file-handle-expired',
        '文件已不可用，请重新打开',
      )
    const entry = found.entry
    const context = entryContext(entry)
    const access = await contextLease(caller, context, entry)
    const { roots } = access
    const result = await resolveEntry(entry, roots)
    access.check()
    if (result.status !== 'ok') {
      const failure = STATUS_CODE[result.status]
      throw new AppError(failure.status, failure.code, failure.message)
    }
    const file = result.file
    if (entry.outside) await assertNamed(context, roots, entry.outside)
    else if (
      caller.device.dataScope === 'work'
      && (context.kind !== 'session' || !options.sessionDetail || !isReferenced(await referencesOf(context.sessionId, roots), file))
    )
      throw new AppError(403, 'file-not-referenced', '这台设备只能查看本会话提到过的文件')
    const local = isLocalListener(caller.connection.listener)
    const allowSecret = local && entry.allowSecret === true && !entry.outside
    const format = fileFormat(file)
    const limit = contentLimit(format.kind, local)
    options.recheck(caller, 'view')
    await access.recheck()
    return { file, entry, context, access, local, allowSecret, format, limit }
  }

  async function read(req: IncomingMessage, res: ServerResponse, caller: FileCaller, handle: string, meta: boolean): Promise<void> {
    admitRead(caller)
    options.limiter.take(caller.device.id)
    const lease = quota.begin(caller.device.id, isLocalListener(caller.connection.listener))
    try {
      const { file, entry, context, access, local, allowSecret, format, limit } = await authorizedFile(caller, handle)
      if (meta) {
        const fd = await openContent(file, true)
        await fd.close()
        await access.recheck()
        json(res, {
          file: {
            handle,
            name: file.name,
            root: file.rootId,
            ...placeOf(file, entry.outside),
            ext: file.ext,
            ...format,
            size: file.size,
            mtime: file.mtimeMs,
            etag: fileEtag(file),
            secret: file.secret,
            limit,
            ...(format.kind === 'image' ? imageDimensions(file.head, format.mime) : {}),
          },
        })
        return
      }
      if (file.secret && !allowSecret) throw new AppError(403, 'file-secret', '这个文件可能含密钥，只在运行 Latch 的电脑上确认显示')
      const dimensions = format.kind === 'image' ? imageDimensions(file.head, format.mime) : undefined
      if (dimensions && dimensions.width * dimensions.height > (local ? 100_000_000 : 50_000_000))
        throw new AppError(413, 'file-too-large', '图片像素过多，无法在这里预览')
      if (file.size > limit && !canTruncate(format.kind)) throw new AppError(413, 'file-too-large', '文件超过这台设备的预览上限')
      await auditRead(caller, context, file, limit)
      const signal = options.requestSignal?.(caller)
      const chunkBytes = options.contentChunkBytes?.(caller)
      await sendContent(req, res, file, {
        ...(signal ? { signal } : {}),
        ...(chunkBytes ? { chunkBytes } : {}),
        mime: format.mime,
        limit,
        allowSecret,
        recheck: () => access.recheck(),
        consume: lease.consume,
      })
    } finally {
      lease.release()
    }
  }

  /**
   * `PUT /tasks/:id/files/:handle { requestId, baseHash, content }`: the person's edit of a text file they opened. The
   * file must still be the version they read (`baseHash`), or nothing is written (409 `file-changed` with the current
   * hash). The audit record comes first; the write replaces the file through a temporary file and a rename.
   */
  async function edit(req: IncomingMessage, res: ServerResponse, caller: FileCaller, sessionId: string, handle: string): Promise<void> {
    admitRead(caller)
    if (!caller.device.scopes.includes('run')) throw scopeRequired('run')
    if (!readsProjectFiles(caller.device.dataScope)) throw new AppError(403, 'file-scope', '这台设备的数据范围不包括会话文件夹中的文件')
    const input = editSchema.parse(await jsonBody(req, EDIT_BODY_LIMIT))
    options.limiter.take(caller.device.id)
    const key = JSON.stringify([caller.device.id, sessionId, input.requestId])
    const fingerprint = sha256Hex(JSON.stringify([handle, input.baseHash, sha256Hex(input.content)]))
    const time = options.now()
    for (const [id, receipt] of editReceipts) if (receipt.until <= time) editReceipts.delete(id)
    const known = editReceipts.get(key)
    if (known) {
      if (known.fingerprint !== fingerprint) throw new AppError(409, 'request-id-reused', '这个请求标识已用于另一次保存。')
      const answer = await known.answer
      options.recheck(caller, 'run')
      json(res, { ...answer, replay: true } satisfies FileEditResult)
      return
    }
    const answer = saveEdit(caller as FileCaller & { device: Device }, sessionId, handle, input)
    if (editReceipts.size >= EDIT_RECEIPTS) editReceipts.delete(editReceipts.keys().next().value!)
    editReceipts.set(key, { fingerprint, until: time + EDIT_RECEIPT_MS, answer })
    // Only a save that happened is replayed; a refusal is decided afresh on a retry.
    answer.catch(() => {
      if (editReceipts.get(key)?.answer === answer) editReceipts.delete(key)
    })
    json(res, await answer)
  }

  async function saveEdit(
    caller: FileCaller & { device: Device },
    sessionId: string,
    handle: string,
    input: z.infer<typeof editSchema>,
  ): Promise<FileEditResult> {
    const hooks = options.edits!
    if (!validContent(input.content)) throw new AppError(400, 'file-edit-invalid', '内容含有无法保存的字符。')
    await hooks.assertInput(caller, sessionId)
    const { file, entry, context, access } = await authorizedFile(caller, handle)
    if (context.kind !== 'session' || context.sessionId !== sessionId)
      throw new AppError(403, 'file-handle-foreign', '这个文件句柄不属于这个会话')
    // A file a conversation named outside its folders is shown, never written.
    if (entry.outside) throw new AppError(403, 'file-outside-folders', STATUS_CODE.outside.message)
    // The path opened now leads somewhere else (a symlink took its place): never write through it.
    if (file.rootId !== entry.rootId || file.relativePath !== entry.relativePath)
      throw new AppError(409, 'file-not-regular', '这个文件已被替换为链接，没有保存。')
    if (file.secret) throw new AppError(403, 'file-secret', '这个文件可能含密钥，不能在这里编辑。')
    if (!EDIT_KINDS.has(fileFormat(file).kind)) throw new AppError(409, 'file-not-text', '这种文件不能在这里编辑。')
    if (file.size > FILE_EDIT_LIMIT)
      throw new AppError(413, 'file-edit-too-large', `超过 ${FILE_EDIT_LIMIT / 1024 / 1024} MiB 的文件不能在这里编辑。`)
    const root = access.roots.find(item => item.id === file.rootId)
    if (!root) throw new AppError(409, 'file-roots-changed', '文件夹已变化，请重新打开')
    const gate = editProtection(caller.device, file, root, options.codeRoot)
    if ('refusal' in gate) throw refuseEdit(gate.refusal)
    // Outside the changes lock a turn still being recorded is waited for; under it, it only refuses.
    const refuseRunning = async (wait: boolean) => {
      if (await hooks.turnRunning(sessionId, file.realPath, wait))
        throw new AppError(409, 'file-turn-running', '这个文件夹里有一轮正在运行，结束后再保存。')
    }
    await refuseRunning(true)
    const display = root === access.roots[0] ? file.relativePath : file.realPath
    // The device as it is now: a scope lowered while the request waited stops the write, R2 rights included.
    const rights = () => {
      options.recheck(caller, 'run')
      if (gate.protection === 'protected-path') options.recheck(caller, 'approve:elevated')
    }
    let result: { hash: string; size: number; unchanged?: true } | undefined
    const { noteNextTurn } = await hooks.record(sessionId, { root: file.rootId, path: file.relativePath, display }, async () => {
      await access.recheck()
      rights()
      await refuseRunning(false)
      const current = await readCurrent(file.realPath)
      if (!current.shape) throw new AppError(409, 'file-not-text', '这个文件不是 UTF-8 文本，不能在这里编辑。')
      if (current.shape.mixed) throw refuseEdit('file-mixed-eol')
      const bytes = shapeContent(input.content, current.shape)
      if (bytes.length > FILE_EDIT_LIMIT)
        throw new AppError(413, 'file-edit-too-large', `超过 ${FILE_EDIT_LIMIT / 1024 / 1024} MiB 的文件不能在这里编辑。`)
      const hash = sha256(bytes)
      // Already this text (an earlier save whose answer was lost, or no change at all): nothing to write.
      if (hash === current.hash) {
        result = { hash, size: bytes.length, unchanged: true }
        return undefined
      }
      if (current.hash !== input.baseHash) throw fileChanged(current.hash)
      await access.recheck()
      rights()
      const { seq } = await options.audit.append({
        action: 'file.edit',
        actor: options.actorOf(caller),
        target: sessionId,
        detail: {
          sessionId,
          pathHash: sha256Hex(file.realPath),
          type: auditType(file.ext),
          protection: gate.protection,
          before: current.bytes.length,
          after: bytes.length,
        },
      })
      try {
        rights()
        await replaceFile(file.realPath, bytes, current, {
          beforeRename: async () => {
            await options.editHooks?.beforeRename?.()
            rights()
          },
        })
      } catch (error) {
        await options.audit.append({ action: 'action.failed', actor: options.actorOf(caller), detail: { refSeq: seq } }).catch(() => {})
        throw error
      }
      result = { hash, size: bytes.length }
      return hash
    })
    return {
      requestId: input.requestId,
      hash: result!.hash,
      size: result!.size,
      ...(result!.unchanged ? { unchanged: true as const } : {}),
      noteNextTurn,
      at: new Date(options.now()).toISOString(),
    }
  }

  async function search(
    req: IncomingMessage,
    res: ServerResponse,
    caller: FileCaller,
    context: FileContext,
    supplied?: z.infer<typeof searchSchema>,
  ): Promise<void> {
    admitRead(caller)
    if (!readsProjectFiles(caller.device.dataScope))
      throw new AppError(403, 'file-scope', '这台设备只能打开本会话提到过的文件，不能搜索文件夹')
    const input = supplied ?? searchSchema.parse(await jsonBody(req))
    options.limiter.take(caller.device.id)
    const access = await contextLease(caller, context)
    const result = await searchIndex.search(
      access.roots,
      guard,
      JSON.stringify([context, access.hash, access.revision]),
      input.q,
      input.limit,
      () => req.aborted || res.destroyed,
      access.check,
    )
    await access.recheck()
    for (const root of access.roots)
      await auditList(
        caller,
        context,
        root,
        '',
        false,
        result.files.filter(file => file.root === root.id).length,
        result.truncated,
        access.check,
      )
    await access.recheck()
    json(res, result)
  }

  /**
   * `POST …/files/grep { q, caseSensitive, wholeWord }`: the lines of the context's text files that hold `q`, under the
   * same rules as the name search (data scope, private sessions, the folders' identity), within fixed bounds. It ends as
   * soon as the request goes away, so a query replaced by the next keystroke frees its slot. Like the name search it
   * records only a `file.list` per folder (counts), never the text searched for or what was found.
   */
  /** The body is read and checked by the caller before a slot is taken, so a slow body never holds one. */
  async function grep(
    req: IncomingMessage,
    res: ServerResponse,
    caller: FileCaller,
    context: FileContext,
    input: z.infer<typeof grepSchema>,
    slot: AbortSignal,
  ): Promise<void> {
    admitRead(caller)
    if (!readsProjectFiles(caller.device.dataScope))
      throw new AppError(403, 'file-scope', '这台设备只能打开本会话提到过的文件，不能搜索文件内容')
    options.limiter.take(caller.device.id)
    // Bytes read count against the device's read budget, as previews do (remote callers only). Taken before any
    // listener is attached, so a refusal here leaves nothing behind.
    const lease = quota.begin(caller.device.id, isLocalListener(caller.connection.listener))
    // Ends with the request on every path: a closed response (HTTP/1, an HTTP/2 stream reset on the relay and native
    // connections), an aborted request, the connection's own signal, or the slot's hard time-out.
    const abort = new AbortController()
    const cancel = () => abort.abort()
    const signal = options.requestSignal?.(caller)
    // Runs once: when the search ends, or when its slot times out while a read never settles (a hung mount), so the
    // lease and the listeners on the long-lived connection signal go then, not whenever that read returns.
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      lease.release()
      req.off('aborted', cancel)
      res.off('close', cancel)
      signal?.removeEventListener('abort', cancel)
      slot.removeEventListener('abort', ended)
    }
    const ended = () => {
      cancel()
      cleanup()
    }
    try {
      req.once('aborted', cancel)
      res.once('close', cancel)
      signal?.addEventListener('abort', cancel, { once: true })
      slot.addEventListener('abort', ended, { once: true })
      if (req.aborted || res.destroyed || signal?.aborted || slot.aborted) abort.abort()
      const cancelled = () => abort.signal.aborted
      const access = await contextLease(caller, context)
      const identity = JSON.stringify([context, access.hash, access.revision])
      const found: Array<{ file: ResolvedFile; lines: number }> = []
      const result = await grepFiles(access.roots, guard, input, cancelled, access.check, options.grepLimits, {
        consume: lease.consume,
        found: (file, lines) => found.push({ file, lines }),
        list: (root, late, check) => searchIndex.files(root, guard, identity, late, check),
        ...(options.hooks ? { resolve: options.hooks } : {}),
      })
      if (cancelled()) return
      await access.recheck()
      // Exactly the files returned (at most the result cap, 500), so the records below are bounded by the answer.
      if (found.length !== result.files.length) throw new AppError(500, 'file-grep-failed', '内容搜索失败')
      // Lines of a file's content leave the Host: each such file is recorded as read, as opening it would be.
      for (const { file, lines } of found) {
        if (cancelled()) return
        await auditRead(caller, context, file, file.size, { lines })
        access.check()
      }
      for (const root of access.roots)
        await auditList(
          caller,
          context,
          root,
          '',
          false,
          result.files.filter(file => file.root === root.id).length,
          result.stopped !== undefined,
          access.check,
        )
      await access.recheck()
      if (!res.destroyed && !cancelled()) json(res, result)
    } finally {
      cleanup()
    }
  }

  async function list(req: IncomingMessage, res: ServerResponse, caller: FileCaller, kind: FileContext['kind'], id: string): Promise<void> {
    admitRead(caller)
    if (!readsProjectFiles(caller.device.dataScope))
      throw new AppError(403, 'file-scope', '这台设备只能打开本会话提到过的文件，没有枚举文件夹的权限')
    const params = new URL(req.url ?? '/', 'http://latch.invalid').searchParams
    const allowed = kind === 'workspace' ? ['rootId', 'dir', 'showHidden', 'harnessId'] : ['rootId', 'dir', 'showHidden']
    if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1))
      throw new AppError(400, 'file-directory-invalid', '文件夹查询无效')
    const rootId = params.get('rootId') ?? undefined,
      dir = params.get('dir') ?? '',
      hidden = params.get('showHidden') ?? 'false',
      harnessId = params.get('harnessId')
    if (
      !validDirectory(dir)
      || (rootId !== undefined && !/^[A-Za-z0-9_-]{1,32}$/u.test(rootId))
      || !['true', 'false'].includes(hidden)
      || (rootId === undefined && dir !== '')
      || (kind === 'workspace' && (!harnessId || harnessId.length > 128))
    )
      throw new AppError(400, 'file-directory-invalid', '文件夹查询无效')
    options.limiter.take(caller.device.id)
    const context: FileContext = kind === 'session' ? sessionContext(id) : { kind: 'workspace', workspaceId: id, harnessId: harnessId! }
    const access = await contextLease(caller, context)
    const response: FileDirectoryListing = {
      context,
      roots: access.roots.map(root => ({ id: root.id, name: basename(root.path) })),
      entries: [],
      truncated: false,
    }
    if (!options.directoryReader?.available) throw new AppError(503, 'file-list-unavailable', '此 Host 尚未提供安全目录读取组件')
    if (rootId !== undefined) {
      const root = access.roots.find(item => item.id === rootId)
      if (!root) throw new AppError(403, 'file-root-unavailable', '这个文件夹不在当前授权范围内')
      const abort = new AbortController()
      const cancel = () => abort.abort()
      req.once('aborted', cancel)
      res.once('close', cancel)
      if (req.aborted || res.destroyed) abort.abort()
      try {
        Object.assign(
          response,
          await options.directoryReader.list({
            deviceId: caller.device.id,
            root: root.path,
            dir,
            protectedPaths: options.protectedPaths,
            showHidden: hidden === 'true',
            check: access.check,
            signal: abort.signal,
          }),
        )
        access.check()
      } finally {
        req.off('aborted', cancel)
        res.off('close', cancel)
      }
      response.rootId = rootId
      response.dir = dir
      await auditList(caller, context, root, dir, hidden === 'true', response.entries.length, response.truncated, access.check)
    }
    await access.recheck()
    if (!res.destroyed) json(res, response)
  }

  return {
    /** Reuses read authorization before a relay connection can be narrowed to one large opaque file. */
    async authorizeBulk(caller: FileCaller, handle: string, etag: string): Promise<{ size: number }> {
      admitRead(caller)
      options.limiter.take(caller.device.id)
      const quotaLease = quota.begin(caller.device.id, isLocalListener(caller.connection.listener))
      try {
        const { file, context, access, format, limit } = await authorizedFile(caller, handle)
        if (file.secret) throw new AppError(403, 'file-secret', '这个文件只在执行端电脑确认后显示')
        if (file.size < 128 * 1024) throw new AppError(409, 'file-bulk-small', '这个文件可直接读取')
        if (file.size > limit) throw new AppError(413, 'file-too-large', '文件超过这台设备的预览上限')
        const dimensions = format.kind === 'image' ? imageDimensions(file.head, format.mime) : undefined
        if (dimensions && dimensions.width * dimensions.height > 50_000_000)
          throw new AppError(413, 'file-too-large', '图片像素过多，无法在这里预览')
        if (fileEtag(file) !== etag) throw new AppError(412, 'file-changed', '文件已变化，请重新打开')
        const fd = await openContent(file, true)
        await fd.close()
        await access.recheck()
        await auditRead(caller, context, file, limit)
        await access.recheck()
        return { size: file.size }
      } finally {
        quotaLease.release()
      }
    },
    /** Answers the file routes; false for any other path, which the caller goes on to route. */
    async handle(req: IncomingMessage, res: ServerResponse, caller: FileCaller, path: string, method: string): Promise<boolean> {
      const directoryRoute = /^\/link\/api\/(tasks|workspaces)\/([^/]+)\/files\/list$/u.exec(path)
      if (directoryRoute && method === 'GET') {
        const id = safeDecode(directoryRoute[2]!)
        if (!id || id.length > 256) throw new AppError(400, 'file-context-invalid', '文件上下文无效')
        await enumerate(caller, () => list(req, res, caller, directoryRoute[1] === 'tasks' ? 'session' : 'workspace', id))
        return true
      }
      const workspaceRoute = /^\/link\/api\/workspaces\/([^/]+)\/files\/(resolve|search|grep)$/u.exec(path)
      if (workspaceRoute && method === 'POST') {
        admitRead(caller)
        if (!readsProjectFiles(caller.device.dataScope)) throw new AppError(403, 'file-scope', '此设备不能浏览项目文件夹')
        const workspaceId = safeDecode(workspaceRoute[1]!)
        if (!workspaceId || workspaceId.length > 256) throw new AppError(400, 'file-context-invalid', '文件上下文无效')
        const body = await jsonBody(req, 320 * KIB)
        if (workspaceRoute[2] === 'resolve') {
          const { harnessId, ...input } = workspaceResolveSchema.parse(body)
          await resolveFiles(req, res, caller, { kind: 'workspace', workspaceId, harnessId }, input)
        } else if (workspaceRoute[2] === 'grep') {
          const { harnessId, ...input } = workspaceGrepSchema.parse(body)
          await searching(caller, slot => grep(req, res, caller, { kind: 'workspace', workspaceId, harnessId }, input, slot))
        } else {
          const { harnessId, ...input } = workspaceSearchSchema.parse(body)
          await enumerate(caller, () => search(req, res, caller, { kind: 'workspace', workspaceId, harnessId }, input))
        }
        return true
      }
      if (options.sessionDetail) {
        const content = /^\/link\/api\/files\/([^/]+)(\/meta)?$/u.exec(path)
        if (content && (method === 'GET' || method === 'HEAD')) {
          await read(req, res, caller, safeDecode(content[1]!), content[2] !== undefined)
          return true
        }
        const searchRoute = /^\/link\/api\/tasks\/([^/]+)\/files\/(search|grep)$/u.exec(path)
        if (searchRoute && method === 'POST') {
          const sessionId = safeDecode(searchRoute[1]!)
          if (sessionId.length > 256) throw new AppError(400, 'invalid-session', '会话标识过长')
          const context = sessionContext(sessionId)
          if (searchRoute[2] === 'grep') {
            admitRead(caller)
            if (!readsProjectFiles(caller.device.dataScope))
              throw new AppError(403, 'file-scope', '这台设备只能打开本会话提到过的文件，不能搜索文件内容')
            const input = grepSchema.parse(await jsonBody(req))
            await searching(caller, slot => grep(req, res, caller, context, input, slot))
          } else await enumerate(caller, () => search(req, res, caller, context))
          return true
        }
      }
      const resolveRoute = /^\/link\/api\/tasks\/([^/]+)\/files\/resolve$/u.exec(path)
      if (resolveRoute && method === 'POST') {
        const sessionId = safeDecode(resolveRoute[1]!)
        if (sessionId.length > 256) throw new AppError(400, 'invalid-session', '会话标识过长')
        await resolveFiles(req, res, caller, sessionContext(sessionId))
        return true
      }
      const editRoute = options.edits && options.sessionDetail ? /^\/link\/api\/tasks\/([^/]+)\/files\/([^/]+)$/u.exec(path) : null
      if (editRoute && method === 'PUT') {
        const sessionId = safeDecode(editRoute[1]!),
          handle = safeDecode(editRoute[2]!)
        if (sessionId.length > 256) throw new AppError(400, 'invalid-session', '会话标识过长')
        if (!HANDLE.test(handle)) throw new AppError(400, 'file-invalid', '这不是有效的文件句柄')
        await edit(req, res, caller, sessionId, handle)
        return true
      }
      const actRoute = /^\/link\/api\/files\/([^/]+)\/local$/u.exec(path)
      if (actRoute && method === 'POST') {
        await act(req, res, caller, safeDecode(actRoute[1]!))
        return true
      }
      return false
    },
    close: () => searchIndex.close(),
    /** A deleted session's handles go with it. */
    forgetSession(sessionId: string): void {
      handles.forgetSession(sessionId)
    },
  }
}
