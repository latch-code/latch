import { z } from 'zod'
import { WorkbenchDeliveryReader, workbenchReadFailure, type WorkbenchDeliveryTarget } from '../workbench-delivery.ts'
import { readsProjectFiles, type GitDeliveryKind } from '@latch/protocol'
import { AppError, type ProjectFolder } from '@latch/sdk'
import { sha256Hex } from '@latch/core/node-kit'
import { GitDelivery, MESSAGE_LIMIT, type DeliveryCaller, type GitDeliveryOptions } from '../git-delivery.ts'
import { BODY_LIMIT, TITLE_LIMIT, nativePrState } from '../git-pr.ts'
import { RANGE_LIMIT, validRanges } from '../changes/git-hunks.ts'
import { json, jsonBody, safeDecode } from '../http-util.ts'
import { isInsidePath } from '../paths.ts'
import type { Caller, CallerRequest, DeviceCaller, RouteContext, RouteModule } from './registry.ts'

const PATH = /^\/link\/api\/tasks\/([^/]+)\/git(?:\/(stage|unstage|commit|push|pr|fetch|pull|abort))?$/u
const LINES_PATH = /^\/link\/api\/tasks\/([^/]+)\/git\/(stage|unstage)-lines$/u
const READ_PATH = /^\/link\/api\/tasks\/([^/]+)\/git\/(diff|compare|history(?:\/([0-9a-f]{40}|[0-9a-f]{64}))?)$/u
const LOG_PATH = /^\/link\/api\/tasks\/([^/]+)\/git\/pr\/checks\/(\d{1,20})\/log$/u
const ACTIVE_STATUSES = new Set(['running', 'waiting-approval'])
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const pathsSchema = z.strictObject({ requestId, paths: z.array(z.string().min(1).max(4096)).min(1).max(1000) })
const commitSchema = z.strictObject({ requestId, message: z.string().min(1).max(MESSAGE_LIMIT), skipHooks: z.boolean().optional() })
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)
const ranges = z
  .array(z.tuple([z.number().int().min(1).max(10_000_000), z.number().int().min(1).max(10_000_000)]))
  .max(RANGE_LIMIT)
  // Rising, disjoint and bounded in all: refused on the numbers, before any range is walked.
  .refine(validRanges, '行号要从小到大、互不重叠，一次最多两万行。')
  .optional()
const linesSchema = z.strictObject({
  requestId,
  path: z.string().min(1).max(4096),
  base: z.strictObject({
    worktree: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    index: oid.optional(),
    head: oid.optional(),
  }),
  old: ranges,
  new: ranges,
})
const pushSchema = z.strictObject({ requestId })
const abortSchema = z.strictObject({ requestId, operation: z.enum(['merge', 'rebase', 'cherry-pick', 'revert']) })
const workbenchSchema = z.strictObject({ ids: z.array(z.string().min(1).max(256)).max(12) })
const prSchema = z.strictObject({
  requestId,
  title: z.string().min(1).max(TITLE_LIMIT),
  body: z.string().max(BODY_LIMIT),
  base: z.string().min(1).max(200),
  draft: z.boolean().optional(),
})

/** Tests: your Git, its home, the environment and shell it starts from, and the time limits. Production never sets it. */
export type GitRouteOptions = Pick<GitDeliveryOptions, 'git' | 'home' | 'hostEnv' | 'shell' | 'timeouts'>

/**
 * Writes that change files Git compares (a pull's fast-forward and an abort rewrite the work tree): an Agent's turn in
 * the same folder could be writing them meanwhile. A fetch, like a push, changes only refs.
 */
const TURN_SENSITIVE: ReadonlySet<GitDeliveryKind> = new Set(['stage', 'unstage', 'commit', 'pull', 'abort'])
/**
 * These list or name files of the session's folder, or (a check's log) may hold its code, so they are for devices that
 * may browse it, like 改动.
 */
const FILE_LEVEL: ReadonlySet<Access> = new Set(['state', 'stage', 'unstage', 'pr-log', 'file'])
/**
 * Reads: the repository's state, the pull request's state, a failed check's log, and `file`: a file's staging lines and
 * every history read (the commit lists, a commit's or the comparison's files, and their lines).
 */
type Access = GitDeliveryKind | 'state' | 'pr-state' | 'pr-log' | 'file'
const READS: ReadonlySet<Access> = new Set(['state', 'pr-state', 'pr-log', 'file'])

export function createGitRoutes(context: RouteContext, options: GitRouteOptions = {}): RouteModule {
  const { audited, actorOf, board, devices, hub, lifecycle, limits, recheck, refresh, sessionRoots } = context
  const requireScope: RouteContext['requireScope'] = context.requireScope
  const delivery = new GitDelivery({
    ...options,
    holds: context.repositoryHolds,
    receipts: hub.receipts,
    prs: {
      get: sessionId => hub.prOf(sessionId),
      bind: (sessionId, pr) => hub.bindPr(sessionId, pr),
      unbind: sessionId => hub.unbindPr(sessionId),
    },
    now: context.now,
    log: context.log,
    changed: sessionId => {
      refresh(sessionId)
      // A commit, push or pull request of 交付 changed the repository: the board reads it again.
      board.settled(sessionId)
    },
  })
  const workbench = new WorkbenchDeliveryReader({
    now: context.now,
    state: folder => delivery.state(folder),
    pr: (sessionId, folder) => delivery.prState({ sessionId, folder, discussion: false, title: false, boundOnly: true }),
  })
  board.connect(workbench)
  /** Runs that may be writing files, by session, with that session's folders. */
  const open = new Map<string, { runId: string; folders: ProjectFolder[] }>()
  lifecycle.on('runStarted', ({ sessionId, runId, folders }) => {
    open.set(sessionId, { runId, folders })
  })
  lifecycle.on('runSettled', ({ sessionId, runId }) => {
    if (open.get(sessionId)?.runId === runId) open.delete(sessionId)
    board.settled(sessionId)
  })
  lifecycle.on('sessionArchived', ({ sessionId }) => {
    board.forget(sessionId)
  })
  lifecycle.on('sessionDeleted', ({ sessionId }) => {
    open.delete(sessionId)
    board.forget(sessionId)
  })
  lifecycle.on('hostStopping', async () => {
    open.clear()
    await board.close()
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
  function permitted(caller: DeviceCaller, sessionId: string, kind: Access): void {
    recheck(caller, READS.has(kind) ? 'view' : 'run')
    const scope = devices.get(caller.device.id)?.dataScope
    const all = scope === 'all'
    if (FILE_LEVEL.has(kind) && !readsProjectFiles(scope))
      throw new AppError(403, 'file-scope', '这台设备的数据范围不包括会话文件夹中的文件')
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
    if (path === '/link/api/workbench/delivery' && method === 'POST') {
      requireScope(caller, 'view')
      limits.files.take(caller.device.id)
      const { ids } = workbenchSchema.parse(await jsonBody(req))
      recheck(caller, 'view')
      const unique = [...new Set(ids)]
      for (const id of unique) permitted(caller, id, 'state')
      const release = board.take()
      if (!release) throw new AppError(429, 'rate-limited', '正在读取交付状态，请稍后再试。', { retryAfter: 1 })
      try {
        const targets: WorkbenchDeliveryTarget[] = []
        for (const sessionId of unique) {
          permitted(caller, sessionId, 'state')
          try {
            targets.push({ sessionId, folder: await folderOf(sessionId), boundPr: !!hub.prOf(sessionId) })
          } catch (error) {
            targets.push({ sessionId, boundPr: false, error: workbenchReadFailure(error) })
          }
        }
        const result = await workbench.read(targets)
        // What a device read refreshes the board's cache, whether or not the device may still see it.
        for (const entry of result.entries) void board.observe(entry)
        recheck(caller, 'view')
        for (const id of unique) permitted(caller, id, 'state')
        json(res, result)
      } finally {
        release()
      }
      return true
    }
    const log = LOG_PATH.exec(path)
    if (log && method === 'GET') {
      const sessionId = safeDecode(log[1]!)
      requireScope(caller, 'view')
      permitted(caller, sessionId, 'pr-log')
      limits.classC.take(caller.device.id)
      const folder = await folderOf(sessionId)
      const excerpt = await delivery.checkLog({ sessionId, folder, job: log[2]! })
      permitted(caller, sessionId, 'pr-log')
      json(res, excerpt)
      return true
    }
    const read = READ_PATH.exec(path)
    if (read && method === 'GET') {
      const sessionId = safeDecode(read[1]!)
      const params = new URL(req.url ?? '/', 'http://latch.invalid').searchParams
      const filePath = params.get('path') ?? undefined
      requireScope(caller, 'view')
      if (read[2] === 'diff') {
        const view = params.get('view')
        if ((view !== 'unstaged' && view !== 'staged') || !filePath) throw new AppError(400, 'bad-request', '请求无效。')
        permitted(caller, sessionId, 'file')
        limits.files.take(caller.device.id)
        const diff = await delivery.hunkDiff(await folderOf(sessionId), view, filePath)
        permitted(caller, sessionId, 'file')
        json(res, diff)
        return true
      }
      // Commits, their files and a file's lines all name the session's files: for devices that may read them, like 改动.
      permitted(caller, sessionId, 'file')
      limits.files.take(caller.device.id)
      const folder = await folderOf(sessionId)
      const sha = read[3]
      const answer =
        read[2] === 'history'
          ? await delivery.history(folder, filePath !== undefined ? { path: filePath } : {})
          : filePath !== undefined
            ? await delivery.treeFile(folder, { ...(sha ? { sha } : {}), path: filePath })
            : await delivery.treeDiff(folder, sha ? { sha } : {})
      // The scope may have been narrowed while Git ran: nothing read for the wider one leaves.
      permitted(caller, sessionId, 'file')
      json(res, answer)
      return true
    }
    const lines = LINES_PATH.exec(path)
    if (lines && method === 'POST') {
      const sessionId = safeDecode(lines[1]!),
        kind = lines[2] as 'stage' | 'unstage'
      requireScope(caller, 'run')
      const leave = context.repositoryHolds.enter()
      try {
        permitted(caller, sessionId, kind)
        limits.classC.take(caller.device.id)
        const input = linesSchema.parse(await jsonBody(req))
        await context.assertSessionInput(caller, sessionId)
        const folder = await folderOf(sessionId)
        json(
          res,
          await delivery.stageLines(callerOf(caller, sessionId, folder, input.requestId), kind, {
            requestId: input.requestId,
            path: input.path,
            base: {
              ...(input.base.worktree ? { worktree: input.base.worktree } : {}),
              ...(input.base.index ? { index: input.base.index } : {}),
              ...(input.base.head ? { head: input.base.head } : {}),
            },
            ...(input.old ? { old: input.old } : {}),
            ...(input.new ? { new: input.new } : {}),
          }),
        )
      } finally {
        leave()
      }
      return true
    }
    const match = PATH.exec(path)
    if (!match) return false
    const sessionId = safeDecode(match[1]!),
      part = match[2] as GitDeliveryKind | undefined
    if (method === 'GET' && part === 'pr') {
      requireScope(caller, 'view')
      permitted(caller, sessionId, 'pr-state')
      limits.classC.take(caller.device.id)
      const folder = await folderOf(sessionId)
      // Reviews, comments and the last commit's subject are the repository's words: for devices that may read its files.
      const all = readsProjectFiles(devices.get(caller.device.id)?.dataScope)
      const state = await delivery.prState({ sessionId, folder, discussion: all, title: all })
      if (state.pr) board.recordPr(sessionId, state.pr.state)
      permitted(caller, sessionId, 'pr-state')
      const still = readsProjectFiles(devices.get(caller.device.id)?.dataScope)
      if (all && !still) {
        delete state.discussion
        delete state.discussionCapped
        if (state.draft) delete state.draft.title
      }
      json(res, caller.nativeOpening ? nativePrState(state) : state)
      return true
    }
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
    // The Host is about to stop for an update: no new write starts the user's git now.
    const leave = context.repositoryHolds.enter()
    try {
      return await write(request, caller, sessionId, part)
    } finally {
      leave()
    }
  }

  async function write(request: CallerRequest, caller: DeviceCaller, sessionId: string, part: GitDeliveryKind): Promise<boolean> {
    const { req, res } = request
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
    if (part === 'pr') {
      const input = prSchema.parse(body)
      const result = await delivery.createPr(callerOf(caller, sessionId, folder, input.requestId), {
        requestId: input.requestId,
        title: input.title,
        body: input.body,
        base: input.base,
        ...(input.draft ? { draft: true } : {}),
      })
      // Made now or found open for the branch: either way it is open. A replay says nothing about now.
      if (!result.replay) board.recordPr(sessionId, 'open')
      json(res, result)
      return true
    }
    if (part === 'abort') {
      const input = abortSchema.parse(body)
      json(res, await delivery.abort(callerOf(caller, sessionId, folder, input.requestId), input))
      return true
    }
    const input = pushSchema.parse(body)
    const target = callerOf(caller, sessionId, folder, input.requestId)
    json(
      res,
      part === 'fetch'
        ? await delivery.fetch(target, input)
        : part === 'pull'
          ? await delivery.pull(target, input)
          : await delivery.push(target, input),
    )
    return true
  }

  return { route, features: () => ({ gitDelivery: true, gitHunks: true, gitSync: true }) }
}
