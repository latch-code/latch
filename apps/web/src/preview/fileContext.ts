import { createContext } from 'react'
import type { ContextFileOpenTarget, FileContext, FileOpenTarget, WorkspaceFileOpenTarget } from '@latch/protocol'

export type PreviewTarget = FileOpenTarget | (WorkspaceFileOpenTarget & { view?: never; attachmentId?: never })
export const FileOpenContext = createContext<((target: ContextFileOpenTarget) => void) | undefined>(undefined)

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
