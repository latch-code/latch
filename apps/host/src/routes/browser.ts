// The browser provider's routes, for the desktop app's main process alone: host.sock, a device enrolled there, and a
// registration signed with that device's key on a nonce of its own, as adding folders is (main's proxy answers the
// page's own requests to these paths with 403 shell-managed). And one read for any device that may read the session:
// the tab list the phone shows. See docs/PREVIEW-BROWSER.md.
import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { TaskDetail } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { localOnly } from '../access.ts'
import type { BrowserBroker } from '../browser-broker.ts'
import { KIB, json, jsonBody, safeDecode } from '../http-util.ts'
import type { Caller, DeviceCaller, RouteContext, RouteModule } from './registry.ts'

const RESULT_LIMIT = 1024 * KIB
const IMAGE_LIMIT = 5 * 1024 * KIB
const TABS_LIMIT = 256 * KIB
const PROVIDER_ID = z.string().regex(/^bpv_[A-Za-z0-9_-]{22}$/u)
const TAB_ID = z.string().regex(/^brw_[A-Za-z0-9_-]{22}$/u)
const SESSION_ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u)
const IMAGE_PATH = /^\/link\/api\/browser-provider\/results\/([0-9a-f-]{36})\/image$/u
const TABS_PATH = /^\/link\/api\/tasks\/([^/]+)\/browser-tabs$/u

const registerSchema = z.strictObject({
  nonce: z.string().min(1).max(128),
  purpose: z.literal('browser-provider'),
  signature: z.string().max(512),
})
const providerSchema = z.strictObject({ providerId: PROVIDER_ID })
const tabSchema = z.strictObject({
  tabId: TAB_ID,
  sessionId: SESSION_ID,
  title: z.string().max(256),
  url: z.string().max(8192),
  loading: z.boolean(),
  control: z.enum(['agent', 'person']).nullable(),
  opener: z.enum(['agent', 'person']),
})
const tabsSchema = z.strictObject({ providerId: PROVIDER_ID, tabs: z.array(tabSchema).max(64) })
const resultSchema = z.strictObject({
  callId: z.string().uuid(),
  ok: z.boolean(),
  dispatched: z.boolean(),
  text: z
    .string()
    .max(512 * KIB)
    .optional(),
  error: z
    .string()
    .regex(/^[a-z][a-z-]{0,63}$/u)
    .optional(),
  tab: z.strictObject({ tabId: TAB_ID, url: z.string().max(8192), title: z.string().max(256) }).optional(),
  refs: z
    .record(z.string().regex(/^e[0-9]{1,6}$/u), z.boolean())
    .refine(value => Object.keys(value).length <= 2_000)
    .optional(),
  image: z.boolean().optional(),
})

export interface BrowserRouteDeps {
  broker: BrowserBroker
  /** A session the caller may read, with the Host's checks: scope, private sessions. */
  readSession: (caller: DeviceCaller, sessionId: string) => Promise<TaskDetail>
}

async function bytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new AppError(413, 'body-too-large', '截图超过 5 MB')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

const notProvider = () => new AppError(409, 'browser-provider-replaced', '浏览器提供者已被替换或已结束')

export function createBrowserRoutes(context: RouteContext, deps: BrowserRouteDeps): RouteModule {
  const { devices, lifecycle } = context
  const { broker } = deps
  lifecycle.on('sessionArchived', ({ sessionId }) => broker.sessionEnded(sessionId))
  lifecycle.on('sessionDeleted', ({ sessionId }) => broker.sessionEnded(sessionId))
  lifecycle.on('runSettled', ({ sessionId }) => broker.turnEnded(sessionId))
  lifecycle.on('hostStopping', () => broker.end('stopping'))

  /** The desktop app on this Mac: a device enrolled on host.sock, calling over host.sock. */
  function requireDesktop(caller: Caller): asserts caller is DeviceCaller {
    context.requireScope(caller, 'admin')
    if (caller.connection.listener !== 'unix' || caller.device.listener !== 'unix') throw localOnly()
  }

  return {
    async route({ req, res, caller, path, method }) {
      const tabs = TABS_PATH.exec(path)
      if (tabs && method === 'GET') {
        context.requireScope(caller, 'view')
        const sessionId = safeDecode(tabs[1]!)
        await deps.readSession(caller, sessionId)
        context.recheck(caller, 'view')
        json(res, {
          available: broker.available(),
          tabs: broker.tabsOf(sessionId).map(({ tabId, title, url, loading, control }) => ({ tabId, title, url, loading, control })),
        })
        return true
      }
      if (!path.startsWith('/link/api/browser-provider/')) return false
      requireDesktop(caller)
      const deviceId = caller.device.id
      if (path === '/link/api/browser-provider/nonce' && method === 'POST') {
        // The folder-add nonce: single use, 60 s, bound to this device; the signed body names its purpose.
        const grant = devices.folderGrant(deviceId, caller.credentialHash)
        json(res, { nonce: grant.nonce })
        return true
      }
      if (path === '/link/api/browser-provider/register' && method === 'POST') {
        const raw = await jsonBody(req)
        const parsed = registerSchema.safeParse(raw)
        const { signature, ...body } = parsed.success ? parsed.data : { signature: undefined, nonce: undefined }
        try {
          devices.verifyFolderGrant({ deviceId, nonce: body.nonce, bodyHash: sha256Hex(canonicalJson(body)), signature })
        } catch {
          throw new AppError(403, 'browser-provider-invalid', '浏览器提供者的登记没有通过桌面端校验')
        }
        if (!parsed.success) throw new AppError(403, 'browser-provider-invalid', '浏览器提供者的登记没有通过桌面端校验')
        context.recheck(caller, 'admin')
        json(res, { providerId: broker.register(deviceId) }, 201)
        return true
      }
      if (path === '/link/api/browser-provider/stream' && method === 'POST') {
        const { providerId } = providerSchema.parse(await jsonBody(req))
        context.recheck(caller, 'admin')
        const { credentialHash } = caller
        if (!broker.openStream(deviceId, providerId, res)) throw notProvider()
        // The stream ends with the credential it was opened with, as every event stream does.
        const watch = setInterval(() => {
          if (!credentialHash || !devices.streamAllowed(deviceId, credentialHash)) res.end()
        }, 15_000)
        watch.unref()
        res.once('close', () => clearInterval(watch))
        return true
      }
      if (path === '/link/api/browser-provider/tabs' && method === 'POST') {
        const { providerId, tabs: list } = tabsSchema.parse(await jsonBody(req, TABS_LIMIT))
        if (!broker.reportTabs(deviceId, providerId, list)) throw notProvider()
        json(res, { ok: true })
        return true
      }
      if (path === '/link/api/browser-provider/results' && method === 'POST') {
        const result = resultSchema.parse(await jsonBody(req, RESULT_LIMIT))
        json(res, { accepted: broker.settle(deviceId, result) })
        return true
      }
      const image = IMAGE_PATH.exec(path)
      if (image && method === 'PUT') {
        if (req.headers['content-type'] !== 'image/png') throw new AppError(415, 'content-type', '截图须为 PNG')
        const data = await bytes(req, IMAGE_LIMIT)
        json(res, { accepted: broker.putImage(deviceId, image[1]!, data) })
        return true
      }
      return false
    },
    features: caller => (caller.device?.scopes.includes('view') ? { browserTabs: true } : {}),
  }
}
