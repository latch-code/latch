// The desktop app's file actions: 在访达中显示, 快速查看 and 用默认应用打开 for a file a message refers to. Only the desktop
// app's main process calls these routes, over host.sock with its own device credential; the shell proxy refuses them
// from the page (apps/desktop/src/proxy.cjs). The Host decides whether the file is a regular file inside the session's
// folders and what may be done with it, records the action in the audit log, and only then tells main the real path.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { isLocalListener, type Device, type DeviceScope, type ListenerClass, type TaskDetail } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { sha256Hex } from '@latch/core/node-kit'
import { authFailure, localOnly, scopeRequired, type RateLimiter } from '../access.ts'
import type { AuditActor, AuditLog } from '../audit.ts'
import { KIB, json, jsonBody, safeDecode } from '../http-util.ts'
import { FileHandles, HANDLE } from './handles.ts'
import { auditType } from './kinds.ts'
import { canTruncate, contentLimit, fileEtag, fileFormat, imageDimensions } from './metadata.ts'
import { isReferenced, isReferenceListed, sessionReferences } from './references.ts'
import { openContent, sendContent } from './read.ts'
import { FileReadQuota } from './quota.ts'
import { searchFiles } from './search.ts'
import {
  ProtectedPaths,
  fileVerdicts,
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
const FILE_ACTIONS = ['reveal', 'quicklook', 'open'] as const
export type FileAction = (typeof FILE_ACTIONS)[number]

const resolveSchema = z.strictObject({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(RESOLVE_LIMIT),
  rootId: z.string().min(1).max(32).optional(),
  showSecret: z.boolean().optional(),
})
const searchSchema = z.strictObject({ q: z.string().max(512), limit: z.number().int().min(1).max(100).default(100) })
const actSchema = z.strictObject({
  sessionId: z.string().min(1).max(256),
  action: z.enum(FILE_ACTIONS),
})

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
} as const

interface FileCaller {
  connection: { listener: ListenerClass }
  device?: Device
}

export interface FileRoutesOptions {
  /** Latch's private paths: the same list the built-in file tools refuse. */
  protectedPaths: readonly string[]
  home: string
  now: () => number
  audit: Pick<AuditLog, 'append'>
  limiter: Pick<RateLimiter, 'take'>
  /**
   * The session's folders, primary first; undefined when the Host has no such session, `removed` when its folder is no
   * longer the start directory or a registered, enabled project.
   */
  sessionRoots(sessionId: string): Promise<FileRoot[] | 'removed' | undefined>
  /** Throws when the device was revoked, lost the scope or no longer has the data scope all while the request waited. */
  recheck(caller: FileCaller, scope: DeviceScope): void
  actorOf(caller: FileCaller): AuditActor
  /** Persisted session history supplies the references a work-scope device may read. */
  sessionDetail?(sessionId: string): Promise<TaskDetail>
  referencePaths?(sessionId: string, roots: readonly FileRoot[]): Promise<ReadonlySet<string>>
  /** Test seam only; the Host never sets it. */
  hooks?: ResolveOptions['hooks']
}

/** Desktop app on host.sock, a device with the scope and the data scope `all` (the whole of the session's folders). */
function admit(caller: FileCaller, scope: DeviceScope): asserts caller is FileCaller & { device: Device } {
  if (!isLocalListener(caller.connection.listener)) throw localOnly()
  if (!caller.device) throw authFailure('unauthorized')
  if (!caller.device.scopes.includes(scope)) throw scopeRequired(scope)
  if (caller.device.dataScope !== 'all') throw new AppError(403, 'file-scope', '这台设备的数据范围不包括会话文件夹中的文件')
}

function admitRead(caller: FileCaller): asserts caller is FileCaller & { device: Device } {
  if (!caller.device) throw authFailure('unauthorized')
  if (!caller.device.scopes.includes('view')) throw scopeRequired('view')
}

const scopeOf = (action: FileAction): DeviceScope => (action === 'open' ? 'run' : 'view')

export function createFileRoutes(options: FileRoutesOptions) {
  const handles = new FileHandles(options.now)
  const guard = new ProtectedPaths(options.protectedPaths)
  const quota = new FileReadQuota(options.now)
  const audited = new Map<string, number>()

  async function referencesOf(sessionId: string, roots: readonly FileRoot[]): Promise<ReadonlySet<string>> {
    if (options.referencePaths) return options.referencePaths(sessionId, roots)
    return options.sessionDetail ? sessionReferences(await options.sessionDetail(sessionId), roots, options.home) : new Set()
  }

  async function auditRead(caller: FileCaller & { device: Device }, sessionId: string, file: ResolvedFile, limit: number): Promise<void> {
    if (isLocalListener(caller.connection.listener)) return
    const key = JSON.stringify([caller.device.id, sessionId, file.rootId, file.relativePath])
    const now = options.now()
    for (const [id, until] of audited) if (until <= now) audited.delete(id)
    if (audited.has(key)) return
    options.recheck(caller, 'view')
    await options.audit.append({
      action: 'file.view',
      actor: options.actorOf(caller),
      target: sessionId,
      detail: { sessionId, pathHash: sha256Hex(file.realPath), type: auditType(file.ext), bytes: Math.min(file.size, limit) },
    })
    if (audited.size >= 4096) audited.delete(audited.keys().next().value!)
    audited.set(key, now + 15 * 60 * 1000)
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
  async function resolveFiles(req: IncomingMessage, res: ServerResponse, caller: FileCaller, sessionId: string): Promise<void> {
    if (options.sessionDetail) admitRead(caller)
    else admit(caller, 'view')
    const input = resolveSchema.parse(await jsonBody(req, 320 * KIB))
    options.limiter.take(caller.device.id)
    const roots = await rootsOf(sessionId)
    const references = caller.device.dataScope === 'work' && options.sessionDetail ? await referencesOf(sessionId, roots) : undefined
    const resolveOptions: ResolveOptions = {
      roots: input.rootId ? roots.filter(root => root.id === input.rootId) : roots,
      protectedPaths: guard,
      home: options.home,
      ...(options.hooks ? { hooks: options.hooks } : {}),
    }
    const files = []
    for (const path of [...new Set(input.paths)]) {
      if (references && !isReferenceListed(path, references, resolveOptions.roots, options.home)) {
        files.push({ input: path, status: 'not-referenced', code: 'file-not-referenced' })
        continue
      }
      const result = await resolveReference(path, resolveOptions)
      const position = {
        ...(result.line === undefined ? {} : { line: result.line }),
        ...(result.column === undefined ? {} : { column: result.column }),
      }
      if (result.status !== 'ok') {
        files.push({ input: path, status: result.status, code: STATUS_CODE[result.status].code, ...position })
        continue
      }
      const { file } = result
      if (references && !isReferenced(references, file)) {
        files.push({ input: path, status: 'not-referenced', code: 'file-not-referenced', ...position })
        continue
      }
      const verdicts = fileVerdicts(file)
      const local = isLocalListener(caller.connection.listener)
      const format = fileFormat(file)
      const limit = contentLimit(format.kind, local)
      const secretAllowed = local && input.showSecret === true
      const canRead = (!file.secret || secretAllowed) && (file.size <= limit || canTruncate(format.kind))
      const dimensions = format.kind === 'image' ? imageDimensions(file.head, format.mime) : undefined
      const imageTooLarge = !!dimensions && dimensions.width * dimensions.height > (local ? 100_000_000 : 50_000_000)
      const imageUnknown = format.kind === 'image' && !dimensions
      if (options.sessionDetail && canRead) await auditRead(caller, sessionId, file, limit)
      const refused: Record<string, string> = Object.fromEntries(
        Object.entries(verdicts).flatMap(([action, verdict]) => (verdict.ok ? [] : [[action, verdict.code]])),
      )
      if (imageTooLarge || imageUnknown) refused.preview = imageTooLarge ? 'file-too-large' : 'file-image-dimensions'
      files.push({
        input: path,
        status: 'ok',
        ...position,
        file: {
          handle: handles.issue({
            deviceId: caller.device.id,
            sessionId,
            rootId: file.rootId,
            relativePath: file.relativePath,
            ...(secretAllowed ? { allowSecret: true as const } : {}),
          }),
          name: file.name,
          root: file.rootId,
          path: file.relativePath,
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
            ...(options.sessionDetail
              ? {
                  download: canRead && file.size <= limit && !imageTooLarge,
                  preview: canRead && !imageTooLarge && !imageUnknown && format.kind !== 'binary',
                }
              : {}),
          },
          ...(Object.keys(refused).length ? { refused } : {}),
        },
      })
    }
    options.recheck(caller, 'view')
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
    if (found.entry.sessionId !== input.sessionId) throw new AppError(403, 'file-handle-foreign', '这个文件句柄不属于这个会话')
    const roots = await rootsOf(input.sessionId)
    const result = await resolveRecorded(found.entry.rootId, found.entry.relativePath, {
      roots,
      protectedPaths: guard,
      home: options.home,
      ...(options.hooks ? { hooks: options.hooks } : {}),
    })
    if (result.status !== 'ok') {
      const failure = STATUS_CODE[result.status]
      throw new AppError(failure.status, failure.code, failure.message)
    }
    const verdict = fileVerdicts(result.file)[input.action]
    if (!verdict.ok) throw new AppError(403, verdict.code, REFUSAL_MESSAGE[verdict.code])
    options.recheck(caller, scope)
    await options.audit.append({
      action: `file.${input.action}`,
      actor: options.actorOf(caller),
      target: input.sessionId,
      detail: { sessionId: input.sessionId, pathHash: sha256Hex(result.file.realPath), type: auditType(result.file.ext) },
    })
    await rootsOf(input.sessionId)
    options.recheck(caller, scope)
    json(res, { file: { path: result.file.realPath, name: result.file.name, ext: result.file.ext } })
  }

  async function read(req: IncomingMessage, res: ServerResponse, caller: FileCaller, handle: string, meta: boolean): Promise<void> {
    admitRead(caller)
    options.limiter.take(caller.device.id)
    if (!HANDLE.test(handle)) throw new AppError(400, 'file-invalid', '这不是有效的文件句柄')
    const found = handles.use(handle, caller.device.id)
    if (!found.ok)
      throw new AppError(
        found.reason === 'foreign' ? 403 : 410,
        found.reason === 'foreign' ? 'file-handle-foreign' : 'file-handle-expired',
        '文件已不可用，请重新打开',
      )
    const lease = quota.begin(caller.device.id, isLocalListener(caller.connection.listener))
    try {
      const entry = found.entry
      const roots = await rootsOf(entry.sessionId)
      const result = await resolveRecorded(entry.rootId, entry.relativePath, {
        roots,
        protectedPaths: guard,
        home: options.home,
        ...(options.hooks ? { hooks: options.hooks } : {}),
      })
      if (result.status !== 'ok') {
        const failure = STATUS_CODE[result.status]
        throw new AppError(failure.status, failure.code, failure.message)
      }
      const file = result.file
      if (caller.device.dataScope === 'work' && (!options.sessionDetail || !isReferenced(await referencesOf(entry.sessionId, roots), file)))
        throw new AppError(403, 'file-not-referenced', '这台设备只能查看本会话提到过的文件')
      const local = isLocalListener(caller.connection.listener)
      const allowSecret = local && entry.allowSecret === true
      const format = fileFormat(file)
      const limit = contentLimit(format.kind, local)
      options.recheck(caller, 'view')
      if (meta) {
        const fd = await openContent(file, true)
        await fd.close()
        options.recheck(caller, 'view')
        json(res, {
          file: {
            handle,
            name: file.name,
            root: file.rootId,
            path: file.relativePath,
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
      await auditRead(caller, entry.sessionId, file, limit)
      await sendContent(req, res, file, {
        mime: format.mime,
        limit,
        allowSecret,
        recheck: async () => {
          options.recheck(caller, 'view')
          await rootsOf(entry.sessionId)
          options.recheck(caller, 'view')
        },
        consume: lease.consume,
      })
    } finally {
      lease.release()
    }
  }

  async function search(req: IncomingMessage, res: ServerResponse, caller: FileCaller, sessionId: string): Promise<void> {
    admitRead(caller)
    if (caller.device.dataScope !== 'all') throw new AppError(403, 'file-scope', '这台设备只能打开本会话提到过的文件，不能搜索文件夹')
    const input = searchSchema.parse(await jsonBody(req))
    options.limiter.take(caller.device.id)
    const roots = await rootsOf(sessionId)
    const result = await searchFiles(roots, guard, input.q, input.limit, () => res.destroyed)
    options.recheck(caller, 'view')
    json(res, result)
  }

  return {
    /** Answers the file routes; false for any other path, which the caller goes on to route. */
    async handle(req: IncomingMessage, res: ServerResponse, caller: FileCaller, path: string, method: string): Promise<boolean> {
      if (options.sessionDetail) {
        const content = /^\/link\/api\/files\/([^/]+)(\/meta)?$/u.exec(path)
        if (content && (method === 'GET' || method === 'HEAD')) {
          await read(req, res, caller, safeDecode(content[1]!), content[2] !== undefined)
          return true
        }
        const searchRoute = /^\/link\/api\/tasks\/([^/]+)\/files\/search$/u.exec(path)
        if (searchRoute && method === 'POST') {
          const sessionId = safeDecode(searchRoute[1]!)
          if (sessionId.length > 256) throw new AppError(400, 'invalid-session', '会话标识过长')
          await search(req, res, caller, sessionId)
          return true
        }
      }
      const resolveRoute = /^\/link\/api\/tasks\/([^/]+)\/files\/resolve$/u.exec(path)
      if (resolveRoute && method === 'POST') {
        const sessionId = safeDecode(resolveRoute[1]!)
        if (sessionId.length > 256) throw new AppError(400, 'invalid-session', '会话标识过长')
        await resolveFiles(req, res, caller, sessionId)
        return true
      }
      const actRoute = /^\/link\/api\/files\/([^/]+)\/local$/u.exec(path)
      if (actRoute && method === 'POST') {
        await act(req, res, caller, safeDecode(actRoute[1]!))
        return true
      }
      return false
    },
    /** A deleted session's handles go with it. */
    forgetSession(sessionId: string): void {
      handles.forgetSession(sessionId)
    },
  }
}
