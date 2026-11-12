import { FolderInput } from 'lucide-react'
import { Button, ICON_STROKE, ValuePicker } from '@latch/ui'
import { RECOVERY_COPY } from '../core/securityCopy.ts'
import { basename, middleEllipsis } from '../format.ts'
import { ProjectIcon, projectName } from '../projects.tsx'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { workspaceRecovery, type WorkspaceRecoveryInput } from './workspaceRecovery.ts'

export interface WorkspaceRecoveryProps extends WorkspaceRecoveryInput {
  onWorkspaceChange: (workspaceId: string) => void
  /** Prepare a new draft from history. The owner retains the draft and sends only after the user's next submit. */
  onFork: (taskId: string, upToMessageId: string, workspaceId: string) => void
}

/** Keep history readable while the user explicitly chooses the next project's actual Host-owned identity. */
export function WorkspaceRecovery(props: WorkspaceRecoveryProps) {
  const state = workspaceRecovery(props)
  const selected = state.workspaces.find(workspace => workspace.id === props.workspaceId)
  const locked = props.phase !== 'idle'
  return (
    <section className="composer-drawer recovery-drawer" aria-label="选择项目继续会话">
      <p className="recovery-line" role="status">
        <FolderInput size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
        {RECOVERY_COPY.folderMissing(
          escapeHiddenCharacters(basename(props.source.summary.cwd ?? '') || props.source.summary.title || '这个会话'),
        )}
      </p>
      <div className="recovery-actions">
        <ValuePicker
          label="继续会话的项目"
          placeholder="选择项目…"
          value={selected?.id}
          searchable={state.workspaces.length > 6}
          options={state.workspaces.map(workspace => ({
            value: workspace.id,
            label: escapeHiddenCharacters(projectName(workspace)),
            description: escapeHiddenCharacters(middleEllipsis(workspace.path, 60)),
            media: <ProjectIcon project={workspace} size={16} />,
          }))}
          disabled={locked || !state.workspaces.length}
          disabledReason={locked || !state.workspaces.length ? state.blockedReason : undefined}
          onValueChange={workspaceId => {
            if (!locked && state.workspaces.some(workspace => workspace.id === workspaceId)) props.onWorkspaceChange(workspaceId)
          }}
        />
        <Button
          size="sm"
          variant="primary"
          disabled={!state.intent}
          tooltip={state.blockedReason}
          onClick={() => {
            if (state.intent) props.onFork(state.intent.taskId, state.intent.upToMessageId, state.intent.workspaceId)
          }}>
          {RECOVERY_COPY.continueInNew}
        </Button>
      </div>
    </section>
  )
}
