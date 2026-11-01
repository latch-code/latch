import type { ServerResponse } from 'node:http'
import { z } from 'zod'
import {
  CHANGE_SCOPES,
  isFileMention,
  type ChangeScope,
  type DiscardPreview,
  type FileDiff,
  type FileMention,
  type Message,
} from '@latch/protocol'
import { AppError, type ProjectFolder } from '@latch/sdk'
import { ChangesEngine, type BeforeWrite, type ChangesSession } from '../changes/engine.ts'
import { errorText, json, jsonBody, safeDecode } from '../http-util.ts'
import { projectIdOf } from '../session-lifecycle.ts'
import type { Caller, CallerRequest, DeviceCaller, RouteContext, RouteModule } from './registry.ts'

const TASK_PATH = /^\/link\/api\/tasks\/([^/]+)\/changes(?:\/(file|patch|turns|discard|discard\/preview))?$/u
const TURN_PATH = /^\/link\/api\/tasks\/([^/]+)\/turns\/([^/]+)\/(undo|redo)$/u
const ACTIVE_STATUSES = new Set(['running', 'waiting-approval'])

const fileSchema = z.custom<FileMention>(isFileMention, '文件引用无效。')
const files = z.array(fileSchema).min(1).max(1000)
const undoSchema = z.strictObject({ requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u) })
const previewSchema = z.strictObject({ files: files.optional() })
const discardSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('turn'), turnId: z.string().min(1).max(256), files }),
  z.strictObject({
    scope: z.literal('uncommitted'),
    files: files.optional(),
    confirm: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
  }),
])

/** The run a turn belongs to, from its first prompt until its end was heard. */
interface OpenRun {
  session: ChangesSession
  runId: string
  /** The user message that opened the run: the run's edits are the tool messages after it. */
  opener?: string
  /** Its start is recorded: a run cancelled while it is held settles while that is still under way. */
  begun: Promise<void>
}

/** The edits the run's tool calls report; undefined when its messages cannot be told apart, so nothing is attributed. */
function runEdits(messages: readonly Message[], opener: string | undefined): FileDiff[] | undefined {
  const start = opener === undefined ? -1 : messages.findIndex(message => message.id === opener)
  if (start < 0) return undefined
  const after = messages.slice(start + 1)
  const end = after.findIndex(message => message.role === 'user')
  return (end < 0 ? after : after.slice(0, end)).flatMap(message => message.tool?.diffs ?? [])
}

/** Two sessions work in the same place when a folder of one is, or lies inside, a folder of the other. */
function shareFolder(a: readonly ProjectFolder[], b: readonly ProjectFolder[]): boolean {
  const inside = (path: string, parent: string) => path === parent || path.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
  return a.some(one => b.some(other => inside(one.path, other.path) || inside(other.path, one.path)))
}

/** The sentence a confirmation shows. */
function discardWarning(plan: Omit<DiscardPreview, 'warning'>): string {
  const parts = [
    ...(plan.restore ? [`把 ${plan.restore} 个文件写回上次提交的内容`] : []),
    ...(plan.remove ? [`删除 ${plan.remove} 个上次提交里没有的文件，包括未跟踪的文件`] : []),
  ]
  const skipped = plan.skipped ? `另有 ${plan.skipped} 个文件不会改动。` : ''
  if (!parts.length) return `没有可以撤销的未提交改动。${skipped}`
  return `这会${parts.join('，并')}。这些改动不在任何提交里，这个操作无法撤销。${skipped}`
}

function queryOf(url: string | undefined): { scope: ChangeScope; turnId?: string; params: URLSearchParams } {
  const params = new URL(url ?? '/', 'http://latch.invalid').searchParams
  const scope = params.get('scope') ?? 'turn'
  if (!CHANGE_SCOPES.includes(scope as ChangeScope)) throw new AppError(400, 'change-scope-invalid', '改动范围无效。')
  const turnId = params.get('turn') ?? undefined
  return { scope: scope as ChangeScope, ...(turnId ? { turnId } : {}), params }
}

export function createChangeRoutes(context: RouteContext): RouteModule {
  const { audited, actorOf, devices, hub, lifecycle, limits, log, recheck, refresh, requireLocal, sessionRoots } = context
  const requireScope: RouteContext['requireScope'] = context.requireScope
  const opened = (async () => {
    const engine = await ChangesEngine.open({ dataDir: context.dataDir, protectedPaths: context.guardedPaths, now: context.now, log })
    // A stop ends the runs it finds open, without a `runSettled`, here or in the next process.
    await engine.recover()
    return engine
  })()
  opened.catch((error: unknown) => log(`改动记录无法打开：${errorText(error)}`))
  const engine = () => opened.catch(() => Promise.reject(new AppError(503, 'change-unavailable', '改动记录暂时不可用。')))

  const open = new Map<string, OpenRun>()
  /** A run's settlement under way, which the session's next run waits for: it would otherwise find the run still open. */
  const settling = new Map<string, Promise<void>>()

  /** Told once both turns are on record; no run waits for this. */
  async function noteOverlap(run: OpenRun, others: readonly OpenRun[]): Promise<void> {
    try {
      await run.begun
      const changes = await engine()
      await changes.noteOtherSessions({ session: run.session, turnId: run.runId, others: others.map(other => other.session.id) })
      refresh(run.session.id)
      for (const other of others) {
        await other.begun
        await changes.noteOtherSessions({ session: other.session, turnId: other.runId, others: [run.session.id] })
        refresh(other.session.id)
      }
    } catch (error) {
      log(`会话 ${run.session.id} 的并行记录没有写入：${errorText(error)}`)
    }
  }

  lifecycle.on('runStarted', ({ sessionId, projectId, runId, folders }) => {
    const session: ChangesSession = { id: sessionId, projectId, folders }
    const previous = settling.get(sessionId)
    const run: OpenRun = { session, runId, begun: Promise.resolve() }
    // Two runs overlap exactly when one starts while the other is open, so looking here finds every pair once.
    const others = [...open.values()].filter(other => other.session.id !== sessionId && shareFolder(other.session.folders, folders))
    open.set(sessionId, run)
    run.begun = (async () => {
      await previous
      run.opener = (await hub.detail(sessionId).catch(() => undefined))?.messages.findLast(message => message.role === 'user')?.id
      await (await engine()).beginTurn({ session, turnId: runId })
      refresh(sessionId)
    })()
    if (others.length) void noteOverlap(run, others)
    return run.begun
  })
  lifecycle.on('runSettled', ({ sessionId, runId, outcome }) => {
    const run = open.get(sessionId)
    if (run?.runId !== runId) return undefined
    open.delete(sessionId)
    const settled = (async () => {
      await run.begun.catch(() => {})
      const detail = await hub.detail(sessionId).catch(() => undefined)
      const edits = detail && runEdits(detail.messages, run.opener)
      await (await engine()).settleTurn({ session: run.session, turnId: runId, outcome, ...(edits ? { edits } : {}) })
      refresh(sessionId)
    })()
      .catch((error: unknown) => log(`会话 ${sessionId} 这一轮的改动没有记录：${errorText(error)}`))
      .finally(() => {
        if (settling.get(sessionId) === settled) settling.delete(sessionId)
      })
    settling.set(sessionId, settled)
    return settled
  })
  lifecycle.on('sessionDeleted', async ({ sessionId, projectId }) => {
    open.delete(sessionId)
    await (await engine()).deleteSession({ id: sessionId, projectId })
  })
  lifecycle.on('hostStopping', async () => {
    open.clear()
    await (await engine()).close()
  })

  hub.notePrompts(async (sessionId, requestId, signal) => {
    const { workspaceId } = await hub.summary(sessionId)
    return (await engine()).noteFor({ session: { id: sessionId, projectId: projectIdOf({ workspaceId }) }, requestId, signal })
  })

  /** The session as the engine needs it; a session whose folders left its project has no changes to show or write. */
  async function sessionOf(sessionId: string): Promise<{ session: ChangesSession; active: boolean }> {
    const roots = await sessionRoots(sessionId)
    if (!roots) throw new AppError(404, 'task-not-found', '找不到这个会话。')
    if (roots === 'removed') throw new AppError(409, 'workspace-changed', '这个会话使用的文件夹已不在项目中或找不到了。')
    const summary = await hub.summary(sessionId)
    const folders: ProjectFolder[] = roots
    return { session: { id: sessionId, projectId: projectIdOf(summary), folders }, active: ACTIVE_STATUSES.has(summary.status) }
  }

  /** Browsing a session's folders: diffs show files no message mentioned. */
  function assertFilesVisible(caller: DeviceCaller, scope: 'view' | 'run'): void {
    recheck(caller, scope)
    if (devices.get(caller.device.id)?.dataScope !== 'all')
      throw new AppError(403, 'file-scope', '这台设备的数据范围不包括会话文件夹中的文件')
  }

  async function writable(caller: DeviceCaller, sessionId: string): Promise<ChangesSession> {
    assertFilesVisible(caller, 'run')
    limits.classC.take(caller.device.id)
    await context.assertSessionInput(caller, sessionId)
    const { session, active } = await sessionOf(sessionId)
    if (active) throw new AppError(409, 'change-running', '会话运行中，结束后才能撤销。')
    return session
  }

  /** The audit record, written first; the engine writes nothing when this throws. */
  function auditFirst(caller: DeviceCaller, confirm?: string): BeforeWrite {
    return async plan => {
      assertFilesVisible(caller, 'run')
      if (confirm !== undefined && plan.planHash !== confirm)
        throw new AppError(409, 'change-confirm-stale', '未提交的改动已变化，请重新确认。')
      const { action, sessionId, turnId, scope, restore, remove, skipped, planHash } = plan
      const counts = { sessionId, restore, remove, skipped, planHash }
      const actor = actorOf(caller)
      if (action === 'discard')
        await audited({
          action: 'change.discard',
          actor,
          target: sessionId,
          detail: { ...counts, scope: scope!, ...(turnId ? { turnId } : {}) },
        })
      else
        await audited({
          action: action === 'undo' ? 'change.undo' : 'change.redo',
          actor,
          target: sessionId,
          detail: { ...counts, turnId: turnId! },
        })
    }
  }

  async function reads(res: ServerResponse, caller: DeviceCaller, sessionId: string, part: string | undefined, url: string | undefined) {
    assertFilesVisible(caller, 'view')
    limits.files.take(caller.device.id)
    const { session } = await sessionOf(sessionId)
    const changes = await engine()
    const answer = async () => {
      if (part === 'turns') return { turns: await changes.turns({ session }) }
      const { scope, turnId, params } = queryOf(url)
      const target = { session, scope, ...(turnId ? { turnId } : {}) }
      if (part === 'patch') return changes.patch(target)
      if (part !== 'file') return changes.list(target)
      const file = { root: params.get('root') ?? session.folders[0]?.id ?? '', path: params.get('path') ?? '' }
      if (!isFileMention(file)) throw new AppError(400, 'change-file-invalid', '文件引用无效。')
      const lines = params.get('context')
      return changes.file({ ...target, file, ...(lines === null ? {} : { context: Math.min(Number(lines), 100_000) }) })
    }
    const body = await answer()
    assertFilesVisible(caller, 'view')
    json(res, body)
  }

  async function route(request: CallerRequest): Promise<boolean> {
    const { req, res, path, method } = request
    const caller: Caller = request.caller
    const turn = TURN_PATH.exec(path)
    if (turn && method === 'POST') {
      requireScope(caller, 'run')
      const input = undoSchema.parse(await jsonBody(req))
      const session = await writable(caller, safeDecode(turn[1]!))
      const changes = await engine()
      const request = { session, turnId: safeDecode(turn[2]!), requestId: input.requestId, beforeWrite: auditFirst(caller) }
      json(res, turn[3] === 'undo' ? await changes.undoTurn(request) : await changes.redoTurn(request))
      refresh(session.id)
      return true
    }
    const task = TASK_PATH.exec(path)
    if (!task) return false
    const sessionId = safeDecode(task[1]!),
      part = task[2]
    if (method === 'GET' && (part === undefined || part === 'file' || part === 'patch' || part === 'turns')) {
      requireScope(caller, 'view')
      await reads(res, caller, sessionId, part, req.url)
      return true
    }
    if (method !== 'POST') return false
    if (part === 'discard/preview') {
      requireScope(caller, 'run')
      requireLocal(caller)
      const input = previewSchema.parse(await jsonBody(req))
      const session = await writable(caller, sessionId)
      const plan = await (await engine()).previewDiscard({ session, ...(input.files ? { files: input.files } : {}) })
      json(res, { ...plan, warning: discardWarning(plan) } satisfies DiscardPreview)
      return true
    }
    if (part === 'discard') {
      requireScope(caller, 'run')
      const input = discardSchema.parse(await jsonBody(req))
      if (input.scope === 'uncommitted') {
        // Nothing brings these files back, as with an agent's delete that only this computer may approve.
        requireLocal(caller)
        if (input.confirm === undefined) throw new AppError(409, 'change-confirm-required', '这个操作会删除文件且无法撤销，请先确认。')
      }
      const session = await writable(caller, sessionId)
      const target =
        input.scope === 'turn'
          ? { scope: 'turn' as const, turnId: input.turnId, files: input.files }
          : { scope: 'uncommitted' as const, ...(input.files ? { files: input.files } : {}) }
      const confirm = input.scope === 'uncommitted' ? input.confirm : undefined
      json(res, await (await engine()).discard({ session, target, beforeWrite: auditFirst(caller, confirm) }))
      refresh(session.id)
      return true
    }
    return false
  }

  return { route, features: () => ({ changes: true }) }
}
