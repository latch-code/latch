import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import {
  isLocalListener,
  type AttachmentCapabilities,
  type AttachmentSelection,
  type AttachmentRef,
  type Device,
  type DeviceScope,
  type FileMetadata,
  type ListenerClass,
  type ReservedAttachments,
  type TaskDetail,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import type { AuditActor, AuditLog } from './audit.ts'
import { json, jsonBody } from './http-util.ts'
import { byteRange } from './files/read.ts'
import { FileReadQuota } from './files/quota.ts'
import { AttachmentStore, ATTACHMENT_FILE_LIMIT } from './attachments.ts'
import { attachmentContext as context, type AttachmentUploads } from './attachment-uploads.ts'
const ID = /^[A-Za-z0-9_-]{22}$/u
const metadata = context.extend({
  requestId: z.string().uuid(),
  name: z.string().min(1).max(200),
  size: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024),
  secretAcknowledged: z.boolean().optional(),
})
const uploadStart = context.extend({
  requestId: z.string().uuid(),
  name: z.string().min(1).max(200),
  kind: z.enum(['image', 'text']),
  size: z.number().int().positive().max(ATTACHMENT_FILE_LIMIT),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
})
interface AttachmentCaller {
  device?: Device
  connection: { listener: ListenerClass }
}
export interface AttachmentRoutesOptions<Caller extends AttachmentCaller> {
  store: AttachmentStore
  uploads: AttachmentUploads
  now: () => number
  audit: Pick<AuditLog, 'append'>
  actorOf(caller: Caller): AuditActor
  authorize(caller: Caller, scope: DeviceScope): void
  recheck(caller: Caller, scope: DeviceScope): void
  sessionAccess(caller: Caller, id: string): Promise<TaskDetail>
  capabilities(caller: Caller, selection: AttachmentSelection, sessionId?: string): Promise<AttachmentCapabilities>
  /** Of this device's reserved uploads, the IDs the Host proves now that no saved message or request needs. */
  unused(caller: Caller, reserved: ReturnType<AttachmentStore['reserved']>): Promise<ReadonlySet<string>>
  /** A request carrying this ID is on its way or was accepted in this run; asked again at the moment of removal. */
  busy(caller: Caller, requestId: string): boolean
}
export function assertAttachmentCapability(ref: Pick<AttachmentRef, 'kind' | 'size'>, caps: AttachmentCapabilities): void {
  if (ref.kind === 'image' && !caps.images) throw new AppError(415, 'attachment-image-unsupported', caps.reason ?? '当前模型不能看图片。')
  if (ref.kind === 'text' && !caps.text)
    throw new AppError(415, 'attachment-text-unsupported', caps.reason ?? '当前 Harness 不接受文本附件。')
  if (ref.kind === 'text' && ref.size > caps.textBytes)
    throw new AppError(415, 'attachment-text-too-large', `当前 Harness 只接受 ${Math.floor(caps.textBytes / 1024)} KB 以内的文本附件。`)
}
export function createAttachmentRoutes<Caller extends AttachmentCaller>(options: AttachmentRoutesOptions<Caller>) {
  const releases = new Map<string, { asked: string; released: Promise<{ count: number; bytes: number }> }>()
  const handles = new Map<string, { device: string; id: string; until: number }>(),
    quota = new FileReadQuota(options.now)
  const get = async (caller: Caller, id: string) => {
    options.recheck(caller, 'view')
    const device = caller.device
    if (!device) throw new AppError(401, 'unauthorized', '请先连接设备。')
    const entry = options.store.get(id)
    if (!entry) throw new AppError(404, 'attachment-missing', '附件已过期或不存在。')
    if (entry.taskId) {
      const detail = await options.sessionAccess(caller, entry.taskId)
      if (!detail.messages.some(message => message.attachments?.some(ref => ref.id === id)))
        throw new AppError(404, 'attachment-missing', '会话中没有这个附件。')
    } else if (entry.owner !== device.id) throw new AppError(404, 'attachment-missing', '附件已过期或不存在。')
    options.recheck(caller, 'view')
    return entry
  }
  return {
    async handle(req: IncomingMessage, res: ServerResponse, caller: Caller, path: string, method: string): Promise<boolean> {
      if (!path.startsWith('/link/api/attachments')) return false
      const device = caller.device
      if (!device) throw new AppError(401, 'unauthorized', '请先连接设备。')
      if (path === '/link/api/attachments/capabilities' && method === 'POST') {
        options.authorize(caller, 'run')
        const input = context.parse(await jsonBody(req))
        const caps = await options.capabilities(caller, input.selection, input.sessionId)
        options.recheck(caller, 'run')
        json(res, { capabilities: caps })
        return true
      }
      if (path === '/link/api/attachments/reserved' && method === 'GET') {
        options.authorize(caller, 'run')
        const reserved = options.store.reserved(device.id),
          unused = await options.unused(caller, reserved)
        options.recheck(caller, 'run')
        const releasable = reserved.filter(item => unused.has(item.id))
        const view: ReservedAttachments = {
          count: reserved.length,
          bytes: reserved.reduce((sum, item) => sum + item.size, 0),
          releasable: releasable.length,
          releasableBytes: releasable.reduce((sum, item) => sum + item.size, 0),
          items: reserved.map(item => ({ id: item.id, bytes: item.size, requestId: item.requestId, releasable: unused.has(item.id) })),
        }
        json(res, { reserved: view })
        return true
      }
      if (path === '/link/api/attachments/reserved/release' && method === 'POST') {
        options.authorize(caller, 'run')
        const input = z
          .strictObject({ requestId: z.string().uuid(), ids: z.array(z.string().regex(ID)).min(1).max(64) })
          .parse(await jsonBody(req))
        // The same request gets its first answer: a retry after a lost response releases nothing more.
        const key = `${device.id}:${input.requestId}`,
          asked = [...new Set(input.ids)].sort().join(',')
        // One release per request at a time: a copy sent meanwhile waits for the first and gets its answer.
        const earlier = releases.get(key)
        if (earlier) {
          if (earlier.asked !== asked) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同的附件。')
          json(res, { released: await earlier.released })
          return true
        }
        const releasing = (async () => {
          // Only what the person was shown and confirmed, of this device's own.
          const shown = new Set(input.ids)
          const reserved = options.store.reserved(device.id).filter(item => shown.has(item.id)),
            unused = await options.unused(caller, reserved)
          options.recheck(caller, 'run')
          const proven = new Map(reserved.filter(item => unused.has(item.id)).map(item => [item.id, item.requestId]))
          return options.store.releaseReserved(device.id, proven, requestId => options.busy(caller, requestId))
        })()
        releases.set(key, { asked, released: releasing })
        let released: { count: number; bytes: number }
        try {
          released = await releasing
        } catch (error) {
          // Nothing was released, or it is not known: the same request may try again.
          if (releases.get(key)?.released === releasing) releases.delete(key)
          throw error
        }
        if (releases.size > 256) releases.delete(releases.keys().next().value!)
        // A removal is never held back by the audit: a record that cannot be written is said in the response.
        if (released.count)
          await options.audit
            .append({
              action: 'attachment.released',
              actor: options.actorOf(caller),
              target: device.id,
              detail: { requestId: input.requestId, count: released.count, bytes: released.bytes },
            })
            .catch(() => res.setHeader('x-latch-audit', 'failed'))
        json(res, { released })
        return true
      }
      const upload = /^\/link\/api\/attachments\/uploads(?:\/([A-Za-z0-9_-]{22})(?:\/(complete|parts\/(\d{1,3})))?)?$/u.exec(path)
      if (upload) {
        options.authorize(caller, 'run')
        const [, uploadId, step, part] = upload
        const remote = !isLocalListener(caller.connection.listener)
        if (!uploadId && method === 'POST') {
          const input = uploadStart.parse(await jsonBody(req))
          const caps = await options.capabilities(caller, input.selection, input.sessionId)
          if (!caps.images && !caps.text) throw new AppError(415, 'attachments-unsupported', caps.reason ?? '当前 Harness 不接受附件。')
          assertAttachmentCapability(input, caps)
          options.recheck(caller, 'run')
          const begun = await options.uploads.begin({
            owner: device.id,
            requestId: input.requestId,
            name: input.name,
            kind: input.kind,
            size: input.size,
            sha256: input.sha256,
            remote,
            context: { selection: input.selection, ...(input.sessionId ? { sessionId: input.sessionId } : {}) },
          })
          options.recheck(caller, 'run')
          json(res, begun, 201)
          return true
        }
        if (uploadId && !step && method === 'GET') {
          json(res, { upload: options.uploads.status(device.id, uploadId) })
          return true
        }
        if (uploadId && !step && method === 'DELETE') {
          await options.uploads.abort(device.id, uploadId)
          json(res, { aborted: true })
          return true
        }
        if (uploadId && part !== undefined && method === 'PUT') {
          if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/octet-stream' || req.headers['content-encoding'])
            throw new AppError(415, 'attachment-invalid', '附件上传需要原始文件内容。')
          const length = req.headers['content-length'] === undefined ? undefined : Number(req.headers['content-length'])
          const timer = setTimeout(() => req.destroy(), 60_000)
          try {
            const view = await options.uploads.part({
              owner: device.id,
              id: uploadId,
              index: Number(part),
              ...(length !== undefined && Number.isSafeInteger(length) ? { declared: length } : {}),
              stream: req,
              recheck: () => {
                if (req.aborted) throw new AppError(400, 'attachment-incomplete', '附件上传已中断。')
                options.recheck(caller, 'run')
              },
            })
            json(res, { upload: view })
          } finally {
            clearTimeout(timer)
          }
          return true
        }
        if (uploadId && step === 'complete' && method === 'POST') {
          const input = z.strictObject({ secretAcknowledged: z.boolean().optional() }).parse(await jsonBody(req))
          const ref = await options.uploads.complete({
            owner: device.id,
            id: uploadId,
            remote,
            ...(input.secretAcknowledged ? { secretAcknowledged: true } : {}),
            recheck: () => options.recheck(caller, 'run'),
            accept: async (ref, chosen) => {
              const current = await options.capabilities(caller, chosen.selection, chosen.sessionId)
              assertAttachmentCapability(ref, current)
            },
            // The record is written once, for the attachment the parts make: not per part.
            audit: async ref => {
              await options.audit.append({
                action: 'attachment.add',
                actor: options.actorOf(caller),
                target: ref.id,
                detail: { attachmentId: ref.id, contentHash: ref.sha256, bytes: ref.size, type: ref.kind },
              })
            },
          })
          json(res, { attachment: ref }, 201)
          return true
        }
        return false
      }
      if (path === '/link/api/attachments' && method === 'POST') {
        options.authorize(caller, 'run')
        if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/octet-stream' || req.headers['content-encoding'])
          throw new AppError(415, 'attachment-invalid', '附件上传需要原始文件内容。')
        const raw = req.headers['x-latch-attachment']
        if (typeof raw !== 'string' || raw.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(raw))
          throw new AppError(400, 'attachment-invalid', '附件元数据无效。')
        let parsed: unknown
        try {
          parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
        } catch {
          throw new AppError(400, 'attachment-invalid', '附件元数据无效。')
        }
        const input = metadata.parse(parsed),
          caps = await options.capabilities(caller, input.selection, input.sessionId)
        // Expired chunked uploads give back the room they held before this one is counted.
        await options.uploads.prune()
        if (!caps.images && !caps.text) throw new AppError(415, 'attachments-unsupported', caps.reason ?? '当前 Harness 不接受附件。')
        const timer = setTimeout(() => req.destroy(), 60_000)
        try {
          const ref = await options.store.add({
            owner: device.id,
            requestId: input.requestId,
            name: input.name,
            size: input.size,
            remote: !isLocalListener(caller.connection.listener),
            secretAcknowledged: input.secretAcknowledged,
            stream: req,
            recheck: () => {
              if (req.aborted) throw new AppError(400, 'attachment-incomplete', '附件上传已中断。')
              options.recheck(caller, 'run')
            },
            accept: async ref => {
              const current = await options.capabilities(caller, input.selection, input.sessionId)
              assertAttachmentCapability(ref, current)
            },
            ...(isLocalListener(caller.connection.listener)
              ? {}
              : {
                  audit: async (ref: AttachmentRef) => {
                    await options.audit.append({
                      action: 'attachment.add',
                      actor: options.actorOf(caller),
                      target: ref.id,
                      detail: { attachmentId: ref.id, contentHash: ref.sha256, bytes: ref.size, type: ref.kind },
                    })
                  },
                }),
          })
          json(res, { attachment: ref }, 201)
        } finally {
          clearTimeout(timer)
        }
        return true
      }
      const match = /^\/link\/api\/attachments\/([A-Za-z0-9_-]{22})(?:\/(resolve|content))?$/u.exec(path)
      if (!match) return false
      const id = match[1]!,
        action = match[2]
      if (method === 'DELETE' && !action) {
        options.authorize(caller, 'run')
        await options.store.remove(id, device.id, requestId => options.busy(caller, requestId))
        json(res, { removed: true })
        return true
      }
      if (method === 'POST' && action === 'resolve') {
        options.authorize(caller, 'view')
        const entry = await get(caller, id)
        for (const [key, value] of handles) if (value.until <= options.now()) handles.delete(key)
        if (handles.size >= 4096) handles.delete(handles.keys().next().value!)
        const handle = randomBytes(16).toString('base64url')
        handles.set(handle, { device: device.id, id, until: options.now() + 10 * 60_000 })
        const file: FileMetadata = {
          handle,
          name: entry.ref.name,
          root: 'attachment',
          path: entry.ref.name,
          ext: entry.ref.name.split('.').at(-1)?.toLowerCase() ?? '',
          kind: entry.ref.kind === 'image' ? 'image' : 'text',
          mime: entry.ref.kind === 'image' ? entry.ref.mime : 'application/octet-stream',
          size: entry.ref.size,
          mtime: 0,
          etag: `"${entry.ref.sha256.slice(0, 32)}"`,
          limit: entry.ref.size,
          secret: entry.secret,
          source: 'attachment',
          attachmentId: id,
          ...(entry.ref.width ? { width: entry.ref.width, height: entry.ref.height } : {}),
          actions: { preview: true, download: true, reveal: false, quicklook: false, open: false },
        }
        json(res, { file })
        return true
      }
      if ((method === 'GET' || method === 'HEAD') && action === 'content') {
        options.authorize(caller, 'view')
        const handle = handles.get(id)
        if (!handle || handle.device !== device.id || handle.until <= options.now())
          throw new AppError(404, 'attachment-missing', '附件预览已过期，请重新打开。')
        const entry = await get(caller, handle.id),
          budget = quota.begin(device.id, isLocalListener(caller.connection.listener))
        try {
          budget.consume(method === 'HEAD' ? 0 : entry.ref.size)
          if (!isLocalListener(caller.connection.listener))
            await options.audit.append({
              action: 'attachment.view',
              actor: options.actorOf(caller),
              target: entry.ref.id,
              detail: { attachmentId: entry.ref.id, contentHash: entry.ref.sha256, bytes: entry.ref.size, type: entry.ref.kind },
            })
          const tag = `"${entry.ref.sha256.slice(0, 32)}"`,
            range = req.headers['if-range'] && req.headers['if-range'] !== tag ? undefined : byteRange(req.headers.range, entry.ref.size),
            start = range?.start ?? 0,
            end = range?.end ?? entry.ref.size - 1
          await get(caller, handle.id)
          res.setHeader('content-type', entry.ref.kind === 'image' ? entry.ref.mime : 'application/octet-stream')
          res.setHeader(
            'content-disposition',
            `attachment; filename*=UTF-8''${encodeURIComponent(entry.ref.name).replace(/['()*]/gu, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
          )
          res.setHeader('x-content-type-options', 'nosniff')
          res.setHeader('content-security-policy', "sandbox; default-src 'none'")
          res.setHeader('cross-origin-resource-policy', 'same-origin')
          res.setHeader('cache-control', 'private, no-store')
          res.setHeader('accept-ranges', 'bytes')
          res.setHeader('etag', tag)
          if (req.headers['if-none-match'] === tag && !req.headers.range) {
            res.writeHead(304)
            res.end()
            return true
          }
          const content = method === 'HEAD' ? undefined : await options.store.read(entry.ref)
          res.setHeader('content-length', end - start + 1)
          if (range) res.setHeader('content-range', `bytes ${start}-${end}/${entry.ref.size}`)
          res.writeHead(range ? 206 : 200)
          if (method === 'HEAD') {
            res.end()
            return true
          }
          for (let offset = start; offset <= end && !res.destroyed; offset += 65536) {
            await get(caller, handle.id)
            const bytes = content!.data.subarray(offset, Math.min(end + 1, offset + 65536))
            await get(caller, handle.id)
            if (!res.write(bytes)) {
              const drained = await new Promise<boolean>(done => {
                const close = () => {
                    res.off('drain', drain)
                    done(false)
                  },
                  drain = () => {
                    res.off('close', close)
                    done(true)
                  }
                res.once('close', close)
                res.once('drain', drain)
              })
              if (!drained) return true
            }
          }
          res.end()
        } catch (error) {
          if (res.headersSent) {
            res.destroy()
            return true
          }
          throw error
        } finally {
          budget.release()
        }
        return true
      }
      return false
    },
  }
}
