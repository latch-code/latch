// The desktop app's file actions: 在访达中显示, 快速查看 and 用默认应用打开 for a file a message refers to. Only the desktop
// app's main process calls these routes, over host.sock with its own device credential; the shell proxy refuses them
// from the page (apps/desktop/src/proxy.cjs). The Host decides whether the file is a regular file inside the session's
// folders and what may be done with it, records the action in the audit log, and only then tells main the real path.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { isLocalListener, type Device, type DeviceScope, type ListenerClass } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { sha256Hex } from '@latch/core/node-kit'
import { authFailure, localOnly, scopeRequired, type RateLimiter } from '../access.ts'
import type { AuditActor, AuditLog } from '../audit.ts'
import { KIB, json, jsonBody, safeDecode } from '../http-util.ts'
import { FileHandles, HANDLE } from './handles.ts'
import { auditType } from './kinds.ts'
import {
  ProtectedPaths,
  fileVerdicts,
  resolveRecorded,
  resolveReference,
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
})
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

const scopeOf = (action: FileAction): DeviceScope => (action === 'open' ? 'run' : 'view')

export function createFileRoutes(options: FileRoutesOptions) {
  const handles = new FileHandles(options.now)
  const guard = new ProtectedPaths(options.protectedPaths)

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
    admit(caller, 'view')
    const input = resolveSchema.parse(await jsonBody(req, 320 * KIB))
    options.limiter.take(caller.device.id)
    const roots = await rootsOf(sessionId)
    const resolveOptions: ResolveOptions = {
      roots,
      protectedPaths: guard,
      home: options.home,
      ...(options.hooks ? { hooks: options.hooks } : {}),
    }
    const files = []
    for (const path of [...new Set(input.paths)]) {
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
      const verdicts = fileVerdicts(file)
      const refused = Object.fromEntries(
        Object.entries(verdicts).flatMap(([action, verdict]) => (verdict.ok ? [] : [[action, verdict.code]])),
      )
      files.push({
        input: path,
        status: 'ok',
        ...position,
        file: {
          handle: handles.issue({ deviceId: caller.device.id, sessionId, rootId: file.rootId, relativePath: file.relativePath }),
          name: file.name,
          root: file.rootId,
          path: file.relativePath,
          ext: file.ext,
          size: file.size,
          secret: file.secret,
          actions: { reveal: verdicts.reveal.ok, quicklook: verdicts.quicklook.ok, open: verdicts.open.ok },
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
    options.recheck(caller, scope)
    json(res, { file: { path: result.file.realPath, name: result.file.name, ext: result.file.ext } })
  }

  return {
    /** Answers the file routes; false for any other path, which the caller goes on to route. */
    async handle(req: IncomingMessage, res: ServerResponse, caller: FileCaller, path: string, method: string): Promise<boolean> {
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
