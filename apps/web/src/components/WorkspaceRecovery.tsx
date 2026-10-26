import { FolderInput } from 'lucide-react'
import { Button, Icon, ValuePicker } from '@latch/ui'
import { middleEllipsis } from '../format.ts'
import { ProjectIcon, projectName } from '../projects.tsx'
import { escapeHiddenCharacters } from './VisibleText.tsx'
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
    <section className="setup-panel" aria-label="选择项目继续会话">
      <header className="setup-panel-head">
        <Icon icon={FolderInput} size={16} />
        <h3>换个项目继续</h3>
      </header>
      <div className="setup-panel-body">
        <p className="setup-panel-text">原文件夹暂不可用。你的草稿和会话记录都还在，可以换个项目继续。</p>
        <p className="setup-panel-caption">从上次回复接着写，文件保留在各自的项目中。</p>
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
        {state.blockedReason && (
          <p className="setup-panel-caption" role="status">
            {state.blockedReason}
          </p>
        )}
      </div>
      <footer className="setup-panel-foot">
        <Button
          variant="primary"
          disabled={!state.intent}
          tooltip={state.blockedReason}
          onClick={() => {
            if (state.intent) props.onFork(state.intent.taskId, state.intent.upToMessageId, state.intent.workspaceId)
          }}>
          在所选项目继续
        </Button>
      </footer>
    </section>
  )
}
