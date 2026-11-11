import { z } from 'zod'
import type { GitDeliveryKind } from '@latch/protocol'
import { AppError, type ProjectFolder } from '@latch/sdk'
import { sha256Hex } from '@latch/core/node-kit'
import { GitDelivery, MESSAGE_LIMIT, type DeliveryCaller, type GitDeliveryOptions } from '../git-delivery.ts'
import { json, jsonBody, safeDecode } from '../http-util.ts'
import { isInsidePath } from '../paths.ts'
import type { Caller, CallerRequest, DeviceCaller, RouteContext, RouteModule } from './registry.ts'

const PATH = /^\/link\/api\/tasks\/([^/]+)\/git(?:\/(stage|unstage|commit|push))?$/u
const ACTIVE_STATUSES = new Set(['running', 'waiting-approval'])
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const pathsSchema = z.strictObject({ requestId, paths: z.array(z.string().min(1).max(4096)).min(1).max(1000) })
const commitSchema = z.strictObject({ requestId, message: z.string().min(1).max(MESSAGE_LIMIT), skipHooks: z.boolean().optional() })
const pushSchema = z.strictObject({ requestId })

/** Tests: your Git, its home, the environment and shell it starts from, and the time limits. Production never sets it. */
export type GitRouteOptions = Pick<GitDeliveryOptions, 'git' | 'home' | 'hostEnv' | 'shell' | 'timeouts'>

/** Writes that change files Git compares: an Agent's turn in the same folder could be writing them meanwhile. */
const TURN_SENSITIVE: ReadonlySet<GitDeliveryKind> = new Set(['stage', 'unstage', 'commit'])
/** These list or name files of the session's folder, so they are for devices that may browse it, like 改动. */
const FILE_LEVEL: ReadonlySet<GitDeliveryKind | 'state'> = new Set(['state', 'stage', 'unstage'])

export function createGitRoutes(context: RouteContext, options: GitRouteOptions = {}): RouteModule {
  const { audited, actorOf, devices, hub, lifecycle, limits, recheck, refresh, sessionRoots } = context
  const requireScope: RouteContext['requireScope'] = context.requireScope
  const delivery = new GitDelivery({
    ...options,
    receipts: hub.receipts,
    now: context.now,
    log: context.log,
    changed: sessionId => refresh(sessionId),
  })
  /** Runs that may be writing files, by session, with that session's folders. */
  const open = new Map<string, { runId: string; folders: ProjectFolder[] }>()
  lifecycle.on('runStarted', ({ sessionId, runId, folders }) => {
    open.set(sessionId, { runId, folders })
  })
  lifecycle.on('runSettled', ({ sessionId, runId }) => {
    if (open.get(sessionId)?.runId === runId) open.delete(sessionId)
  })
  lifecycle.on('sessionDeleted', ({ sessionId }) => {
    open.delete(sessionId)
  })
  lifecycle.on('hostStopping', async () => {
    open.clear()
    await delivery.close()
  })

  /** The session's working folder: its worktree or its project's primary folder. */
  async function folderOf(sessionId: string): Promise<string> {
    const roots = await sessionRoots(sessionId)
    if (!roots) throw new AppError(404, 'task-not-found', '找不到这个会话。')
    if (roots === 'removed' || !roots[0]) throw new AppError(409, 'workspace-changed', '这个会话使用的文件夹已不在项目中或找不到了。')
    return roots[0].path
  }

  /** The device may still do this, on this session: scope, and full data scope for files and for a private session. */
  function permitted(caller: DeviceCaller, sessionId: string, kind: GitDeliveryKind | 'state'): void {
    recheck(caller, kind === 'state' ? 'view' : 'run')
    const all = devices.get(caller.device.id)?.dataScope === 'all'
    if (FILE_LEVEL.has(kind) && !all) throw new AppError(403, 'file-scope', '这台设备的数据范围不包括会话文件夹中的文件')
    if (hub.agentPrivate(sessionId) && !all)
      throw new AppError(403, 'agent-scope-required', 'Agent 含有私有记忆，请先在电脑上允许这台设备使用。')
  }

  /** Two folders where one is or lies in the other; a path that cannot be compared counts as overlapping. */
  function overlaps(a: string, b: string): boolean {
    try {
      return isInsidePath(a, b) || isInsidePath(b, a)
    } catch {
      return true
    }
  }

  async function assertNoTurn(sessionId: string, folder: string): Promise<void> {
    const status = (await hub.summary(sessionId)).status
    const busy = ACTIVE_STATUSES.has(status) || [...open.values()].some(run => run.folders.some(other => overlaps(other.path, folder)))
    if (busy) throw new AppError(409, 'git-turn-running', '这个文件夹里有一轮正在运行，结束后再试。')
  }

  function callerOf(caller: DeviceCaller, sessionId: string, folder: string, request: string): DeliveryCaller {
    const requestHash = sha256Hex(request)
    return {
      sessionId,
      deviceId: caller.device.id,
      folder,
      async authorize(kind) {
        await context.assertSessionInput(caller, sessionId)
        permitted(caller, sessionId, kind)
        if ((await folderOf(sessionId)) !== folder) throw new AppError(409, 'workspace-changed', '这个会话使用的文件夹已经变了。')
        if (TURN_SENSITIVE.has(kind)) await assertNoTurn(sessionId, folder)
        permitted(caller, sessionId, kind)
      },
      async audit({ action, detail }) {
        await audited({ action, actor: actorOf(caller), target: sessionId, detail } as Parameters<typeof audited>[0])
      },
      async result(event) {
        await audited({
          action: 'git.result',
          actor: actorOf(caller),
          target: sessionId,
          detail: { sessionId, requestHash, ...event },
        })
      },
    }
  }

  async function route(request: CallerRequest): Promise<boolean> {
    const { req, res, path, method } = request
    const caller: Caller = request.caller
    const match = PATH.exec(path)
    if (!match) return false
    const sessionId = safeDecode(match[1]!),
      part = match[2] as GitDeliveryKind | undefined
    if (method === 'GET' && part === undefined) {
      requireScope(caller, 'view')
      permitted(caller, sessionId, 'state')
      limits.files.take(caller.device.id)
      const folder = await folderOf(sessionId)
      const state = await delivery.state(folder)
      permitted(caller, sessionId, 'state')
      json(res, state)
      return true
    }
    if (method !== 'POST' || part === undefined) return false
    requireScope(caller, 'run')
    permitted(caller, sessionId, part)
    limits.classC.take(caller.device.id)
    const body = await jsonBody(req)
    await context.assertSessionInput(caller, sessionId)
    const folder = await folderOf(sessionId)
    if (part === 'stage' || part === 'unstage') {
      const input = pathsSchema.parse(body)
      const target = callerOf(caller, sessionId, folder, input.requestId)
      json(res, part === 'stage' ? await delivery.stage(target, input) : await delivery.unstage(target, input))
      return true
    }
    if (part === 'commit') {
      const input = commitSchema.parse(body)
      json(
        res,
        await delivery.commit(callerOf(caller, sessionId, folder, input.requestId), {
          requestId: input.requestId,
          message: input.message,
          ...(input.skipHooks ? { skipHooks: true } : {}),
        }),
      )
      return true
    }
    const input = pushSchema.parse(body)
    json(res, await delivery.push(callerOf(caller, sessionId, folder, input.requestId), input))
    return true
  }

  return { route, features: () => ({ gitDelivery: true }) }
}
