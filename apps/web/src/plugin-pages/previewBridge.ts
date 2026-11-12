import {
  APP_VIEW_STATE_BYTES,
  appScopeKind,
  type AppCapabilities,
  type AppErrorCode,
  type AppFrameMessage,
  type AppHostInfo,
  type AppPreviewTask,
  type AppShellMessage,
  type AppStorageDocument,
  type AppTask,
} from '@latch/protocol'
import { capabilityAllows, taskFilter } from './model.ts'
import type { ParentBridge } from './parentBridge.ts'

/** The sessions a preview lists when its manifest gives none. */
export const PREVIEW_TASKS: readonly AppPreviewTask[] = [
  { title: '整理发布说明', status: 'idle', projectName: '示例项目' },
  { title: '修复登录页的报错', status: 'running', projectName: '示例项目' },
  { title: '检查依赖更新', status: 'waiting-approval', projectName: '另一个项目' },
]

export interface PreviewBridgeDeps {
  page: { pluginId: string; appId: string; capabilities: AppCapabilities }
  /** The manifest's `preview.tasks`, else the fixed samples. */
  tasks?: readonly AppPreviewTask[]
  info: () => AppHostInfo
  send: (message: AppShellMessage) => void
  setView: (state: unknown) => void
  /** The page tried something the preview does not do (start or continue a session, open one). */
  onPreviewOnly: () => void
  now?: () => number
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const jsonBytes = (value: unknown) => {
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? null)).length
  } catch {
    return Infinity
  }
}

class Refusal extends Error {
  constructor(
    readonly code: AppErrorCode,
    readonly version?: number,
  ) {
    super(code)
  }
}

/**
 * The bridge of a draft's preview: the same frame and the same bundle, but nothing here reaches the Host. The session
 * list is samples, starting or continuing a session answers `preview`, storage lives in this object's memory and goes
 * when the preview closes. The checks of the manifest's capabilities are the same as the real bridge's.
 */
export function createPreviewBridge(deps: PreviewBridgeDeps): ParentBridge {
  const now = deps.now ?? Date.now
  const at = new Date(now()).toISOString()
  const samples: AppTask[] = (deps.tasks?.length ? deps.tasks : PREVIEW_TASKS).map((task, index) => ({
    id: `preview-${index + 1}`,
    title: task.title,
    status: task.status ?? 'idle',
    running: task.status === 'running' || task.status === 'waiting-approval',
    ...(task.projectName ? { projectId: `preview-project-${index + 1}`, projectName: task.projectName } : {}),
    harnessId: 'preview',
    updatedAt: at,
  }))
  const documents = new Map<string, AppStorageDocument>()
  const keyOf = (scope: string, key: string) => `${scope}\n${key}`
  let disposed = false
  let watching = false
  let nextSubscription = 0
  const send = (message: AppShellMessage) => {
    if (!disposed) deps.send(message)
  }
  const documentRef = (params: Record<string, unknown>) => {
    if (
      typeof params.scope !== 'string'
      || !appScopeKind(params.scope)
      || typeof params.key !== 'string'
      || !params.key
      || params.key.length > 256
    )
      throw new Refusal('invalid-input')
    return { scope: params.scope, key: params.key }
  }
  const tasksFor = (filter: { projectId?: string; mine?: boolean; limit?: number }) =>
    samples
      .filter(task => filter.projectId === undefined || task.projectId === filter.projectId)
      .filter(() => !filter.mine)
      .slice(0, filter.limit ?? 50)

  function run(method: Extract<AppFrameMessage, { t: 'call' }>['method'], params: Record<string, unknown>): unknown {
    switch (method) {
      case 'tasks.list': {
        const filter = taskFilter(params.filter ?? {})
        if (!filter) throw new Refusal('invalid-input')
        return tasksFor(filter)
      }
      case 'tasks.subscribe': {
        const filter = taskFilter(params.filter ?? {})
        if (!filter) throw new Refusal('invalid-input')
        const id = ++nextSubscription
        queueMicrotask(() => {
          send({ t: 'event', name: 'tasks', subscription: id, offline: false, tasks: tasksFor(filter) })
        })
        return { subscription: id }
      }
      case 'tasks.unsubscribe':
        return {}
      case 'tasks.start':
      case 'tasks.continue':
      case 'nav.openSession':
        deps.onPreviewOnly()
        throw new Refusal('preview')
      case 'tasks.lookup':
        return { status: 'not-found' }
      case 'tasks.readReply':
        throw new Refusal('not-found')
      case 'storage.get': {
        const { scope, key } = documentRef(params)
        const found = documents.get(keyOf(scope, key))
        return found ? { document: structuredClone(found) } : {}
      }
      case 'storage.list': {
        if (typeof params.scope !== 'string' || !appScopeKind(params.scope)) throw new Refusal('invalid-input')
        return { documents: [...documents.values()].filter(item => item.scope === params.scope).map(item => structuredClone(item)) }
      }
      case 'storage.put': {
        const { scope, key } = documentRef(params)
        if (!Number.isSafeInteger(params.ifVersion) || jsonBytes(params.value) > 256 * 1024) throw new Refusal('invalid-input')
        const current = documents.get(keyOf(scope, key))
        if ((current?.version ?? 0) !== params.ifVersion) throw new Refusal('invalid-input', current?.version ?? 0)
        const version = (current?.version ?? 0) + 1
        documents.set(keyOf(scope, key), {
          scope,
          key,
          version,
          value: JSON.parse(JSON.stringify(params.value ?? null)) as unknown,
          updatedAt: new Date(now()).toISOString(),
        })
        if (watching) queueMicrotask(() => send({ t: 'event', name: 'storage', scope, key, version }))
        return { version }
      }
      case 'storage.delete': {
        const { scope, key } = documentRef(params)
        const current = documents.get(keyOf(scope, key))
        if (!current || current.version !== params.ifVersion) throw new Refusal('invalid-input', current?.version ?? 0)
        documents.delete(keyOf(scope, key))
        if (watching) queueMicrotask(() => send({ t: 'event', name: 'storage', scope, key, version: 0 }))
        return {}
      }
      case 'storage.watch':
        watching = true
        return {}
      case 'view.setState':
        if (jsonBytes(params.state) > APP_VIEW_STATE_BYTES) throw new Refusal('invalid-input')
        deps.setView(JSON.parse(JSON.stringify(params.state ?? null)) as unknown)
        return {}
      case 'diag.report':
        return {}
    }
  }

  return {
    call(message) {
      if (disposed) return
      const params = record(message.params)
      const reply = (outcome: { ok: true; value: unknown } | { ok: false; code: AppErrorCode; version?: number }) => {
        send({ t: 'result', id: message.id, ...outcome } as AppShellMessage)
      }
      if (!params) {
        reply({ ok: false, code: 'invalid-input' })
        return
      }
      if (!capabilityAllows(deps.page.capabilities, message.method, params.scope)) {
        reply({ ok: false, code: 'capability-denied' })
        return
      }
      try {
        reply({ ok: true, value: run(message.method, params) })
      } catch (cause) {
        reply(
          cause instanceof Refusal
            ? { ok: false, code: cause.code, ...(cause.version !== undefined ? { version: cause.version } : {}) }
            : { ok: false, code: 'unknown' },
        )
      }
    },
    update() {},
    dataChanged() {},
    hostChanged() {
      send({ t: 'event', name: 'host', info: deps.info() })
    },
    dispose() {
      disposed = true
      watching = false
      documents.clear()
    },
  }
}
