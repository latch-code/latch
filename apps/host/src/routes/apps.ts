import { createHash } from 'node:crypto'
import { z } from 'zod'
import type {
  AppCapabilities,
  AppDataEvent,
  AppLastReply,
  AppLookup,
  AppManifestEntry,
  AppSummary,
  HostFeatures,
  ModelRef,
  TaskDetail,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { withinApproved } from '../app-capabilities.ts'
import { DOCUMENT_BYTES, PLUGIN_BYTES, scopeKind, scopeSchema, keySchema, type AppDataStore, type DataOwner } from '../app-data.ts'
import type { AppDiagnostics } from '../app-diagnostics.ts'
import { json, jsonBody, KIB, safeDecode } from '../http-util.ts'
import { installIdOf, type PluginAssets } from '../plugin-assets.ts'
import { APP_REF, type PageOrigin } from '../session-meta.ts'
import type { DeviceCaller, RouteContext, RouteModule } from './registry.ts'

/** Starts and new input per page, per device, per minute; and diagnostics a device may report per minute. */
export const APP_STARTS_PER_MINUTE = 6
export const APP_DIAGNOSTICS_PER_MINUTE = 20
/** Document writes per page, per device, per minute. */
export const APP_WRITES_PER_MINUTE = 60
/** The longest reply text a page reads back. */
export const LAST_REPLY_BYTES = 64 * KIB
const MINUTE = 60_000

const hex = z.string().regex(/^[a-f0-9]{64}$/u)
export const viaSchema = z.strictObject({ app: z.string().regex(APP_REF), revision: hex })
const uuid = z.string().uuid()
const modelRef = z.strictObject({ providerId: z.string().min(1).max(64), model: z.string().trim().min(1).max(200) })
/** A page's start: no fork, worktree, Agent, files, attachments or options; the project's default permission mode. */
const startSchema = z.strictObject({
  via: viaSchema,
  requestId: uuid,
  prompt: z.string().trim().min(1).max(16_000),
  title: z.string().trim().min(1).max(120).optional(),
  workspaceId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/u)
    .optional(),
  harnessId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/u)
    .optional(),
  model: modelRef.optional(),
})
const promptSchema = z.strictObject({ via: viaSchema, requestId: uuid, prompt: z.string().trim().min(1).max(16_000) })
const writeSchema = z.strictObject({ via: viaSchema, requestId: uuid, ifVersion: z.number().int().min(0), value: z.unknown() })
const removeSchema = z.strictObject({ via: viaSchema, requestId: uuid, ifVersion: z.number().int().min(1) })
const leaseSchema = z.strictObject({ via: viaSchema })
const migrateSchema = z.strictObject({
  via: viaSchema,
  requestId: uuid,
  lease: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  fromGeneration: z.number().int().min(1),
  toVersion: z.number().int().min(1),
  documents: z.array(z.strictObject({ scope: scopeSchema, key: keySchema, value: z.unknown() })).max(2000),
})
const diagnosticSchema = z.strictObject({
  via: viaSchema,
  source: z.enum(['runtime', 'handshake', 'bridge']),
  code: z
    .string()
    .regex(/^[a-z0-9.-]{1,64}$/u)
    .optional(),
  message: z
    .string()
    .min(1)
    .max(8 * KIB),
})

export type AppCapability = keyof AppCapabilities
interface Gate {
  pluginId: string
  appId: string
  app: AppManifestEntry
  /** The applied code's data version. */
  codeVersion: number
  /** The plugin record this page belongs to: its data and its sessions are this record's alone. */
  data: DataOwner
}
export interface StartInput {
  requestId: string
  prompt: string
  workspaceId?: string
  harnessId?: string
  model?: ModelRef
}

export interface AppRouteDeps {
  assets: () => PluginAssets
  /** Whether the registry runs the plugin now. */
  pluginEnabled(id: string): boolean
  data: AppDataStore
  diagnostics: AppDiagnostics
  /**
   * Throws unless a page may use the session for this device: never a private one (judged from the Host's own records
   * before anything that can fail to find it), then the device's scope (`run` with `write`) and the session existing.
   */
  pageSession(caller: DeviceCaller, sessionId: string, write?: boolean): Promise<void>
  /** Sends `app.data` to the streams whose device may read that scope; `restricted`: only to devices with all data. */
  broadcast(event: Omit<AppDataEvent, 'type' | 'instanceId'>, restricted?: boolean): void
}

export interface AppRoutes extends RouteModule {
  /** `POST /tasks` with `via`: `start` is the Host's own `startSession` with the input the page may give. */
  start(caller: DeviceCaller, body: unknown, start: (input: StartInput) => Promise<{ sessionId: string }>): Promise<{ sessionId: string }>
  /** `POST /tasks/:id/prompt` with `via`, for a session this page started. */
  continueSession(
    caller: DeviceCaller,
    sessionId: string,
    body: unknown,
    send: (input: { requestId: string; prompt: string }) => Promise<void>,
  ): Promise<void>
  summaries(): Promise<AppSummary[]>
}

/**
 * A request ID of the page's, made into the one the driver keeps: another page's, another record's under the same plugin
 * ID, or a person's cannot collide with it.
 */
export function driverRequestId(app: string, install: string, requestId: string): string {
  const bytes = createHash('sha256')
    .update(canonicalJson(['app-start', app, install, requestId]))
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const text = bytes.toString('hex')
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`
}

class Window {
  private readonly hits = new Map<string, number[]>()
  constructor(
    private readonly limit: number,
    private readonly now: () => number,
  ) {}
  take(key: string): boolean {
    const since = this.now() - MINUTE
    const recent = (this.hits.get(key) ?? []).filter(at => at > since)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(this.now())
    this.hits.set(key, recent)
    if (this.hits.size > 10_000) for (const [name, list] of this.hits) if (!list.some(at => at > since)) this.hits.delete(name)
    return true
  }
}

function viaFromQuery(url: URL, pluginId: string, appId?: string): z.infer<typeof viaSchema> {
  const app = appId ? `${pluginId}/${appId}` : url.searchParams.get('app')
  const parsed = viaSchema.safeParse({ app, revision: url.searchParams.get('revision') })
  if (!parsed.success) throw new AppError(400, 'invalid-input', '缺少页面与版本。')
  return parsed.data
}

const requestUrl = (url: string | undefined) => new URL(url ?? '/', 'http://latch.invalid')
const key = (page: Gate, requestId: string) => `${page.pluginId}/${page.appId}\n${requestId}`

const ROOT = '/link/api/apps/'
const PLUGIN = '([A-Za-z0-9_-]{1,64})'
/** A page's built module: the hash in the path is the current one, or 404. */
const MODULE = new RegExp(`^/link/api/app-modules/${PLUGIN}/${PLUGIN}/([a-f0-9]{64})\\.js$`, 'u')
const DATA = new RegExp(`^/link/api/apps/${PLUGIN}/data(?:/([^/]+)(?:/([^/]+))?)?$`, 'u')
const DIAGNOSTICS = new RegExp(`^/link/api/apps/${PLUGIN}/diagnostics$`, 'u')
const PAGE = new RegExp(`^/link/api/apps/${PLUGIN}/pages/${PLUGIN}/(lookup|sessions)/([^/]+)(/last-reply)?$`, 'u')

/**
 * Plugin pages reach the Host through these routes and `via` on task starts and input. The Host trusts only its own
 * applied manifest: the plugin must be enabled, `via.revision` must be the applied revision, and the capability must be
 * declared and approved; then the device's own scope applies as for any other request.
 */
export function createAppRoutes(context: RouteContext, deps: AppRouteDeps): AppRoutes {
  const starts = new Window(APP_STARTS_PER_MINUTE, context.now)
  const reports = new Window(APP_DIAGNOSTICS_PER_MINUTE, context.now)
  const writes = new Window(APP_WRITES_PER_MINUTE, context.now)
  /** Starts on their way, by page and request ID, so a lookup can say `pending`. */
  const pending = new Map<string, number>()
  /** Built page modules by applied revision and page, with their hash; a new revision makes new entries. */
  const modules = new Map<string, { hash: string; bytes: Buffer } | null>()

  /**
   * A page's module: until the Host builds pages itself, an applied package's prebuilt `.js` entry is the module as it
   * is; a `.ts` or `.tsx` entry has no module yet.
   */
  function moduleOf(record: ReturnType<PluginAssets['get']>, appId: string): { hash: string; bytes: Buffer } | undefined {
    const revision = record.appliedRevision
    const bundle = record.appliedBundle
    if (!revision || !bundle) return undefined
    const name = `${revision}/${appId}`
    if (!modules.has(name)) {
      const app = bundle.manifest.apps?.find(item => item.id === appId)
      const file = app && /\.js$/iu.test(app.entry) ? bundle.files.find(item => item.path === app.entry) : undefined
      const bytes = file ? Buffer.from(file.content, 'utf8') : undefined
      if (modules.size >= 64) modules.clear()
      modules.set(name, bytes ? { bytes, hash: createHash('sha256').update(bytes).digest('hex') } : null)
    }
    return modules.get(name) ?? undefined
  }

  function refuse(pluginId: string, appId: string, deviceId: string, capability: string): never {
    // A refused call is a diagnostic, within the device's report budget so a page cannot fill the disk with them.
    if (reports.take(deviceId))
      void deps.diagnostics.record(pluginId, { appId, source: 'bridge', code: 'capability-denied', message: capability }).catch(() => {})
    throw new AppError(403, 'app-capability-denied', '这个页面没有这项能力。', { capability })
  }

  /** Every page call starts here. `capability` undefined: only the page itself must be current (diagnostics). */
  function gate(caller: DeviceCaller, via: z.infer<typeof viaSchema>, capability?: AppCapability, pluginInPath?: string): Gate {
    const [pluginId = '', appId = ''] = via.app.split('/')
    if (pluginInPath !== undefined && pluginInPath !== pluginId) throw new AppError(400, 'invalid-input', '页面与插件不一致。')
    const assets = deps.assets()
    if (!assets.has(pluginId)) throw new AppError(404, 'app-not-found', '找不到这个页面。')
    const record = assets.get(pluginId)
    const bundle = record.appliedBundle
    const app = bundle?.manifest.apps?.find(item => item.id === appId)
    if (!bundle || !app) throw new AppError(404, 'app-not-found', '找不到这个页面。')
    if (!record.enabled || !deps.pluginEnabled(pluginId)) throw new AppError(409, 'app-disabled', '这个插件已停用。')
    if (record.appliedRevision !== via.revision) throw new AppError(409, 'app-revision-stale', '页面版本已更新，请重新加载。')
    // The applied set must still be what this computer approved; a stored record never widens on its own.
    if (!withinApproved({ [appId]: app.capabilities }, record.approvedApps)) refuse(pluginId, appId, caller.device.id, 'approval')
    if (capability && !app.capabilities[capability]) refuse(pluginId, appId, caller.device.id, capability)
    return { pluginId, appId, app, codeVersion: app.dataVersion, data: { id: pluginId, owner: installIdOf(record) } }
  }

  /** A session this page started, under this plugin record. */
  function owned(page: Gate, sessionId: string): PageOrigin | undefined {
    const origin = context.hub.originOf(sessionId)
    return origin?.app === `${page.pluginId}/${page.appId}` && origin.install === page.data.owner ? origin : undefined
  }

  /** The storage scope must be declared, and the device must be able to read (or write) what the scope names. */
  async function scopeAccess(caller: DeviceCaller, page: Gate, scope: string, write: boolean): Promise<void> {
    if (!page.app.capabilities.storage?.includes(scopeKind(scope)))
      refuse(page.pluginId, page.appId, caller.device.id, `storage:${scopeKind(scope)}`)
    if (scopeKind(scope) === 'session') await deps.pageSession(caller, scope.slice('session:'.length), write)
    context.recheck(caller, write ? 'run' : 'view')
  }

  context.lifecycle.on('sessionDeleted', async ({ sessionId }) => {
    try {
      // The session is gone, and with it the record of whether it was private: only devices with all data hear of it.
      for (const change of await deps.data.removeSession(sessionId))
        for (const item of change.documents)
          deps.broadcast({ pluginId: change.pluginId, scope: item.scope, key: item.key, version: 0 }, true)
    } catch {
      context.log('未能清理已删除会话的插件数据')
    }
  })

  return {
    features: () => ({ appPages: 1 }) satisfies HostFeatures,

    async start(caller, body, start) {
      context.requireScope(caller, 'run')
      const input = startSchema.parse(body)
      const page = gate(caller, input.via, 'tasks.start')
      const allowed = page.app.capabilities['tasks.start']!.projects
      const project = input.workspaceId ?? 'default'
      if (allowed !== 'any' && !allowed.includes(project)) refuse(page.pluginId, page.appId, caller.device.id, 'tasks.start:project')
      const app = input.via.app
      const existing = context.hub.findOrigin(app, input.requestId, page.data.owner)
      if (existing) {
        await deps.pageSession(caller, existing)
        return { sessionId: existing }
      }
      if (!starts.take(`start\n${app}\n${caller.device.id}`))
        throw new AppError(429, 'app-rate-limited', '这个页面开始会话太频繁，请稍后再试。', { retryAfter: 60 })
      const marker = key(page, input.requestId)
      pending.set(marker, (pending.get(marker) ?? 0) + 1)
      try {
        // The page and its request are on record before anything starts; the start's own audits follow as usual.
        await context.audited({
          action: 'app.task.start',
          actor: context.actorOf(caller),
          detail: {
            pluginId: page.pluginId,
            appId: page.appId,
            revision: input.via.revision,
            requestHash: sha256Hex(canonicalJson([app, input.requestId])),
            workspaceId: project,
            ...(input.harnessId ? { harnessId: input.harnessId } : {}),
          },
        })
        context.recheck(caller, 'run')
        const created = await start({
          requestId: driverRequestId(app, page.data.owner, input.requestId),
          prompt: input.prompt,
          workspaceId: project,
          ...(input.harnessId ? { harnessId: input.harnessId } : {}),
          ...(input.model ? { model: input.model } : {}),
        })
        // Another device replaying this request ID gets the session only if it may read it.
        await deps.pageSession(caller, created.sessionId)
        try {
          // The baseline is what the start asked for: the Harness's level and its default mode, never a mode read back
          // after the start, which a person may already have changed. A change made before this record still counts.
          const { level } = permissionOf(await context.hub.detail(created.sessionId))
          await context.hub.recordOrigin(
            created.sessionId,
            { app, requestId: input.requestId, install: page.data.owner, level },
            input.title,
          )
        } catch (cause) {
          if (cause instanceof AppError && cause.status === 409) throw cause
          throw new AppError(503, 'app-origin-unknown', '会话已开始，来源记录尚未确认。请用同一个请求重试。')
        }
        return created
      } finally {
        const left = (pending.get(marker) ?? 1) - 1
        if (left > 0) pending.set(marker, left)
        else pending.delete(marker)
      }
    },

    async continueSession(caller, sessionId, body, send) {
      context.requireScope(caller, 'run')
      const input = promptSchema.parse(body)
      const page = gate(caller, input.via, 'tasks.continue')
      const origin = owned(page, sessionId)
      if (!origin) refuse(page.pluginId, page.appId, caller.device.id, 'tasks.continue:session')
      await deps.pageSession(caller, sessionId, true)
      // A person who changed the session's permissions took it over; new page code cannot drive what they widened.
      const now = permissionOf(await context.hub.detail(sessionId))
      if (origin.changed || now.level !== origin.level || (now.mode !== undefined && now.mode !== now.defaultMode))
        throw new AppError(409, 'app-session-changed', '这个会话的权限已被人改过，页面不能再继续它。')
      if (!starts.take(`continue\n${input.via.app}\n${caller.device.id}`))
        throw new AppError(429, 'app-rate-limited', '这个页面发送太频繁，请稍后再试。', { retryAfter: 60 })
      await send({ requestId: input.requestId, prompt: input.prompt })
    },

    async summaries() {
      const assets = deps.assets()
      const out: AppSummary[] = []
      for (const record of assets.list()) {
        const bundle = record.appliedBundle
        if (!bundle?.manifest.apps?.length || !record.appliedRevision) continue
        const enabled = record.enabled && deps.pluginEnabled(record.id)
        const codeVersion = bundle.manifest.apps[0]!.dataVersion
        const owner = { id: record.id, owner: installIdOf(record) }
        const status = !enabled
          ? 'disabled'
          : (await deps.data.claim(owner).catch(() => undefined)) === 'other'
            ? 'ready'
            : (await deps.data.status(owner, codeVersion).catch(() => undefined))?.status
        if (!status) continue
        for (const app of bundle.manifest.apps) {
          const built = moduleOf(record, app.id)
          out.push({
            pluginId: record.id,
            appId: app.id,
            title: app.title,
            ...(app.icon ? { icon: app.icon } : {}),
            pluginName: bundle.manifest.name,
            version: bundle.manifest.version,
            revision: record.appliedRevision,
            capabilities: structuredClone(app.capabilities),
            dataVersion: app.dataVersion,
            status,
            ...(built ? { bundleHash: built.hash } : {}),
          })
        }
      }
      return out
    },

    async route({ req, res, caller, path, method }) {
      const moduleMatch = MODULE.exec(path)
      if (moduleMatch) {
        context.requireScope(caller, 'view')
        if (method !== 'GET' && method !== 'HEAD') throw new AppError(404, 'not-found', '接口不存在。')
        // Only the shell's own fetch takes the bytes; a script, frame or navigation never runs them on its origin.
        const dest = req.headers['sec-fetch-dest']
        if (dest !== undefined && dest !== 'empty') throw new AppError(403, 'app-module-refused', '页面代码只交给页面框。')
        const [, pluginId, appId, hash] = moduleMatch as unknown as [string, string, string, string]
        const assets = deps.assets()
        const revision = assets.has(pluginId) ? assets.get(pluginId).appliedRevision : undefined
        if (!revision) throw new AppError(404, 'app-not-found', '找不到这个页面。')
        // The same checks as any page call, at the applied revision: enabled, the page exists, approval still holds.
        gate(caller, { app: `${pluginId}/${appId}`, revision }, undefined, pluginId)
        const built = moduleOf(assets.get(pluginId), appId)
        if (!built || built.hash !== hash) throw new AppError(404, 'app-module-not-found', '这个页面版本已不可用，请重新加载。')
        context.recheck(caller, 'view')
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-content-type-options': 'nosniff',
          'content-length': String(built.bytes.length),
          'cache-control': 'no-store',
        })
        res.end(method === 'HEAD' ? undefined : built.bytes)
        return true
      }
      if (!path.startsWith(ROOT)) return false
      context.requireScope(caller, 'view')
      const url = requestUrl(req.url)
      const pageMatch = PAGE.exec(path)
      if (pageMatch) {
        const [, pluginId, appId, kind, id, lastReply] = pageMatch as unknown as [string, string, string, string, string, string?]
        if (method !== 'GET') throw new AppError(404, 'not-found', '接口不存在。')
        const target = safeDecode(id)
        if (kind === 'lookup' && !lastReply) {
          if (!uuid.safeParse(target).success) throw new AppError(400, 'invalid-input', '请求标识无效。')
          const page = gate(caller, viaFromQuery(url, pluginId, appId), 'tasks.start')
          const found = context.hub.findOrigin(`${pluginId}/${appId}`, target, page.data.owner)
          let answer: AppLookup
          if (found) {
            await deps.pageSession(caller, found)
            answer = { status: 'found', sessionId: found }
          } else answer = pending.has(key(page, target)) ? { status: 'pending' } : { status: 'not-found' }
          context.recheck(caller, 'view')
          json(res, answer)
          return true
        }
        if (kind === 'sessions' && lastReply) {
          const page = gate(caller, viaFromQuery(url, pluginId, appId), 'tasks.readOwn')
          if (target.length > 256 || !owned(page, target)) refuse(pluginId, appId, caller.device.id, 'tasks.readOwn:session')
          await deps.pageSession(caller, target)
          const detail = await context.hub.detail(target)
          context.recheck(caller, 'view')
          json(res, lastReplyOf(detail))
          return true
        }
        throw new AppError(404, 'not-found', '接口不存在。')
      }
      const diagnostics = DIAGNOSTICS.exec(path)
      if (diagnostics) {
        const pluginId = diagnostics[1]!
        if (method === 'GET') {
          const page = gate(caller, viaFromQuery(url, pluginId), undefined, pluginId)
          json(res, { diagnostics: await deps.diagnostics.list(pluginId, page.appId) })
          return true
        }
        if (method === 'POST') {
          const input = diagnosticSchema.parse(await jsonBody(req, 16 * KIB))
          const page = gate(caller, input.via, undefined, pluginId)
          if (!reports.take(caller.device.id))
            throw new AppError(429, 'app-rate-limited', '诊断上报太频繁，请稍后再试。', { retryAfter: 60 })
          const entry = await deps.diagnostics.record(pluginId, {
            appId: page.appId,
            source: input.source,
            ...(input.code ? { code: input.code } : {}),
            message: input.message,
          })
          json(res, { diagnostic: entry }, 201)
          return true
        }
        throw new AppError(404, 'not-found', '接口不存在。')
      }
      const data = DATA.exec(path)
      if (!data) throw new AppError(404, 'not-found', '接口不存在。')
      const pluginId = data[1]!
      const first = data[2] === undefined ? undefined : safeDecode(data[2])
      const second = data[3] === undefined ? undefined : safeDecode(data[3])
      if (first === undefined && method === 'GET') {
        const page = gate(caller, viaFromQuery(url, pluginId), 'storage', pluginId)
        const scope = scopeSchema.safeParse(url.searchParams.get('scope'))
        if (!scope.success) throw new AppError(400, 'invalid-input', '请指定数据作用域。')
        await scopeAccess(caller, page, scope.data, false)
        json(res, { documents: await deps.data.list(page.data, page.codeVersion, scope.data) })
        return true
      }
      if (first === 'status' && second === undefined && method === 'GET') {
        const page = gate(caller, viaFromQuery(url, pluginId), 'storage', pluginId)
        json(res, await deps.data.status(page.data, page.codeVersion))
        return true
      }
      if (first === 'migrate' && method === 'POST') {
        context.requireScope(caller, 'run')
        if (second === 'lease') {
          const input = leaseSchema.parse(await jsonBody(req))
          const page = gate(caller, input.via, 'storage', pluginId)
          // Only the scopes this page declares, and only sessions a page may use from this device, leave the Host; any
          // session that cannot be judged readable counts as unreadable. The rest is carried forward unchanged.
          const usable = new Set<string>()
          for (const sessionId of await deps.data.sessionScopes(page.data, page.codeVersion))
            if (
              await deps.pageSession(caller, sessionId, true).then(
                () => true,
                () => false,
              )
            )
              usable.add(sessionId)
          context.recheck(caller, 'run')
          const declared = page.app.capabilities.storage!
          json(
            res,
            await deps.data.lease(page.data, page.codeVersion, caller.device.id, scope => {
              const kind = scopeKind(scope)
              return declared.includes(kind) && (kind !== 'session' || usable.has(scope.slice('session:'.length)))
            }),
          )
          return true
        }
        if (second !== undefined) throw new AppError(404, 'not-found', '接口不存在。')
        const input = migrateSchema.parse(await jsonBody(req, PLUGIN_BYTES + PLUGIN_BYTES / 4 + 1024 * KIB))
        const page = gate(caller, input.via, 'storage', pluginId)
        for (const item of input.documents)
          if (!page.app.capabilities.storage!.includes(scopeKind(item.scope)))
            refuse(pluginId, page.appId, caller.device.id, `storage:${scopeKind(item.scope)}`)
        for (const named of new Set(input.documents.map(item => item.scope).filter(item => scopeKind(item) === 'session')))
          await deps.pageSession(caller, named.slice('session:'.length), true)
        context.recheck(caller, 'run')
        const result = await deps.data.migrate(page.data, page.codeVersion, caller.device.id, input, async change => {
          await context.audited({
            action: 'app.data.migrate',
            actor: context.actorOf(caller),
            detail: { pluginId, ...change, toVersion: input.toVersion },
          })
        })
        if (!result.replay)
          void deps.diagnostics
            .record(pluginId, {
              appId: page.appId,
              source: 'migration',
              message: `数据已更新到版本 ${input.toVersion}（第 ${result.generation} 代）`,
            })
            .catch(() => {})
        context.refresh()
        json(res, result)
        return true
      }
      if (first === undefined || second === undefined || first === 'status' || first === 'migrate')
        throw new AppError(404, 'not-found', '接口不存在。')
      const scope = scopeSchema.safeParse(first)
      const docKey = keySchema.safeParse(second)
      if (!scope.success || !docKey.success) throw new AppError(400, 'invalid-input', '数据作用域或键无效。')
      if (method === 'GET') {
        const page = gate(caller, viaFromQuery(url, pluginId), 'storage', pluginId)
        await scopeAccess(caller, page, scope.data, false)
        const document = await deps.data.get(page.data, page.codeVersion, scope.data, docKey.data)
        if (!document) throw new AppError(404, 'app-data-not-found', '找不到这个文档。')
        json(res, { document })
        return true
      }
      if (method === 'PUT' || method === 'DELETE') {
        context.requireScope(caller, 'run')
        const body = await jsonBody(req, DOCUMENT_BYTES + 64 * KIB)
        const input = method === 'PUT' ? writeSchema.parse(body) : removeSchema.parse(body)
        const page = gate(caller, input.via, 'storage', pluginId)
        await scopeAccess(caller, page, scope.data, true)
        if (!writes.take(`${input.via.app}\n${caller.device.id}`))
          throw new AppError(429, 'app-rate-limited', '这个页面保存太频繁，请稍后再试。', { retryAfter: 60 })
        const result =
          method === 'PUT'
            ? await deps.data.put(page.data, page.codeVersion, caller.device.id, {
                scope: scope.data,
                key: docKey.data,
                requestId: input.requestId,
                ifVersion: input.ifVersion,
                value: (input as z.infer<typeof writeSchema>).value,
              })
            : await deps.data.remove(page.data, page.codeVersion, caller.device.id, {
                scope: scope.data,
                key: docKey.data,
                requestId: input.requestId,
                ifVersion: input.ifVersion,
              })
        if (!result.replay) deps.broadcast({ pluginId, scope: scope.data, key: docKey.data, version: result.version })
        json(res, result)
        return true
      }
      throw new AppError(404, 'not-found', '接口不存在。')
    },
  }
}

/** The permission a session runs with, as a page start records it and a page's input compares it. */
export function permissionOf(detail: TaskDetail): { level: 'L1' | 'L3'; mode?: string; defaultMode?: string } {
  return {
    level: detail.permission?.level ?? detail.summary.level ?? 'L1',
    ...(detail.permission?.expectedMode !== undefined ? { mode: detail.permission.expectedMode } : {}),
    ...(detail.permission?.defaultMode !== undefined ? { defaultMode: detail.permission.defaultMode } : {}),
  }
}

/** The last reply of a session as plain text, at most 64 KiB, with its end state. */
function lastReplyOf(detail: Awaited<ReturnType<RouteContext['hub']['detail']>>): AppLastReply {
  const reply = detail.messages.findLast(message => message.role === 'assistant' && message.text.trim())
  let text = reply?.text ?? ''
  let truncated = false
  if (Buffer.byteLength(text) > LAST_REPLY_BYTES) {
    truncated = true
    text = Buffer.from(text).subarray(0, LAST_REPLY_BYTES).toString('utf8').replace(/�+$/u, '')
  }
  return {
    sessionId: detail.summary.id,
    status: detail.summary.status,
    ...(detail.summary.runOutcome ? { runOutcome: detail.summary.runOutcome } : {}),
    ...(reply ? { reply: { messageId: reply.id, text, ...(truncated ? { truncated: true as const } : {}) } } : {}),
  }
}
