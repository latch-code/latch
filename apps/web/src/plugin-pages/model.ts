import type {
  AppCapabilities,
  AppErrorCode,
  AppSnapshot,
  AppStorageDocument,
  AppSummary,
  AppTask,
  AppTaskFilter,
  TaskSummary,
} from '@latch/protocol'
import { APP_BRIDGE_METHODS, appScopeKind, type AppBridgeMethod } from '@latch/protocol'
import { ApiError, ApiTimeoutError } from '../core/api.ts'
import { waitsOnYou } from '../sessions.ts'

/** `<pluginId>/<appId>`, as `via.app` and a session's `origin.app` name a page. */
export const appRef = (page: Pick<AppSummary, 'pluginId' | 'appId'>) => `${page.pluginId}/${page.appId}`

/** The pages the navigation lists: every applied page that is not disabled. */
export function listedApps(snapshot: AppSnapshot): AppSummary[] {
  return (snapshot.apps ?? []).filter(page => page.status !== 'disabled')
}

export function findApp(snapshot: AppSnapshot, pluginId: string, appId: string): AppSummary | undefined {
  return snapshot.apps?.find(page => page.pluginId === pluginId && page.appId === appId)
}

/** 「来自 <页面名>」 for a session a page started; the plugin's name when the page is gone. */
export function originTitle(task: Pick<TaskSummary, 'origin'>, snapshot: AppSnapshot): string | undefined {
  const origin = task.origin?.app
  if (!origin) return undefined
  const page = snapshot.apps?.find(item => appRef(item) === origin)
  return page?.title ?? '插件页面'
}

/** Sessions that carry private context never reach a page, whatever this device may read itself. */
const isPrivate = (task: TaskSummary) => task.agent !== undefined || task.agentPrivate === true || task.personal !== undefined

/** The page's view of the session list: only the whitelisted fields, newest first. */
export function appTasks(snapshot: AppSnapshot, filter: AppTaskFilter, page: Pick<AppSummary, 'pluginId' | 'appId'>): AppTask[] {
  const projects = new Map((snapshot.catalog?.workspaces ?? []).map(project => [project.id, project.name]))
  const mine = appRef(page)
  return snapshot.tasks
    .filter(task => !isPrivate(task) && !task.archived)
    .filter(task => filter.projectId === undefined || task.workspaceId === filter.projectId)
    .filter(task => !filter.mine || task.origin?.app === mine)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, filter.limit ?? 50)
    .map(task => ({
      id: task.id,
      title: task.title,
      status: task.status,
      running: task.status === 'running' || task.status === 'waiting-approval',
      ...(task.runOutcome ? { runOutcome: task.runOutcome } : {}),
      ...(task.workspaceId ? { projectId: task.workspaceId } : {}),
      ...(task.workspaceId && projects.has(task.workspaceId) ? { projectName: projects.get(task.workspaceId)! } : {}),
      harnessId: task.harnessId,
      ...(task.origin?.app ? { originApp: task.origin.app } : {}),
      updatedAt: task.updatedAt,
    }))
}

/** A filter as a page may give it, or undefined. */
export function taskFilter(value: unknown): AppTaskFilter | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['projectId', 'mine', 'limit'].includes(key))) return undefined
  if (input.projectId !== undefined && (typeof input.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(input.projectId)))
    return undefined
  if (input.mine !== undefined && typeof input.mine !== 'boolean') return undefined
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 200))
    return undefined
  return {
    ...(input.projectId !== undefined ? { projectId: input.projectId as string } : {}),
    ...(input.mine !== undefined ? { mine: input.mine as boolean } : {}),
    ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
  }
}

/** Whether the manifest lets the page make this call: the method's capability, and a storage scope it declares. */
export function capabilityAllows(capabilities: AppCapabilities, method: AppBridgeMethod, scope?: unknown): boolean {
  const needed = APP_BRIDGE_METHODS[method]
  if (needed === null) return true
  if (!capabilities[needed]) return false
  if (needed !== 'storage' || method === 'storage.watch') return true
  const kind = typeof scope === 'string' ? appScopeKind(scope) : undefined
  return kind !== undefined && capabilities.storage!.includes(kind)
}

/** A stored document with only the fields a page sees. */
export function storageDocument(value: AppStorageDocument): AppStorageDocument {
  return { scope: value.scope, key: value.key, version: value.version, value: value.value, updatedAt: value.updatedAt }
}

/** The Host's answer as one of the seven codes a page sees (docs/APP-PAGES.md, 失败码); the Host's own text stays here. */
export function bridgeCode(error: unknown): AppErrorCode {
  if (error instanceof ApiTimeoutError || !(error instanceof ApiError)) return 'unknown'
  const { status, code } = error
  if (code === 'app-capability-denied' || (status === 409 && (code === 'app-revision-stale' || code === 'app-disabled')))
    return 'capability-denied'
  if (status === 401 || status === 403) return 'forbidden'
  if (status === 429) return 'rate-limited'
  if (status === 404) return 'not-found'
  if (status === 400 || status === 413) return 'invalid-input'
  if (status === 409) return code === 'app-data-conflict' || code === 'request-conflict' ? 'invalid-input' : 'forbidden'
  return 'unknown'
}

/**
 * Whether a key the frame reports is taken: never while the shell covers the frame or a migration runs, only while the
 * frame has the focus, and a Cmd/Ctrl key only within the transient activation a real key press in the frame gives.
 */
export function acceptFrameKey(input: {
  key: string
  covered: boolean
  migrating: boolean
  focused: boolean
  activated: boolean
}): boolean {
  if (input.covered || input.migrating || !input.focused) return false
  return input.key === 'Escape' || input.activated
}

/** The shell shortcuts a key from a frame may run: only ones that move between places without focusing a field. */
export function frameShortcutAllowed(action: unknown): boolean {
  return action === 'sidebar' || action === 'settings'
}

/** Opening a page fails this many times in a row before it shows only the error card. */
export const OPEN_ATTEMPTS = 3

/**
 * Failures counted since the page was mounted or the person pressed 重新加载: a draw in between never resets them, so a
 * page that draws and then fails stops after the third try instead of reloading forever.
 */
export function openStep(failures: number, outcome: 'ready' | 'failed'): { failures: number; next: 'ready' | 'retry' | 'give-up' } {
  if (outcome === 'ready') return { failures, next: 'ready' }
  const count = failures + 1
  return { failures: count, next: count >= OPEN_ATTEMPTS ? 'give-up' : 'retry' }
}

/** A session that waits for the person (an approval, a question): a page never takes them there; they open it from the list. */
export function sessionWaits(snapshot: Pick<AppSnapshot, 'tasks' | 'approvals'>, sessionId: string): boolean {
  const task = snapshot.tasks.find(item => item.id === sessionId)
  return (task !== undefined && waitsOnYou(task)) || snapshot.approvals.some(approval => approval.sessionId === sessionId)
}

/** A page version as a frame loads it. */
export interface PageVersion {
  revision: string
  bundleHash: string
}

/**
 * After the newly applied version fails to open: the version this page last drew in this tab, when that is an earlier
 * one and the page has not fallen back already. Its calls are refused as stale; it only keeps the page on screen.
 */
export function fallbackVersion(lastDrawn: PageVersion | null, page: { revision: string }, fallen: boolean): PageVersion | undefined {
  if (fallen || !lastDrawn || lastDrawn.revision === page.revision) return undefined
  return lastDrawn
}
