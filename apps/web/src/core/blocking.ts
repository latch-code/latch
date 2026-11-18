import { escapeSecurityText, type ApiFailure, type AppSnapshot, type BlockingTask, type PresenceAction } from '@latch/protocol'
import { api } from './api.ts'
import { BLOCKED_VERBS, CONFIRMATION_COPY, type NamedSession } from './securityCopy.ts'

/**
 * A confirmation the Host held back while a full-access session runs or waits for an answer (`presence-blocked`): the
 * action asked for and the sessions holding it, as far as the Host told this device. The Host decides; this only says
 * which session it is and offers to open or stop it.
 */
export interface BlockedDetail {
  action?: PresenceAction
  tasks: BlockingTask[]
}

const MAX_TASKS = 10
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max

/** The refusal's details, checked: unknown actions and malformed sessions are dropped. Older Hosts send neither. */
export function blockedDetail(details: Readonly<Partial<ApiFailure>>): BlockedDetail {
  const action = typeof details.action === 'string' && Object.hasOwn(BLOCKED_VERBS, details.action) ? details.action : undefined
  const listed: unknown[] = Array.isArray(details.blockingTasks) ? details.blockingTasks : []
  const tasks = listed
    .filter((item): item is BlockingTask => {
      if (!item || typeof item !== 'object') return false
      const { id, title, harnessId } = item as Record<string, unknown>
      return isText(id, 256) && id.length > 0 && isText(title, 1000) && isText(harnessId, 128)
    })
    .slice(0, MAX_TASKS)
    .map(({ id, title, harnessId }) => ({ id, title, harnessId }))
  return { ...(action ? { action } : {}), tasks }
}

/** What this page's snapshot shows holding confirmations back: full-access sessions running or waiting for an answer. */
export function activeFullAccess(snapshot: Pick<AppSnapshot, 'tasks'>): BlockingTask[] {
  const waiting = (task: AppSnapshot['tasks'][number]) => (task.status === 'waiting-approval' ? 0 : 1)
  return snapshot.tasks
    .filter(task => task.level === 'L3' && (task.status === 'running' || task.status === 'waiting-approval'))
    .sort((a, b) => waiting(a) - waiting(b) || b.updatedAt.localeCompare(a.updatedAt))
    .map(task => ({ id: task.id, title: task.title, harnessId: task.harnessId }))
}

/**
 * Those of `named` that may still hold the confirmation back: all of them without a snapshot, else those it shows
 * running or waiting, or does not list yet. Saying a session ended when it has not would send the person back to fail.
 */
export function stillBlocking(named: BlockingTask[], snapshot: Pick<AppSnapshot, 'tasks'> | null): BlockingTask[] {
  if (snapshot === null) return named
  const status = new Map(snapshot.tasks.map(task => [task.id, task.status]))
  return named.filter(task => {
    const current = status.get(task.id)
    return current === undefined || current === 'running' || current === 'waiting-approval'
  })
}

const TITLE_LIMIT = 40

/**
 * A session title for a security surface: hidden and direction-changing characters made visible, then at most 40
 * characters (whole graphemes where the browser can tell), so a long title cannot push the rest of the line away.
 */
export function shownTitle(title: string): string {
  const escaped = escapeSecurityText(title.trim())
  if (!escaped) return CONFIRMATION_COPY.untitled
  const parts =
    typeof Intl.Segmenter === 'function'
      ? Array.from(new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(escaped), part => part.segment)
      : Array.from(escaped)
  return parts.length > TITLE_LIMIT ? `${parts.slice(0, TITLE_LIMIT - 1).join('')}…` : escaped
}

/**
 * A blocking session as the copy names it: its title shortened and escaped, its agent's name from the catalog, escaped
 * (left out on an older Host or for a harness it no longer lists), and whether it waits for the person rather than runs.
 */
export function namedSession(task: BlockingTask, snapshot: Pick<AppSnapshot, 'catalog' | 'tasks'> | null): NamedSession {
  const name = snapshot?.catalog?.harnesses.find(harness => harness.id === task.harnessId)?.capabilities.display.label
  const agent = name ? escapeSecurityText(name) : ''
  const waiting = snapshot?.tasks.find(item => item.id === task.id)?.status === 'waiting-approval'
  return { title: shownTitle(task.title), ...(agent ? { agent } : {}), ...(waiting ? { waiting } : {}) }
}

/** Asks the Host to stop a session; it settles on the Host, so the caller watches the snapshot for the outcome. */
export async function stopBlockingSession(id: string): Promise<void> {
  await api<unknown>(`tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
}

let opener: ((sessionId: string) => void) | null = null

/** The workspace installs how a session is opened from outside it (the confirmation dock); returns the removal. */
export function setSessionOpener(open: (sessionId: string) => void): () => void {
  opener = open
  return () => {
    if (opener === open) opener = null
  }
}

const keepers = new Set<() => void>()

/**
 * A form that a confirmation started registers how to keep what was typed when 查看会话 leaves settings for the
 * session, so coming back finds it as it was; returns the removal.
 */
export function keepWhileAway(keep: () => void): () => void {
  keepers.add(keep)
  return () => {
    keepers.delete(keep)
  }
}

/** Opens a session in the workspace; false when no workspace is shown (the enrollment page). */
export function openSession(sessionId: string): boolean {
  if (opener === null) return false
  for (const keep of keepers) keep()
  opener(sessionId)
  return true
}

export const canOpenSessions = (): boolean => opener !== null
