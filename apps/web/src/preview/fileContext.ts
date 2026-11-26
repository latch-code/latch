import { createContext } from 'react'
import type { ContextFileOpenTarget, FileContext, FileOpenTarget, WorkspaceFileOpenTarget } from '@latch/protocol'

export type PreviewTarget = FileOpenTarget | (WorkspaceFileOpenTarget & { view?: never; attachmentId?: never })
export const FileOpenContext = createContext<((target: ContextFileOpenTarget) => void) | undefined>(undefined)
export const FolderOpenContext = createContext<
  ((sessionId: string, root: string, path: string, replaceTabId?: string) => void) | undefined
>(undefined)

export function contextOf(target: ContextFileOpenTarget): FileContext {
  return 'sessionId' in target
    ? { kind: 'session', sessionId: target.sessionId }
    : { kind: 'workspace', workspaceId: target.workspaceId, harnessId: target.harnessId }
}
export function fileContextKey(context: FileContext): string {
  return context.kind === 'session'
    ? `session:${context.sessionId}`
    : `workspace:${JSON.stringify([context.workspaceId, context.harnessId])}`
}
export function fileRoute(context: FileContext, action: 'list' | 'resolve' | 'search' | 'grep'): string {
  return `${context.kind === 'session' ? `tasks/${encodeURIComponent(context.sessionId)}` : `workspaces/${encodeURIComponent(context.workspaceId)}`}/files/${action}`
}
export function fileContextBody(context: FileContext): { harnessId?: string } {
  return context.kind === 'workspace' ? { harnessId: context.harnessId } : {}
}
export function targetIn(context: FileContext, reference: string, rootId?: string): ContextFileOpenTarget {
  return {
    ...(context.kind === 'session' ? { sessionId: context.sessionId } : { workspaceId: context.workspaceId, harnessId: context.harnessId }),
    reference,
    ...(rootId ? { rootId } : {}),
  }
}

/** Use a known root for tab identity. Leave a path that could cross roots for the Host to resolve as written. */
export function sessionFileTarget(target: FileOpenTarget, roots: readonly { id: string; path: string }[]): FileOpenTarget {
  const { reference } = target
  if (!target.rootId && reference.split('/').includes('..')) return target
  const root = target.rootId
    ? roots.find(root => root.id === target.rootId)
    : (roots.find(root => reference === root.path || reference.startsWith(`${root.path}/`))
      ?? (/^(?:\/|~\/|file:)/iu.test(reference) ? undefined : roots[0]))
  if (!root) return target
  const prefix = `${root.path}/`
  const path = reference.startsWith(prefix) ? reference.slice(prefix.length).replace(/^\/+/u, '') || root.path : reference
  return { ...target, reference: path, rootId: root.id }
}
