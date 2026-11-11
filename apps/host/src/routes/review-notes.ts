import { setTimeout as sleep } from 'node:timers/promises'
import { isFileMention, reviewNotesMessage, type HostFeatures, type ReviewNoteList, type ReviewNoteSendResult } from '@latch/protocol'
import { AppError, type ProjectFolder } from '@latch/sdk'
import { z } from 'zod'
import { json, jsonBody, KIB, safeDecode } from '../http-util.ts'
import {
  createNoteSchema,
  deleteNoteSchema,
  editNoteSchema,
  sendNotesSchema,
  statusNoteSchema,
  type OpenSend,
  type ReviewNotes,
  type Writer,
} from '../review-notes.ts'
import type { Caller, DeviceCaller, RouteContext, RouteModule } from './registry.ts'

export interface ReviewNoteRouteDeps {
  notes: () => ReviewNotes
  /** Every new input to a session goes through the Host's own prompt path, with its checks and the driver's receipt. */
  send: (
    caller: DeviceCaller,
    sessionId: string,
    input: { requestId: string; prompt: string; queue?: true },
  ) => Promise<{ queueId?: string }>
  /** A queued item of the session, by its ID or by the request ID it was queued with. */
  queueItem: (
    sessionId: string,
    by: { id: string } | { requestId: string },
  ) => { id: string; state: string; sendRequestId: string } | undefined
  /** A prompt with this request ID is on its way to the session or was accepted, from any device. */
  promptHeld: (sessionId: string, requestId: string) => boolean
}

const PATH =
  /^\/link\/api\/tasks\/([^/]+)\/review-notes(?:\/(send|rn_[a-f0-9-]{36}|sends\/snd_[a-f0-9-]{36})(?:\/(edit|status|delete|retry|abandon))?)?$/u
/** A hundred lines of a thousand characters, the text and JSON escapes. */
const CREATE_LIMIT = 512 * KIB
const BODY_LIMIT = 32 * KIB
/** How long a send waits for its message to show up in the session before answering without its ID. */
const MESSAGE_WAIT_MS = 5000
/** A queued item in these states will not go out by itself. */
const QUEUE_GONE = new Set(['removed', 'dropped'])
const requestOnly = z.strictObject({ requestId: z.string().uuid() })

/** A refusal the Host gave before anything reached the session; anything else may have gone through. */
const refused = (cause: unknown) => cause instanceof AppError && cause.status >= 400 && cause.status < 500 && cause.status !== 408

/**
 * 行级反馈: notes on a session's changed lines, kept on the Host, and the one message that sends a set of them. The notes
 * quote code, so every route needs the data scope of the session's folders; the snapshot carries counts only.
 *
 * A send's message carries a request ID the Host made for it, so only that message settles it. Until it does, the notes
 * stay pending and locked: while the message waits in the queue, while its answer is unknown, or while it is on its way.
 */
export function createReviewNoteRoutes(context: RouteContext, deps: ReviewNoteRouteDeps): RouteModule {
  const { recheck, devices, sessionRoots, hub, limits, refresh, lifecycle } = context
  const requireScope: RouteContext['requireScope'] = context.requireScope

  lifecycle.on('sessionDeleted', ({ sessionId }) => deps.notes().deleteSession(sessionId))

  function assertFilesVisible(caller: DeviceCaller, scope: 'view' | 'run'): void {
    recheck(caller, scope)
    if (devices.get(caller.device.id)?.dataScope !== 'all')
      throw new AppError(403, 'file-scope', '这台设备的数据范围不包括会话文件夹中的文件')
  }

  async function foldersOf(sessionId: string): Promise<ProjectFolder[]> {
    const roots = await sessionRoots(sessionId)
    if (!roots) throw new AppError(404, 'task-not-found', '找不到这个会话。')
    if (roots === 'removed') throw new AppError(409, 'workspace-changed', '这个会话使用的文件夹已不在项目中或找不到了。')
    return roots
  }

  async function writer(caller: DeviceCaller, sessionId: string): Promise<Writer> {
    assertFilesVisible(caller, 'run')
    limits.classC.take(caller.device.id)
    await context.assertSessionInput(caller, sessionId)
    await foldersOf(sessionId)
    assertFilesVisible(caller, 'run')
    return { deviceId: caller.device.id, name: devices.get(caller.device.id)?.name ?? '' }
  }

  /** Throws when the session cannot be read: no answer is never taken for "no message", which would free the notes. */
  async function messageFor(sessionId: string, requestId: string): Promise<string | undefined> {
    const detail = await hub.detail(sessionId)
    return detail.messages.find(message => message.role === 'user' && message.requestId === requestId)?.id
  }

  type Outcome = { sent: string } | { queued: string } | { open: true } | { dropped: true }

  /**
   * Where a send stands now. Its message in the session: sent. In the queue: the message it will carry, which an edit of
   * the item changes; an item removed or dropped returns the notes. Otherwise open, unless `dropIdle` and nothing of it
   * is on its way, accepted or queued.
   */
  async function standing(sessionId: string, send: OpenSend, dropIdle: boolean, claimed = false): Promise<Outcome> {
    const notes = deps.notes()
    const item = send.queueId
      ? deps.queueItem(sessionId, { id: send.queueId })
      : send.queue
        ? deps.queueItem(sessionId, { requestId: send.promptRequestId })
        : undefined
    const messageId = (item && (await messageFor(sessionId, item.sendRequestId))) ?? (await messageFor(sessionId, send.promptRequestId))
    if (messageId) {
      await notes.settleSend(sessionId, send.id, messageId)
      return { sent: messageId }
    }
    if (item && !QUEUE_GONE.has(item.state)) {
      if (send.queueId !== item.id) await notes.markQueued(sessionId, send.id, item.id)
      return { queued: item.id }
    }
    if (send.queueId || (dropIdle && !deps.promptHeld(sessionId, send.promptRequestId))) {
      await notes.dropSend(sessionId, send.id, claimed)
      return { dropped: true }
    }
    return { open: true }
  }

  /** Settles what can be settled; a removed device's open sends with nothing on their way go back to pending. */
  async function settleOpen(sessionId: string): Promise<boolean> {
    let changed = false
    for (const send of deps.notes().openSends(sessionId)) {
      const gone = !devices.isActive(send.deviceId)
      try {
        const outcome = await standing(sessionId, send, gone)
        if (!('open' in outcome) && !('queued' in outcome && send.queueId === outcome.queued)) changed = true
      } catch {
        // Being pushed, or the session could not be read: it stays open and the list says so.
      }
    }
    return changed
  }

  /**
   * Sends the stored message with the Host's request ID, or finds that it already went, and answers what came of it. The
   * send is claimed first, so no abandon or drop can free its notes while it may still go out.
   */
  async function push(caller: DeviceCaller, sessionId: string, id: string): Promise<{ status: number; body: ReviewNoteSendResult }> {
    const notes = deps.notes()
    const send = await notes.claim(sessionId, id)
    if (!send) throw new AppError(409, 'review-send-gone', '这次发送已经有结果了，请刷新。')
    try {
      const before = await standing(sessionId, send, false, true)
      if ('sent' in before) return { status: 200, body: { noteIds: send.noteIds, messageId: before.sent } }
      if ('queued' in before) return { status: 200, body: { noteIds: send.noteIds, queueId: before.queued } }
      if ('dropped' in before) throw new AppError(409, 'review-send-dropped', '排队的消息已移除，反馈回到待发。')
      let queueId: string | undefined
      try {
        ;({ queueId } = await deps.send(caller, sessionId, {
          requestId: send.promptRequestId,
          prompt: send.prompt,
          ...(send.queue ? { queue: true as const } : {}),
        }))
      } catch (cause) {
        if (refused(cause) && !deps.promptHeld(sessionId, send.promptRequestId)) await notes.dropSend(sessionId, send.id, true)
        throw cause
      }
      if (queueId) {
        await notes.markQueued(sessionId, send.id, queueId)
        return { status: 200, body: { noteIds: send.noteIds, queueId } }
      }
      for (let waited = 0; waited < MESSAGE_WAIT_MS; waited += 100) {
        const messageId = await messageFor(sessionId, send.promptRequestId).catch(() => undefined)
        if (messageId) {
          await notes.settleSend(sessionId, send.id, messageId)
          return { status: 200, body: { noteIds: send.noteIds, messageId } }
        }
        await sleep(100)
      }
      // Accepted, but not in the session yet: the notes stay pending until a later read finds the message.
      return { status: 202, body: { noteIds: send.noteIds } }
    } finally {
      notes.release(send.id)
    }
  }

  // A note's count is in the snapshot, which a session's own state event does not carry: every write reads it again.
  return {
    features: () => ({ reviewNotes: true }) satisfies HostFeatures,
    async route(request) {
      const { req, res, path, method } = request
      const caller: Caller = request.caller
      const match = PATH.exec(path)
      if (!match) return false
      const sessionId = safeDecode(match[1]!),
        target = match[2],
        action = match[3]
      const notes = deps.notes()
      if (!target && method === 'GET') {
        requireScope(caller, 'view')
        assertFilesVisible(caller, 'view')
        limits.files.take(caller.device.id)
        await foldersOf(sessionId)
        if (await settleOpen(sessionId)) refresh()
        const open = notes.openSends(sessionId).map(({ id, noteIds, queue, queueId }) => ({
          id,
          noteIds,
          ...(queue ? { queue } : {}),
          ...(queueId ? { queueId } : {}),
        }))
        const list: ReviewNoteList = { ...notes.list(sessionId), ...(open.length ? { openSends: open } : {}) }
        assertFilesVisible(caller, 'view')
        json(res, list)
        return true
      }
      if (method !== 'POST') return false
      requireScope(caller, 'run')
      if (!target) {
        if (action) return false
        const input = createNoteSchema.parse(await jsonBody(req, CREATE_LIMIT))
        const who = await writer(caller, sessionId)
        const folders = await foldersOf(sessionId)
        const file = { root: input.root, path: input.path }
        if (!isFileMention(file) || !folders.some(folder => folder.id === input.root))
          throw new AppError(400, 'review-note-file', '文件引用无效。')
        json(res, await notes.create(sessionId, who, input), 201)
        refresh()
        return true
      }
      if (target === 'send') {
        if (action) return false
        const input = sendNotesSchema.parse(await jsonBody(req, BODY_LIMIT))
        const who = await writer(caller, sessionId)
        const folders = await foldersOf(sessionId)
        const names = new Map(folders.map(folder => [folder.id, folder.path.split('/').at(-1) || folder.id]))
        const begun = await notes.beginSend(sessionId, who, input, picked =>
          reviewNotesMessage(
            picked.map(note => ({ ...note, ...(folders.length > 1 ? { folder: names.get(note.root) ?? note.root } : {}) })),
          ),
        )
        refresh()
        if ('settled' in begun) {
          json(res, begun.settled)
          return true
        }
        try {
          const answer = await push(caller, sessionId, begun.open.id)
          json(res, answer.body, answer.status)
        } finally {
          refresh()
        }
        return true
      }
      if (target.startsWith('sends/')) {
        requestOnly.parse(await jsonBody(req, BODY_LIMIT))
        await writer(caller, sessionId)
        const send = notes.findSend(sessionId, target.slice('sends/'.length))
        if (action === 'retry') {
          // Any device that may write retries with the Host's own request ID: the driver's receipt answers a second try.
          try {
            const answer = await push(caller, sessionId, send.id)
            json(res, answer.body, answer.status)
          } finally {
            refresh()
          }
          return true
        }
        if (action !== 'abandon') return false
        const outcome = await standing(sessionId, send, false)
        refresh()
        if ('sent' in outcome) throw new AppError(409, 'review-send-delivered', '这次发送已经送达，反馈已标为已发送。')
        if ('queued' in outcome) throw new AppError(409, 'review-send-queued', '消息还在队列里：先在队列中移除它。')
        if ('open' in outcome) {
          if (deps.promptHeld(sessionId, send.promptRequestId))
            throw new AppError(409, 'review-send-in-progress', '消息正在发给会话或已被接收，请稍后查询结果。')
          // Under the session's lock: refused while a retry holds the send, so it cannot go out after this.
          await notes.dropSend(sessionId, send.id)
        }
        json(res, { dropped: send.id })
        return true
      }
      if (action === 'edit') {
        const input = editNoteSchema.parse(await jsonBody(req, BODY_LIMIT))
        json(res, await notes.edit(sessionId, await writer(caller, sessionId), target, input))
      } else if (action === 'status') {
        const input = statusNoteSchema.parse(await jsonBody(req, BODY_LIMIT))
        json(res, await notes.setStatus(sessionId, await writer(caller, sessionId), target, input))
      } else if (action === 'delete') {
        const input = deleteNoteSchema.parse(await jsonBody(req, BODY_LIMIT))
        json(res, await notes.remove(sessionId, await writer(caller, sessionId), target, input))
      } else return false
      refresh()
      return true
    },
  }
}
