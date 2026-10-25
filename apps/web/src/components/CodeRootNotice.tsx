import { Button, InlineNotice } from '@latch/ui'
import type { WorkspaceInfo } from '@latch/protocol'
import { CODE_ROOT_COPY } from '../core/securityCopy.ts'

/** The project a session or a new session works in when it lies in Latch's program directory, by the Host's flag. */
export function codeRootWorkspace(workspaces: readonly WorkspaceInfo[] | undefined, match: { id?: string; path?: string }) {
  return workspaces?.find(
    item => item.codeRoot === true && (item.id === match.id || (match.path !== undefined && item.path === match.path)),
  )
}

/**
 * The amber warning wherever such a folder is chosen or shown (设置 › 项目, the new session, 会话信息 › 环境): why every
 * write will ask, and, for the start directory, that the way out is a new project, with 新建项目… where this device can
 * make one.
 */
export function CodeRootNotice({
  workspace,
  onNewProject,
  className,
}: {
  workspace: Pick<WorkspaceInfo, 'id'>
  onNewProject?: () => void
  className?: string
}) {
  const start = workspace.id === 'default'
  return (
    <InlineNotice
      tone="warn"
      className={className}
      action={
        start && onNewProject ? (
          <Button size="xs" onClick={onNewProject}>
            {CODE_ROOT_COPY.newProject}
          </Button>
        ) : undefined
      }>
      {CODE_ROOT_COPY.notice}
      {start && CODE_ROOT_COPY.startDir}
    </InlineNotice>
  )
}
