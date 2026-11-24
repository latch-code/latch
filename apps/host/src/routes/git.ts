import { z } from 'zod'
import { advancePrFollow, followPrompt, observedPr, publicFollow } from '../pr-follow.ts'
import type { StoredPrFollow } from '../session-meta.ts'
import { WorkbenchDeliveryReader, workbenchReadFailure, type WorkbenchDeliveryTarget } from '../workbench-delivery.ts'
import { readsProjectFiles, type GitDeliveryKind } from '@latch/protocol'
import { AppError, type ProjectFolder } from '@latch/sdk'
import { derivedUuid } from '../teams.ts'
import { sha256Hex } from '@latch/core/node-kit'
import { GitDelivery, MESSAGE_LIMIT, type DeliveryCaller, type GitDeliveryOptions } from '../git-delivery.ts'
import { BODY_LIMIT, TITLE_LIMIT, nativePrState } from '../git-pr.ts'
import { RANGE_LIMIT, validRanges } from '../changes/git-hunks.ts'
import { json, jsonBody, safeDecode } from '../http-util.ts'
import { isInsidePath } from '../paths.ts'
import type { Caller, CallerRequest, DeviceCaller, RouteContext, RouteModule } from './registry.ts'

const PATH = /^\/link\/api\/tasks\/([^/]+)\/git(?:\/(stage|unstage|commit|push|pr|fetch|pull|abort))?$/u
const LINES_PATH = /^\/link\/api\/tasks\/([^/]+)\/git\/(stage|unstage)-lines$/u
const READ_PATH = /^\/link\/api\/tasks\/([^/]+)\/git\/(diff|compare|compare-branches|history(?:\/([0-9a-f]{40}|[0-9a-f]{64}))?)$/u
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
export type GitRouteOptions = Pick<GitDeliveryOptions, 'git' | 'home' | 'hostEnv' | 'shell' | 'timeouts'> & {
  registerPoll?: (poll: () => Promise<void>) => void
}

/**
 * Writes that change files Git compares (a pull's fast-forward and an abort rewrite the work tree): an Agent's turn in
 * the same folder could be writing them meanwhile. A fetch, like a push, changes only refs.
 */
const TURN_SENSITIVE: ReadonlySet<GitDeliveryKind> = new Set(['stage', 'unstage', 'commit', 'pull', 'abort'])
/**
 * These list or name files of the session's folder, or (a check's log) may hold its code, so they are for devices that
 * may browse it, like 改动.
 */
const FILE_LEVEL: ReadonlySet<Access> = new Set(['state', 'stage', 'unstage', 'pr-log', 'file', 'comparison'])
/**
 * Reads: the repository's state, the pull request's state, a failed check's log, and `file`: a file's staging lines and
 * the history reads (commit lists, files and their lines). A custom comparison can read repository-wide refs.
 */
type Access = GitDeliveryKind | 'state' | 'pr-state' | 'pr-log' | 'file' | 'comparison'
const READS: ReadonlySet<Access> = new Set(['state', 'pr-state', 'pr-log', 'file', 'comparison'])

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
  let stopping = false
  let poll: Promise<void> | undefined
  let next = 0
  const followTimer = setInterval(() => {
    void startPoll()
  }, 30_000)
  followTimer.unref()
  function startPoll(): Promise<void> {
    if (stopping) return Promise.resolve()
    return (poll ??= followBatch()
      .catch(() => {})
      .finally(() => {
        poll = undefined
      }))
  }
  options.registerPoll?.(startPoll)

  function grantLive(id: string, grant: StoredPrFollow): boolean {
    const device = devices.get(grant.deviceId)
    const record = hub.sessionRecord(id)
    return Boolean(
      record
      && !record.archived
      && device
      && devices.standsBehind(device.id)
      && devices.prFollowEpoch(device.id) === grant.deviceEpoch
      && device.scopes.includes('run')
      && device.scopes.includes('view')
      && readsProjectFiles(device.dataScope)
      && (!record.private || device.dataScope === 'all')
      && hub.prOf(id)
      && sha256Hex(hub.prOf(id)!.url) === grant.urlHash,
    )
  }

  function currentFollow(id: string) {
    const watch = hub.prFollow(id)
    return publicFollow(watch?.enabled && !grantLive(id, watch) ? { ...watch, enabled: false } : watch)
  }
  devices.onPrAuthorityReduced(deviceId => {
    for (const id of hub.followedPrs()) {
      const grant = hub.prFollow(id)
      if (grant?.deviceId !== deviceId || grantLive(id, grant)) continue
      // The device's new epoch already denies every read and automatic turn, even if this save fails or the Host stops.
      void hub
        .changePrFollow(id, value =>
          value?.revision === grant.revision && !grantLive(id, value) ? { ...value, enabled: false } : undefined,
        )
        .then(
          () => refresh(id),
          () => {},
        )
    }
  })

  async function followBatch() {
    const ids = hub.followedPrs()
    if (!ids.length) return
    const start = next % ids.length
    // Bound work across every device and keep round-robin fairness if many PRs are watched.
    for (let count = 0; count < Math.min(4, ids.length) && !stopping; count++) {
      const id = ids[(start + count) % ids.length]!
      next = (start + count + 1) % ids.length
      const grant = hub.prFollow(id)
      if (!grant?.enabled) continue
      try {
        if (!grantLive(id, grant)) {
          await hub.changePrFollow(id, value =>
            value?.enabled && value.revision === grant.revision ? { ...value, enabled: false } : undefined,
          )
          continue
        }
        const folder = await folderOf(id)
        if (stopping || !grantLive(id, grant) || hub.prFollow(id)?.revision !== grant.revision) continue
        const state = await delivery.prState({
          sessionId: id,
          folder,
          discussion: true,
          title: false,
          boundOnly: true,
          expectedUrlHash: grant.urlHash,
          authorizeRead: () => {
            if (stopping || !grantLive(id, grant) || !hub.prFollow(id)?.enabled || hub.prFollow(id)?.revision !== grant.revision)
              throw new AppError(403, 'pr-follow-stopped', '这次跟进已停止。')
          },
        })
        if (stopping || !state.pr || sha256Hex(state.pr.url) !== grant.urlHash || !grantLive(id, grant)) continue
        const changed = advancePrFollow(grant, state, new Date(context.now()).toISOString())
        if (!changed) continue
        const newNotice = changed.notice && changed.notice !== grant.notice ? changed.notice : undefined
        const auto = newNotice && grant.automatic && changed.enabled
        if (auto && changed.notice) {
          changed.notice = { ...changed.notice, outcome: grant.paused ? 'unknown' : grant.basis ? 'unknown' : 'policy' }
          if (grant.basis) changed.paused = true
        }
        await hub.changePrFollow(id, (value, pr) =>
          value?.enabled && value.revision === grant.revision && pr?.url === state.pr?.url && grantLive(id, grant) ? changed : undefined,
        )
        if (auto && grant.basis && !grant.paused && changed.notice) {
          const at = changed.notice.at
          const current = () => {
            const saved = hub.prFollow(id)
            return !stopping && saved?.revision === grant.revision && saved.enabled && saved.notice?.at === at && grantLive(id, grant)
          }
          if (current()) {
            const request = derivedUuid(['pr-follow', id, grant.revision, at, changed.discussion, changed.failures])
            const outcome = await context
              .continuePr(id, grant.deviceId, grant.basis, request, followPrompt(state, grant), current, () =>
                delivery.matchesPrHead(folder, state.pr!),
              )
              .catch(() => 'unknown' as const)
            await hub.changePrFollow(id, value => {
              if (!value?.notice || !current()) return undefined
              const next = { ...value, notice: { ...value.notice, outcome } }
              if (outcome !== 'unknown') delete next.paused
              return next
            })
          }
        }
        if (!stopping && grantLive(id, grant)) {
          board.recordPr(id, state.pr.state)
          refresh(id)
        }
      } catch {
        // An unavailable remote didn't confirm a new state. Retry the bound PR on its next pass.
      }
    }
  }
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
    stopping = true
    clearInterval(followTimer)
    open.clear()
    await board.close()
    await delivery.close()
    await poll
  })

  /** The session's working folder: its worktree or its project's primary folder. */
  async function folderOf(sessionId: string): Promise<string> {
    const roots = await sessionRoots(sessionId)
    if (!roots) throw new AppError(404, 'task-not-found', '找不到这个会话。')
    if (roots === 'removed' || !roots[0]) throw new AppError(409, 'workspace-changed', '这个会话使用的文件夹已不在项目中或找不到了。')
    return roots[0].path
  }

  /** Checks the current device and session, including permission to read repository-wide refs. */
  function permitted(caller: DeviceCaller, sessionId: string, kind: Access): void {
    recheck(caller, READS.has(kind) ? 'view' : 'run')
    const scope = devices.get(caller.device.id)?.dataScope
    const all = scope === 'all'
    if (FILE_LEVEL.has(kind) && !readsProjectFiles(scope))
      throw new AppError(403, 'file-scope', '这台设备的数据范围不包括会话文件夹中的文件')
    if (hub.agentPrivate(sessionId) && !all)
      throw new AppError(403, 'agent-scope-required', 'Agent 含有私有记忆，请先在电脑上允许这台设备使用。')
    if (kind === 'comparison' && !all) throw new AppError(403, 'git-compare-scope', '选择比较基线需要允许这台设备查看全部数据。')
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
    const follow = /^\/link\/api\/tasks\/([^/]+)\/git\/pr\/follow$/u.exec(path)
    if (follow && (method === 'GET' || method === 'POST')) {
      const sessionId = safeDecode(follow[1]!)
      requireScope(caller, 'view')
      const checkRead = () => permitted(caller, sessionId, 'file')
      checkRead()
      if (method === 'GET') {
        limits.files.take(caller.device.id)
        json(res, { follow: currentFollow(sessionId) ?? null })
        return true
      }
      requireScope(caller, 'run')
      limits.classC.take(caller.device.id)
      const input = z
        .strictObject({
          requestId,
          revision: requestId.nullable(),
          number: z.number().int().positive(),
          enabled: z.boolean(),
          automatic: z.boolean().optional(),
        })
        .parse(await jsonBody(req))
      if (input.enabled) await context.assertSessionInput(caller, sessionId)
      const epoch = devices.prFollowEpoch(caller.device.id)
      const check = () => {
        recheck(caller, 'run')
        checkRead()
        const pr = hub.prOf(sessionId)
        if (input.enabled && devices.prFollowEpoch(caller.device.id) !== epoch)
          throw new AppError(409, 'pr-follow-changed', '设备权限已改变，请重新开启跟进。')
        if (!pr || pr.number !== input.number || hub.sessionRecord(sessionId)?.archived)
          throw new AppError(409, 'pr-follow-changed', '绑定的 PR 已改变，请刷新。')
        return pr
      }
      const bound = check()
      const old = hub.prFollow(sessionId)
      const replay = (value: StoredPrFollow | undefined) =>
        value?.revision === input.requestId
        && value.deviceId === caller.device.id
        && (!input.enabled || (value.deviceEpoch === epoch && grantLive(sessionId, value)))
        && value.enabled === input.enabled
        && !!value.automatic === !!(input.enabled && input.automatic)
      if (replay(old)) {
        json(res, { follow: publicFollow(old) })
        return true
      }
      const conflict = () => new AppError(409, 'pr-follow-changed', '跟进设置已经改变，请刷新后再试。')
      if ((old?.revision ?? null) !== input.revision) throw conflict()
      const admission = input.enabled && input.automatic ? await context.prFollowBasis(sessionId, caller.device.id) : undefined
      if (admission && 'reason' in admission) throw new AppError(409, 'pr-follow-unavailable', '无法授权此会话自动运行。可以选择后台提醒。')
      const basis = admission?.basis
      const hash = sha256Hex(bound.url)
      const baseline = input.enabled
        ? await delivery.prState({
            sessionId,
            folder: await folderOf(sessionId),
            discussion: true,
            title: false,
            boundOnly: true,
            expectedUrlHash: hash,
            authorizeRead: () => {
              check()
            },
          })
        : undefined
      if (baseline?.discussionCapped && !baseline.discussion?.length)
        throw new AppError(503, 'pr-follow-unavailable', '暂时读不到 PR 讨论，请重试。')
      if (baseline && (baseline.pr?.url !== bound.url || baseline.pr.state !== 'open')) throw conflict()
      check()
      await audited(
        {
          action: 'git.pr.watch',
          actor: actorOf(caller),
          target: sessionId,
          detail: {
            sessionId,
            number: input.number,
            enabled: input.enabled,
            automatic: !!(input.enabled && input.automatic),
            requestHash: sha256Hex(input.requestId),
          },
        },
        input.enabled ? undefined : res,
      )
      await hub.changePrFollow(sessionId, (value, pr) => {
        check()
        if (pr?.url !== bound.url) throw conflict()
        if (replay(value)) return undefined
        if ((value?.revision ?? null) !== input.revision) throw conflict()
        return {
          deviceId: caller.device.id,
          ...(epoch ? { deviceEpoch: epoch } : {}),
          urlHash: hash,
          revision: input.requestId,
          enabled: input.enabled,
          ...(input.enabled && input.automatic
            ? {
                automatic: true as const,
                ...(caller.nativeOpening?.windowHash ? { nativeWindowHash: caller.nativeOpening.windowHash } : {}),
              }
            : {}),
          ...(basis ? { basis } : {}),
          ...(baseline ? observedPr(baseline) : { discussion: [], failures: [] }),
        }
      })
      refresh(sessionId)
      checkRead()
      json(res, { follow: currentFollow(sessionId) })
      return true
    }
    const review = /^\/link\/api\/workspaces\/([^/]+)\/review-head$/u.exec(path)
    if (review && method === 'POST') {
      requireScope(caller, 'run')
      const workspaceId = safeDecode(review[1]!)
      const check = () => {
        recheck(caller, 'view')
        recheck(caller, 'run')
        if (!readsProjectFiles(devices.get(caller.device.id)?.dataScope)) throw new AppError(403, 'file-scope', '此设备不能查看项目文件。')
      }
      check()
      limits.classC.take(caller.device.id)
      const input = z.strictObject({ requestId, number: z.number().int().min(1).max(999_999_999) }).parse(await jsonBody(req))
      const source = await context.worktreeSource(workspaceId)
      const leave = context.repositoryHolds.enter()
      try {
        const head = await delivery.reviewHead(
          {
            sessionId: `workspace:${workspaceId}`,
            deviceId: caller.device.id,
            folder: source.path,
            async authorize() {
              if (source.identity !== (await context.worktreeSource(workspaceId)).identity)
                throw new AppError(409, 'workspace-changed', '项目目录已改变。')
              check()
            },
            async audit() {
              await audited({
                action: 'git.pr.review.fetch',
                actor: actorOf(caller),
                target: workspaceId,
                detail: { workspaceId, number: input.number, requestHash: sha256Hex(input.requestId) },
              })
            },
            async result() {},
          },
          input.requestId,
          input.number,
        )
        check()
        if (source.identity !== (await context.worktreeSource(workspaceId)).identity)
          throw new AppError(409, 'workspace-changed', '项目目录已改变。')
        const proof = context.reviewProof(caller.device.id, workspaceId, source.identity, head.number, head.baseRepository, head.commit)
        check()
        json(res, { ...head, proof })
      } finally {
        leave()
      }
      return true
    }
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
      const branchChoices = read[2] === 'compare-branches'
      const selectedBase = read[2] === 'compare' ? params.get('base') : null
      // Linked worktrees share local and remote refs, including refs whose contents are outside the session's files.
      const access = branchChoices || selectedBase !== null ? 'comparison' : 'file'
      permitted(caller, sessionId, access)
      limits.files.take(caller.device.id)
      const folder = await folderOf(sessionId)
      permitted(caller, sessionId, access)
      let answer
      try {
        const sha = read[3]
        const revision = sha ? { sha } : selectedBase !== null ? { base: z.string().min(1).max(200).parse(selectedBase) } : {}
        answer = branchChoices
          ? await delivery.comparisonBranches(folder)
          : read[2] === 'history'
            ? await delivery.history(folder, filePath !== undefined ? { path: filePath } : {})
            : filePath !== undefined
              ? await delivery.treeFile(folder, { ...revision, path: filePath })
              : await delivery.treeDiff(folder, revision)
      } finally {
        // A Git error can also reveal whether a ref or path exists.
        permitted(caller, sessionId, access)
      }
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
      const admission =
        state.pr?.state === 'open' && all && devices.get(caller.device.id)?.scopes.includes('run')
          ? await context.prFollowBasis(sessionId, caller.device.id)
          : undefined
      permitted(caller, sessionId, 'pr-state')
      const still = readsProjectFiles(devices.get(caller.device.id)?.dataScope)
      if (all && !still) {
        delete state.discussion
        delete state.discussionCapped
        if (state.draft) delete state.draft.title
      }
      const grant = still ? currentFollow(sessionId) : undefined
      if (grant && state.pr) state.follow = grant
      if (still && admission && 'reason' in admission) state.automaticRestriction = admission.reason
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
