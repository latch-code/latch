/**
 * The page bridge, `appProtocol: 1`: the messages between a plugin page's opaque frame (`@latch/app-sdk`) and the shell
 * page that holds it. The frame never talks to the Host; the shell checks every call, asks the Host with its own
 * credentials and hands back only the whitelisted fields below. See docs/APP-PAGES.md.
 */
import type { AppCapabilities, AppDataDocument, AppStorageScopeKind } from './apps.ts'

/** The fixed failure codes a page sees; the Host's own error text never reaches it. `preview` comes only from the preview bridge. */
export const APP_ERROR_CODES = [
  'capability-denied',
  'forbidden',
  'offline',
  'unknown',
  'rate-limited',
  'invalid-input',
  'not-found',
  /** Only in the preview: starting or continuing a session does nothing there. */
  'preview',
] as const

export const APP_PROTOCOL = 1
/** The SDK version the runtime carries; a manifest asks for `^1`. */
export const APP_SDK_VERSION = '1.0.0'
/** Where the runtime puts the modules a page bundle imports: `react`, `react/jsx-runtime` and `@latch/app-sdk`. */
export const APP_RUNTIME_MODULES = '__latchModules'
export type AppErrorCode = (typeof APP_ERROR_CODES)[number]

/** A session as a page sees it: no messages, paths, attachments or private context. */
export interface AppTask {
  id: string
  title: string
  status: 'idle' | 'running' | 'waiting-approval' | 'cancelled' | 'failed' | 'interrupted'
  /** A run is going on or waits for a person. */
  running: boolean
  runOutcome?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  projectId?: string
  projectName?: string
  harnessId: string
  /** The page that started it (`<pluginId>/<appId>`). */
  originApp?: string
  updatedAt: string
}

export interface AppTaskFilter {
  projectId?: string
  /** Only the sessions this page started. */
  mine?: boolean
  /** At most this many, newest first (1–200, default 50). */
  limit?: number
}

export interface AppHostInfo {
  sdk: string
  appProtocol: number
  theme: 'light' | 'dark'
  offline: boolean
  /** This device may start sessions and write page data (`run`). */
  canRun: boolean
  /** The Harnesses this device sees, by ID and display name only: no commands, paths or settings. */
  harnesses: AppHarness[]
  /** The page runs in a draft's preview: nothing it does reaches the Host. */
  preview?: true
}

export interface AppHarness {
  id: string
  name: string
}

export interface AppStartInput {
  requestId: string
  prompt: string
  title?: string
  projectId?: string
  harnessId?: string
}

export type AppStorageDocument = Pick<AppDataDocument, 'scope' | 'key' | 'version' | 'value' | 'updatedAt'>

/**
 * Each method a frame may call and the capability it needs (`null`: none). `view.getState` and `host.info` need no call:
 * the frame has both from `init` and the `host` event.
 */
export const APP_BRIDGE_METHODS = {
  'tasks.list': 'tasks.read',
  'tasks.subscribe': 'tasks.read',
  'tasks.unsubscribe': 'tasks.read',
  'tasks.start': 'tasks.start',
  'tasks.lookup': 'tasks.start',
  'tasks.continue': 'tasks.continue',
  'tasks.readReply': 'tasks.readOwn',
  'storage.get': 'storage',
  'storage.list': 'storage',
  'storage.put': 'storage',
  'storage.delete': 'storage',
  'storage.watch': 'storage',
  'view.setState': null,
  'nav.openSession': null,
  'diag.report': null,
} as const satisfies Record<string, keyof AppCapabilities | null>
export type AppBridgeMethod = keyof typeof APP_BRIDGE_METHODS

/** The page's view state (scroll, open sections, unsaved input): only in this tab's memory, at most 64 KiB as JSON. */
export const APP_VIEW_STATE_BYTES = 64 * 1024
/** Page code the runtime accepts, as bytes. */
export const APP_MODULE_BYTES = 2 * 1024 * 1024

export type AppFrameMessage =
  | { t: 'call'; id: number; method: AppBridgeMethod; params: unknown }
  | { t: 'key'; key: string; code: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }
  | { t: 'error'; message: string }
  | { t: 'rendered' }
  | { t: 'migrated'; documents: Array<{ scope: string; key: string; value: unknown }> }
  | { t: 'migrate-failed'; message: string }

export type AppShellMessage =
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; code: AppErrorCode; requestId?: string; version?: number }
  | { t: 'event'; name: 'tasks'; subscription: number; offline: boolean; tasks: AppTask[] }
  | { t: 'event'; name: 'storage'; scope: string; key: string; version: number }
  | { t: 'event'; name: 'host'; info: AppHostInfo }

/** The init message a frame gets once it said `ready`; the port and the module bytes are transferred with it. */
export interface AppFrameInit {
  type: 'init'
  protocol: typeof APP_PROTOCOL
  nonce: string
  module: ArrayBuffer
  /** SHA-256 of `module`, lowercase hex: the runtime checks it before importing. */
  bundleHash: string
  title: string
  info: AppHostInfo
  view: unknown
  /** Present when the stored data is older than the code: the runtime runs the page's `migrate` and answers `migrated`. */
  migrate?: { from: number; to: number; documents: AppStorageDocument[] }
}

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exactly = (value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []) =>
  keys.every(key => key in value) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key))
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max

/** Whether `value` is a message a frame may send; anything else closes the frame. */
export function isAppFrameMessage(value: unknown): value is AppFrameMessage {
  if (!plain(value)) return false
  switch (value.t) {
    case 'call':
      return (
        exactly(value, ['t', 'id', 'method', 'params'])
        && Number.isSafeInteger(value.id)
        && (value.id as number) > 0
        && typeof value.method === 'string'
        && Object.hasOwn(APP_BRIDGE_METHODS, value.method)
      )
    case 'key':
      return (
        exactly(value, ['t', 'key', 'code', 'meta', 'ctrl', 'shift', 'alt'])
        && text(value.key, 32)
        && text(value.code, 32)
        && [value.meta, value.ctrl, value.shift, value.alt].every(flag => typeof flag === 'boolean')
      )
    case 'error':
    case 'migrate-failed':
      return exactly(value, ['t', 'message']) && text(value.message, 8 * 1024)
    case 'rendered':
      return exactly(value, ['t'])
    case 'migrated':
      return (
        exactly(value, ['t', 'documents'])
        && Array.isArray(value.documents)
        && value.documents.length <= 2000
        && value.documents.every(
          item => plain(item) && exactly(item, ['scope', 'key', 'value']) && text(item.scope, 300) && text(item.key, 256),
        )
      )
    default:
      return false
  }
}

/** Whether `value` is a message the shell may send; the runtime drops anything else. */
export function isAppShellMessage(value: unknown): value is AppShellMessage {
  if (!plain(value)) return false
  if (value.t === 'result')
    return (
      Number.isSafeInteger(value.id)
      && (value.ok === true
        ? exactly(value, ['t', 'id', 'ok', 'value'])
        : value.ok === false
          && exactly(value, ['t', 'id', 'ok', 'code'], ['requestId', 'version'])
          && (APP_ERROR_CODES as readonly unknown[]).includes(value.code))
    )
  if (value.t !== 'event') return false
  if (value.name === 'tasks')
    return (
      exactly(value, ['t', 'name', 'subscription', 'offline', 'tasks']) && Array.isArray(value.tasks) && typeof value.offline === 'boolean'
    )
  if (value.name === 'storage')
    return exactly(value, ['t', 'name', 'scope', 'key', 'version']) && typeof value.scope === 'string' && typeof value.key === 'string'
  return value.name === 'host' && exactly(value, ['t', 'name', 'info']) && plain(value.info)
}

/** A storage scope string a page may name: `plugin`, `project:<id>` or `session:<id>`. */
export function appScopeKind(scope: string): AppStorageScopeKind | undefined {
  if (scope === 'plugin') return 'plugin'
  if (/^project:[A-Za-z0-9_-]{1,64}$/u.test(scope)) return 'project'
  return scope.startsWith('session:') && scope.length > 8 && scope.length <= 8 + 256 && !/[\u0000-\u001f\u007f]/u.test(scope)
    ? 'session'
    : undefined
}
