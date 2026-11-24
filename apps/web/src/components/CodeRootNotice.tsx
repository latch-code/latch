import { InlineNotice } from '@latch/ui'
import type { WorkspaceInfo } from '@latch/protocol'
import { CODE_ROOT_COPY } from '../core/securityCopy.ts'

/** The project a session or a new session works in when it lies in Latch's program directory, by the Host's flag. */
export function codeRootWorkspace(workspaces: readonly WorkspaceInfo[] | undefined, match: { id?: string; path?: string }) {
  return workspaces?.find(
    item => item.codeRoot === true && (item.id === match.id || (match.path !== undefined && item.path === match.path)),
  )
}

/** The same warning in project settings, the new session and the session's folder details. */
export function CodeRootNotice({ workspace, className }: { workspace: Pick<WorkspaceInfo, 'id'>; className?: string }) {
  const start = workspace.id === 'default'
  return (
    <InlineNotice tone="warn" className={className}>
      {CODE_ROOT_COPY.notice}
      {start && ` · ${CODE_ROOT_COPY.startDir}`}
    </InlineNotice>
  )
}
