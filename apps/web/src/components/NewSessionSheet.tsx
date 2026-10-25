import { projectScopeCaption } from '../projects.tsx'
import { VisibleText } from './VisibleText.tsx'
import { useEffect, useRef, type ReactNode } from 'react'
import { FlaskConical, LockKeyhole } from 'lucide-react'
import type { AppSnapshot } from '@latch/protocol'
import { findHarness, type ComposerChoice } from '../composerChoice.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { ModelPicker, ModeSwitch, ProjectPicker } from './Pickers.tsx'
import { Badge, Button, ICON_STROKE, MOTION, Sheet, usePresence } from '@latch/ui'

/** The phone's new-session sheet shares harness and setup controls with the desktop composer. */
export function NewSessionSheet({
  open,
  onClose,
  snapshot,
  access,
  choice,
  onChoice,
  disabled,
  canStart,
  sending,
  onStart,
  composer,
  setup,
  demo,
  suggestions,
  harnesses,
  onManageProviders,
  onProvidersChanged,
  onManageWorkspaces,
  onCreateProject,
  startLabel,
}: {
  open: boolean
  onClose: () => void
  snapshot: AppSnapshot
  access: Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>
  choice: ComposerChoice
  onChoice: (patch: Partial<ComposerChoice>) => void
  disabled: boolean
  canStart: boolean
  sending: boolean
  onStart: () => void
  composer: ReactNode
  setup?: ReactNode
  demo: boolean
  suggestions?: ReactNode
  harnesses?: ReactNode
  onManageProviders?: () => void
  onProvidersChanged?: () => void
  onManageWorkspaces?: () => void
  onCreateProject?: () => void
  startLabel?: string
}) {
  const { present } = usePresence(open, MOTION.slow)
  const choices = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!open || !present) return undefined
    const frame = requestAnimationFrame(() =>
      choices.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus({ preventScroll: true }),
    )
    return () => cancelAnimationFrame(frame)
  }, [open, present])
  const catalog = snapshot.catalog
  const harness = findHarness(catalog, choice.harnessId)
  return (
    <Sheet
      open={open}
      detent="large"
      title="新会话"
      className="new-session-sheet"
      onClose={onClose}
      action={
        <Button variant="primary" disabled={!canStart} loading={sending} onClick={onStart} icon={startLabel ? LockKeyhole : undefined}>
          {startLabel ?? '开始'}
        </Button>
      }>
      {present && harnesses && (
        <section ref={choices} className="new-sheet-group" aria-label="Agent">
          <h3 className="ui-sheet-group-label">Agent</h3>
          {harnesses}
        </section>
      )}
      {present && (
        <div className="new-sheet-card">
          <div className="new-sheet-row">
            <span className="new-sheet-label">电脑</span>
            <span className="new-sheet-value">{snapshot.hostName || '执行端'}</span>
          </div>
          {catalog && choice.mode !== 'chat' && (
            <ProjectPicker
              access={access}
              harness={harness}
              variant="row"
              catalog={catalog}
              value={choice.workspaceId}
              disabled={disabled}
              onChange={workspaceId => onChoice({ workspaceId })}
              onManage={onManageWorkspaces}
              onCreate={onCreateProject}
            />
          )}
          {catalog && harness?.models === 'host' && (
            <ModelPicker
              variant="row"
              catalog={catalog}
              value={choice.model}
              disabled={disabled}
              access={access}
              onChange={model => onChoice({ model })}
              onManage={onManageProviders}
              onAdded={onProvidersChanged}
            />
          )}
          {!catalog && (
            <div className="new-sheet-row">
              <span className="new-sheet-label">方式</span>
              <ModeSwitch value={choice.mode} disabled={disabled} onChange={mode => onChoice({ mode })} />
            </div>
          )}
        </div>
      )}
      {present && demo && (
        <p className="new-sheet-note">
          <FlaskConical size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          <Badge tone="warn">演示</Badge>回复由本地脚本生成，不调用模型服务。
        </p>
      )}
      {present && setup}
      {present
        && choice.mode !== 'chat'
        && projectScopeCaption(
          catalog?.workspaces.find(item => item.id === choice.workspaceId),
          harness,
        ) && (
          <p className="composer-notice">
            <VisibleText
              text={projectScopeCaption(
                catalog?.workspaces.find(item => item.id === choice.workspaceId),
                harness,
              )!}
            />
          </p>
        )}
      {present && composer}
      {present && suggestions}
    </Sheet>
  )
}
