import {
  APP_VIEW_STATE_BYTES,
  appScopeKind,
  type AppErrorCode,
  type AppFrameMessage,
  type AppHostInfo,
  type AppLastReply,
  type AppLookup,
  type AppShellMessage,
  type AppSnapshot,
  type AppStorageDocument,
  type AppSummary,
  type AppTask,
  type AppTaskFilter,
} from '@latch/protocol'
import type { ApiError, ApiOptions } from '../core/api.ts'
import { appRef, appTasks, bridgeCode, capabilityAllows, sessionWaits, storageDocument, taskFilter } from './model.ts'

/** Mirrors of the Host's limits per page and device per minute, only so a page hears no sooner than it would anyway. */
export const BRIDGE_LIMITS = { starts: 6, writes: 60, reports: 20 } as const
const MINUTE = 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,256}$/u
const DOCUMENT_BYTES = 256 * 1024

export interface ParentBridgeDeps {
  page: AppSummary
  snapshot: () => AppSnapshot
  /** Whether the shell is in touch with the Host now. */
  online: () => boolean
  info: () => AppHostInfo
  api: <T>(path: string, options?: ApiOptions) => Promise<T>
  send: (message: AppShellMessage) => void
  openSession: (sessionId: string) => void
  setView: (state: unknown) => void
  now?: () => number
  /** The shell shows a security surface, dialog or toast over or beside the frame. */
  covered?: () => boolean
  /** The person has just used the page (the parent's transient user activation). */
  activated?: () => boolean
}

export interface ParentBridge {
  /** One `call` from the frame; every other message is the frame host's. */
  call(message: Extract<AppFrameMessage, { t: 'call' }>): void
  /** The snapshot or the connection changed: subscriptions hear of it. */
  update(): void
  /** SSE `app.data` for this plugin. */
  dataChanged(change: { pluginId: string; scope: string; key: string; version: number }): void
  hostChanged(): void
  /** The frame is gone (unmount, disable, update): nothing more is sent, nothing more is asked. */
  dispose(): void
}

class Refusal extends Error {
  constructor(
    readonly code: AppErrorCode,
    readonly extra: { requestId?: string; version?: number } = {},
  ) {
    super(code)
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const keysWithin = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key))
const optionalText = (value: unknown, max: number) =>
  value === undefined || (typeof value === 'string' && value.trim().length > 0 && value.length <= max)
const jsonBytes = (value: unknown) => {
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? null)).length
  } catch {
    return Infinity
  }
}

/**
 * The shell's half of the page bridge. Every call is checked here first (its shape, the manifest's capability, that the
 * page is still mounted), then asked of the Host with this device's own credentials and `via`; the answer goes back
 * with only whitelisted fields, a failure as one of seven codes. The session list comes from the snapshot the shell has
 * already synced: offline is announced once, and the full list is sent again once the shell is back.
 */
export function createParentBridge(deps: ParentBridgeDeps): ParentBridge {
  const { page } = deps
  const now = deps.now ?? Date.now
  const via = { app: appRef(page), revision: page.revision }
  const query = `app=${encodeURIComponent(via.app)}&revision=${page.revision}`
  const pageBase = `apps/${encodeURIComponent(page.pluginId)}/pages/${encodeURIComponent(page.appId)}`
  const dataBase = `apps/${encodeURIComponent(page.pluginId)}/data`
  let disposed = false
  let watching = false
  let nextSubscription = 0
  const subscriptions = new Map<number, { filter: AppTaskFilter; last: string; offline: boolean }>()
  const hits = new Map<string, number[]>()

  const take = (name: keyof typeof BRIDGE_LIMITS) => {
    const since = now() - MINUTE
    const recent = (hits.get(name) ?? []).filter(at => at > since)
    const allowed = recent.length < BRIDGE_LIMITS[name]
    if (allowed) recent.push(now())
    hits.set(name, recent)
    return allowed
  }
  const send = (message: AppShellMessage) => {
    if (!disposed) deps.send(message)
  }
  const canRun = () => deps.snapshot().device.scopes?.includes('run') === true
  const needRun = () => {
    if (!canRun()) throw new Refusal('forbidden')
  }
  const needOnline = () => {
    if (!deps.online()) throw new Refusal('offline')
  }
  const ask = async <T>(path: string, options: ApiOptions = {}, requestId?: string): Promise<T> => {
    try {
      return await deps.api<T>(path, options)
    } catch (cause) {
      const code = bridgeCode(cause)
      const version = ((cause as ApiError | undefined)?.details as { version?: unknown } | undefined)?.version
      throw new Refusal(code, {
        ...(code === 'unknown' && requestId ? { requestId } : {}),
        ...((cause as ApiError | undefined)?.code === 'app-data-conflict' && Number.isSafeInteger(version)
          ? { version: version as number }
          : {}),
      })
    }
  }
  const tasksFor = (filter: AppTaskFilter): AppTask[] => appTasks(deps.snapshot(), filter, page)
  /** Why the shell refused, in the page's diagnostics (the page itself gets only the code). */
  const report = (message: string) => {
    if (deps.online() && take('reports'))
      void deps
        .api(`apps/${encodeURIComponent(page.pluginId)}/diagnostics`, { method: 'POST', body: { via, source: 'bridge', message } })
        .catch(() => {})
  }

  const publish = (id: number, force = false) => {
    const subscription = subscriptions.get(id)
    if (!subscription) return
    const online = deps.online()
    if (!online) {
      // Offline is said once; the list it carries is the last one the page was sent.
      if (subscription.offline) return
      subscription.offline = true
      send({ t: 'event', name: 'tasks', subscription: id, offline: true, tasks: JSON.parse(subscription.last || '[]') as AppTask[] })
      return
    }
    const tasks = tasksFor(subscription.filter)
    const text = JSON.stringify(tasks)
    if (!force && !subscription.offline && text === subscription.last) return
    // Back from offline: one full list, never a patch across the gap.
    subscription.offline = false
    subscription.last = text
    send({ t: 'event', name: 'tasks', subscription: id, offline: false, tasks })
  }

  async function run(method: Extract<AppFrameMessage, { t: 'call' }>['method'], params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'tasks.list': {
        if (!keysWithin(params, ['filter'])) throw new Refusal('invalid-input')
        const filter = taskFilter(params.filter ?? {})
        if (!filter) throw new Refusal('invalid-input')
        needOnline()
        return tasksFor(filter)
      }
      case 'tasks.subscribe': {
        if (!keysWithin(params, ['filter'])) throw new Refusal('invalid-input')
        const filter = taskFilter(params.filter ?? {})
        if (!filter || subscriptions.size >= 16) throw new Refusal('invalid-input')
        const id = ++nextSubscription
        subscriptions.set(id, { filter, last: '', offline: false })
        // The first list goes out right after the reply that names the subscription (see `call`).
        return { subscription: id }
      }
      case 'tasks.unsubscribe': {
        if (!keysWithin(params, ['subscription']) || !Number.isSafeInteger(params.subscription)) throw new Refusal('invalid-input')
        subscriptions.delete(params.subscription as number)
        return {}
      }
      case 'tasks.start': {
        if (
          !keysWithin(params, ['requestId', 'prompt', 'title', 'projectId', 'harnessId'])
          || typeof params.requestId !== 'string'
          || !UUID.test(params.requestId)
          || typeof params.prompt !== 'string'
          || !params.prompt.trim()
          || params.prompt.length > 16_000
          || !optionalText(params.title, 120)
          || (params.projectId !== undefined && (typeof params.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(params.projectId)))
          || (params.harnessId !== undefined && (typeof params.harnessId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(params.harnessId)))
        )
          throw new Refusal('invalid-input')
        needRun()
        needOnline()
        if (!take('starts')) throw new Refusal('rate-limited')
        const result = await ask<{ sessionId: string }>(
          'tasks',
          {
            method: 'POST',
            timeoutMs: 30_000,
            body: {
              via,
              requestId: params.requestId,
              prompt: params.prompt,
              ...(params.title !== undefined ? { title: params.title } : {}),
              ...(params.projectId !== undefined ? { workspaceId: params.projectId } : {}),
              ...(params.harnessId !== undefined ? { harnessId: params.harnessId } : {}),
            },
          },
          params.requestId,
        )
        return { sessionId: String(result.sessionId) }
      }
      case 'tasks.lookup': {
        if (!keysWithin(params, ['requestId']) || typeof params.requestId !== 'string' || !UUID.test(params.requestId))
          throw new Refusal('invalid-input')
        needOnline()
        const found = await ask<AppLookup>(`${pageBase}/lookup/${params.requestId}?revision=${page.revision}`)
        return found.status === 'found'
          ? { status: 'found', sessionId: String(found.sessionId) }
          : { status: found.status === 'pending' ? 'pending' : 'not-found' }
      }
      case 'tasks.continue': {
        if (
          !keysWithin(params, ['sessionId', 'requestId', 'prompt'])
          || typeof params.sessionId !== 'string'
          || !SESSION_ID.test(params.sessionId)
          || typeof params.requestId !== 'string'
          || !UUID.test(params.requestId)
          || typeof params.prompt !== 'string'
          || !params.prompt.trim()
          || params.prompt.length > 16_000
        )
          throw new Refusal('invalid-input')
        needRun()
        needOnline()
        if (!take('starts')) throw new Refusal('rate-limited')
        await ask(
          `tasks/${encodeURIComponent(params.sessionId)}/prompt`,
          { method: 'POST', timeoutMs: 30_000, body: { via, requestId: params.requestId, prompt: params.prompt } },
          params.requestId,
        )
        return {}
      }
      case 'tasks.readReply': {
        if (!keysWithin(params, ['sessionId']) || typeof params.sessionId !== 'string' || !SESSION_ID.test(params.sessionId))
          throw new Refusal('invalid-input')
        needOnline()
        const reply = await ask<AppLastReply>(
          `${pageBase}/sessions/${encodeURIComponent(params.sessionId)}/last-reply?revision=${page.revision}`,
        )
        return {
          sessionId: String(reply.sessionId),
          status: String(reply.status),
          ...(reply.runOutcome ? { runOutcome: String(reply.runOutcome) } : {}),
          ...(reply.reply
            ? {
                reply: {
                  messageId: String(reply.reply.messageId),
                  text: String(reply.reply.text),
                  ...(reply.reply.truncated ? { truncated: true } : {}),
                },
              }
            : {}),
        }
      }
      case 'storage.get': {
        const { scope, key } = documentRef(params, ['scope', 'key'])
        needOnline()
        try {
          const found = await deps.api<{ document: AppStorageDocument }>(
            `${dataBase}/${encodeURIComponent(scope)}/${encodeURIComponent(key)}?${query}`,
          )
          return { document: storageDocument(found.document) }
        } catch (cause) {
          if ((cause as ApiError | undefined)?.code === 'app-data-not-found') return {}
          throw new Refusal(bridgeCode(cause))
        }
      }
      case 'storage.list': {
        if (!keysWithin(params, ['scope']) || typeof params.scope !== 'string' || !appScopeKind(params.scope))
          throw new Refusal('invalid-input')
        needOnline()
        const found = await ask<{ documents: AppStorageDocument[] }>(`${dataBase}?scope=${encodeURIComponent(params.scope)}&${query}`)
        return { documents: found.documents.map(storageDocument) }
      }
      case 'storage.put': {
        const { scope, key } = documentRef(params, ['scope', 'key', 'value', 'ifVersion', 'requestId'])
        if (!Number.isSafeInteger(params.ifVersion) || (params.ifVersion as number) < 0 || jsonBytes(params.value) > DOCUMENT_BYTES)
          throw new Refusal('invalid-input')
        const requestId = writeRequest(params)
        needRun()
        needOnline()
        if (!take('writes')) throw new Refusal('rate-limited')
        const result = await ask<{ version: number }>(
          `${dataBase}/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`,
          { method: 'PUT', body: { via, requestId, ifVersion: params.ifVersion, value: params.value ?? null } },
          requestId,
        )
        return { version: Number(result.version) }
      }
      case 'storage.delete': {
        const { scope, key } = documentRef(params, ['scope', 'key', 'ifVersion', 'requestId'])
        if (!Number.isSafeInteger(params.ifVersion) || (params.ifVersion as number) < 1) throw new Refusal('invalid-input')
        const requestId = writeRequest(params)
        needRun()
        needOnline()
        if (!take('writes')) throw new Refusal('rate-limited')
        await ask(
          `${dataBase}/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`,
          { method: 'DELETE', body: { via, requestId, ifVersion: params.ifVersion } },
          requestId,
        )
        return {}
      }
      case 'storage.watch':
        watching = true
        return {}
      case 'view.setState': {
        // JSON values only, measured as JSON: what the tab keeps is bounded whatever the frame sent.
        if (!keysWithin(params, ['state']) || jsonBytes(params.state) > APP_VIEW_STATE_BYTES) throw new Refusal('invalid-input')
        deps.setView(JSON.parse(JSON.stringify(params.state ?? null)) as unknown)
        return {}
      }
      case 'nav.openSession': {
        if (!keysWithin(params, ['sessionId']) || typeof params.sessionId !== 'string') throw new Refusal('invalid-input')
        const sessionId = params.sessionId
        // Taking the person to a session is theirs to start: never while the shell covers the frame, never without a
        // gesture just made. Its approval cards arm again once they are shown (useArmed).
        if (deps.covered?.() === true || deps.activated?.() === false) throw new Refusal('forbidden')
        if (!deps.snapshot().tasks.some(task => task.id === sessionId)) throw new Refusal('not-found')
        if (sessionWaits(deps.snapshot(), sessionId)) {
          report('等你处理的会话请从列表打开')
          throw new Refusal('forbidden')
        }
        deps.openSession(sessionId)
        return {}
      }
      case 'diag.report': {
        if (!keysWithin(params, ['message']) || typeof params.message !== 'string' || !params.message) throw new Refusal('invalid-input')
        if (!take('reports')) throw new Refusal('rate-limited')
        if (deps.online())
          void deps
            .api(`apps/${encodeURIComponent(page.pluginId)}/diagnostics`, {
              method: 'POST',
              body: { via, source: 'bridge', message: params.message.slice(0, 2000) },
            })
            .catch(() => {})
        return {}
      }
    }
  }

  return {
    call(message) {
      if (disposed) return
      const params = record(message.params)
      const reply = (outcome: { ok: true; value: unknown } | { ok: false; code: AppErrorCode; requestId?: string; version?: number }) => {
        send({ t: 'result', id: message.id, ...outcome } as AppShellMessage)
      }
      if (!params) {
        reply({ ok: false, code: 'invalid-input' })
        return
      }
      if (!capabilityAllows(page.capabilities, message.method, params.scope)) {
        reply({ ok: false, code: 'capability-denied' })
        return
      }
      run(message.method, params).then(
        value => {
          reply({ ok: true, value })
          if (message.method === 'tasks.subscribe') publish((value as { subscription: number }).subscription, true)
        },
        (cause: unknown) => {
          reply(cause instanceof Refusal ? { ok: false, code: cause.code, ...cause.extra } : { ok: false, code: 'unknown' })
        },
      )
    },
    update() {
      if (disposed) return
      for (const id of subscriptions.keys()) publish(id)
    },
    dataChanged(change) {
      if (disposed || !watching || change.pluginId !== page.pluginId) return
      const kind = appScopeKind(change.scope)
      if (!kind || !page.capabilities.storage?.includes(kind)) return
      send({ t: 'event', name: 'storage', scope: change.scope, key: change.key, version: change.version })
    },
    hostChanged() {
      send({ t: 'event', name: 'host', info: deps.info() })
    },
    dispose() {
      disposed = true
      subscriptions.clear()
      watching = false
    },
  }
}

function documentRef(params: Record<string, unknown>, keys: readonly string[]): { scope: string; key: string } {
  if (
    !keysWithin(params, keys)
    || typeof params.scope !== 'string'
    || !appScopeKind(params.scope)
    || typeof params.key !== 'string'
    || !params.key
    || params.key.length > 256
    || /[\u0000-\u001f\u007f]/u.test(params.key)
  )
    throw new Refusal('invalid-input')
  return { scope: params.scope, key: params.key }
}

function writeRequest(params: Record<string, unknown>): string {
  if (typeof params.requestId !== 'string' || !UUID.test(params.requestId)) throw new Refusal('invalid-input')
  return params.requestId
}
