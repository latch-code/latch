import {
  APP_VIEW_STATE_BYTES,
  isAppShellMessage,
  type AppBridgeMethod,
  type AppErrorCode,
  type AppFrameMessage,
  type AppHostInfo,
  type AppLastReply,
  type AppLookup,
  type AppShellMessage,
  type AppStorageDocument,
  type AppTask,
  type AppTaskFilter,
} from '@latch/protocol'

/** A refused or failed bridge call: one of the seven fixed codes, never the Host's own words. */
export class AppBridgeError extends Error {
  readonly code: AppErrorCode
  /** For `unknown`: the request ID to retry with, so a retry never starts a second session or writes twice. */
  readonly requestId: string | undefined
  /** For a write whose `ifVersion` no longer holds (`invalid-input`): the document's current version. */
  readonly version: number | undefined
  constructor(code: AppErrorCode, requestId?: string, version?: number) {
    super(code)
    this.name = 'AppBridgeError'
    this.code = code
    this.requestId = requestId
    this.version = version
  }
}

export interface TaskUpdate {
  /** The connection to the Mac is down: `tasks` is the last list seen and does not change until it is back. */
  offline: boolean
  tasks: AppTask[]
}

/** What a page can do, exactly the capabilities its manifest declares; the Host checks every call again. */
export interface Latch {
  tasks: {
    list(filter?: AppTaskFilter): Promise<AppTask[]>
    /** The list now and after every change; once offline, one `offline` update, then a full list when back. */
    subscribe(filter: AppTaskFilter | undefined, listener: (update: TaskUpdate) => void): () => void
    /** Starts a session with the project's default permissions. Pass the same `requestId` to retry an `unknown`. */
    start(input: { prompt: string; title?: string; projectId?: string; harnessId?: string; requestId?: string }): Promise<{
      sessionId: string
      requestId: string
    }>
    /** New input to a session this page started. */
    continue(sessionId: string, input: { prompt: string; requestId?: string }): Promise<{ requestId: string }>
    /** After an `unknown` start: whether the Host has a session for that request. */
    lookup(requestId: string): Promise<AppLookup>
    /** The last reply (Markdown text, at most 64 KiB) and end state of a session this page started. */
    readReply(sessionId: string): Promise<AppLastReply>
  }
  storage: {
    get(scope: string, key: string): Promise<AppStorageDocument | undefined>
    list(scope: string): Promise<AppStorageDocument[]>
    /** `ifVersion` 0: the document must be new. */
    put(scope: string, key: string, value: unknown, options: { ifVersion: number; requestId?: string }): Promise<{ version: number }>
    delete(scope: string, key: string, options: { ifVersion: number; requestId?: string }): Promise<void>
    /** A document changed somewhere (version 0: removed). */
    onChange(listener: (change: { scope: string; key: string; version: number }) => void): () => void
  }
  view: {
    /** What `setState` last kept for this page in this tab; it survives a reload of the page and a new version. */
    getState<T = unknown>(): T | undefined
    /** At most 64 KiB as JSON; kept only in this tab's memory. */
    setState(value: unknown): void
  }
  nav: {
    /** Shows a session this device can see. */
    openSession(sessionId: string): Promise<void>
  }
  diag: {
    /** A line for the page's diagnostics. */
    report(message: string): void
  }
  host: {
    info(): AppHostInfo
    onChange(listener: (info: AppHostInfo) => void): () => void
  }
}

const uuid = () => crypto.randomUUID()

/** The bridge client over the frame's one port. `post` is the port; everything the shell says comes to `receive`. */
export function createBridge(
  post: (message: AppFrameMessage) => void,
  initial: { info: AppHostInfo; view: unknown },
): { latch: Latch; receive: (message: unknown) => void } {
  let next = 0
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: AppBridgeError) => void; requestId?: string }>()
  const taskListeners = new Map<number, (update: TaskUpdate) => void>()
  /** The last list for a subscription the page has not been told the ID of yet. */
  const early = new Map<number, TaskUpdate>()
  const storageListeners = new Set<(change: { scope: string; key: string; version: number }) => void>()
  const hostListeners = new Set<(info: AppHostInfo) => void>()
  let info = initial.info
  let view = initial.view
  let watching = false

  const call = <T>(method: AppBridgeMethod, params: unknown, requestId?: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++next
      waiting.set(id, { resolve: resolve as (value: unknown) => void, reject, ...(requestId ? { requestId } : {}) })
      post({ t: 'call', id, method, params })
    })

  const receive = (message: unknown) => {
    if (!isAppShellMessage(message)) return
    const value = message as AppShellMessage
    if (value.t === 'result') {
      const entry = waiting.get(value.id)
      if (!entry) return
      waiting.delete(value.id)
      if (value.ok) entry.resolve(value.value)
      else entry.reject(new AppBridgeError(value.code, value.requestId ?? entry.requestId, value.version))
      return
    }
    if (value.name === 'tasks') {
      const update = { offline: value.offline, tasks: value.tasks }
      const listener = taskListeners.get(value.subscription)
      if (listener) listener(update)
      else if (early.size < 16) early.set(value.subscription, update)
    } else if (value.name === 'storage')
      for (const listener of storageListeners) listener({ scope: value.scope, key: value.key, version: value.version })
    else {
      info = value.info
      for (const listener of hostListeners) listener(info)
    }
  }

  const latch: Latch = {
    tasks: {
      list: filter => call('tasks.list', { filter: filter ?? {} }),
      subscribe(filter, listener) {
        let subscription: number | undefined
        let closed = false
        void call<{ subscription: number }>('tasks.subscribe', { filter: filter ?? {} }).then(
          result => {
            if (closed) {
              void call('tasks.unsubscribe', { subscription: result.subscription }).catch(() => {})
              return
            }
            subscription = result.subscription
            taskListeners.set(subscription, listener)
            const first = early.get(subscription)
            early.delete(subscription)
            if (first) listener(first)
          },
          () => {},
        )
        return () => {
          closed = true
          if (subscription === undefined) return
          taskListeners.delete(subscription)
          void call('tasks.unsubscribe', { subscription }).catch(() => {})
        }
      },
      start(input) {
        const requestId = input.requestId ?? uuid()
        return call<{ sessionId: string }>('tasks.start', { ...input, requestId }, requestId).then(result => ({
          sessionId: result.sessionId,
          requestId,
        }))
      },
      continue(sessionId, input) {
        const requestId = input.requestId ?? uuid()
        return call('tasks.continue', { sessionId, prompt: input.prompt, requestId }, requestId).then(() => ({ requestId }))
      },
      lookup: requestId => call('tasks.lookup', { requestId }),
      readReply: sessionId => call('tasks.readReply', { sessionId }),
    },
    storage: {
      get: (scope, key) => call<{ document?: AppStorageDocument }>('storage.get', { scope, key }).then(result => result.document),
      list: scope => call<{ documents: AppStorageDocument[] }>('storage.list', { scope }).then(result => result.documents),
      put(scope, key, value, options) {
        const requestId = options.requestId ?? uuid()
        return call('storage.put', { scope, key, value, ifVersion: options.ifVersion, requestId }, requestId)
      },
      delete(scope, key, options) {
        const requestId = options.requestId ?? uuid()
        return call<unknown>('storage.delete', { scope, key, ifVersion: options.ifVersion, requestId }, requestId).then(() => {})
      },
      onChange(listener) {
        storageListeners.add(listener)
        if (!watching) {
          watching = true
          void call('storage.watch', {}).catch(() => {
            watching = false
          })
        }
        return () => {
          storageListeners.delete(listener)
        }
      },
    },
    view: {
      getState: <T>() => view as T | undefined,
      setState(value) {
        const text = JSON.stringify(value ?? null)
        if (new TextEncoder().encode(text).length > APP_VIEW_STATE_BYTES) throw new AppBridgeError('invalid-input')
        view = JSON.parse(text) as unknown
        void call('view.setState', { state: view }).catch(() => {})
      },
    },
    nav: { openSession: sessionId => call<unknown>('nav.openSession', { sessionId }).then(() => {}) },
    diag: {
      report(message) {
        void call('diag.report', { message: String(message).slice(0, 2000) }).catch(() => {})
      },
    },
    host: {
      info: () => info,
      onChange(listener) {
        hostListeners.add(listener)
        return () => {
          hostListeners.delete(listener)
        }
      },
    },
  }
  return { latch, receive }
}
