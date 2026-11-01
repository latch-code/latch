import { useEffect, type ReactNode, type RefObject } from 'react'
import { FlaskConical } from 'lucide-react'
import type { AppSnapshot, PersonalAssistantSummary } from '@latch/protocol'
import { Badge, Button, ICON_STROKE, MenuFooterNote, MOTION, Sheet, usePresence, ValuePicker } from '@latch/ui'
import { engineEntries, type ComposerChoice } from '../composerChoice.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { HarnessTile } from '../components/BrandTile.tsx'
import { ModelPicker, ModeSwitch, ProjectPicker } from '../components/Pickers.tsx'
import { DEFAULT_MODEL } from '../composer/modelReasoning.ts'
import { draftPermission } from '../composer/permission.ts'

function StaticRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="new-sheet-row">
      <span className="new-sheet-label">{label}</span>
      <span className="new-sheet-value">{value}</span>
    </div>
  )
}

/** The phone's new session: one row per choice (项目, Harness, 模型, 思考, 权限), then the input; 开始 is in the header. */
export function NewSessionSheet({
  personal,
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
  onManageProviders,
  onProvidersChanged,
  onManageWorkspaces,
  onCreateProject,
  projectAsk,
  onBrowseFiles,
  focusComposer,
}: {
  personal?: PersonalAssistantSummary
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
  onManageProviders?: (() => void) | undefined
  onProvidersChanged?: (() => void) | undefined
  onManageWorkspaces?: (() => void) | undefined
  onCreateProject?: (() => void) | undefined
  projectAsk?: { request: number; notice?: string | undefined; clearNotice: () => void }
  onBrowseFiles?(): void
  focusComposer?: RefObject<HTMLTextAreaElement | null>
}) {
  const { present } = usePresence(open, MOTION.sheet)
  useEffect(() => {
    if (!open || !present) return undefined
    const frame = requestAnimationFrame(() => {
      focusComposer?.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, present, focusComposer])
  const catalog = snapshot.catalog
  const entries = catalog ? engineEntries(catalog, access, choice.workspaceId) : []
  const harness = entries.find(entry => entry.harness.id === choice.harnessId)?.harness
  const permission = draftPermission(harness, choice.mode)
  return (
    <Sheet
      open={open}
      detent="large"
      title={personal ? '和' + personal.name + '聊聊' : '新会话'}
      className="new-session-sheet"
      onClose={onClose}
      action={
        <Button variant="primary" disabled={!canStart} loading={sending} onClick={onStart}>
          开始
        </Button>
      }>
      {present && !personal && catalog && (
        <div className="new-sheet-card">
          <ProjectPicker
            access={access}
            harness={harness}
            variant="row"
            catalog={catalog}
            value={choice.workspaceId === 'default' && !choice.projectSkipped && catalog.sessionFolders ? undefined : choice.workspaceId}
            disabled={disabled}
            onChange={workspaceId => onChoice({ workspaceId, projectSkipped: workspaceId === 'default' })}
            onManage={onManageWorkspaces}
            onCreate={onCreateProject}
            openRequest={projectAsk?.request}
            notice={projectAsk?.notice}
            onClosed={projectAsk?.clearNotice}
          />
          <ValuePicker
            variant="row"
            label="Harness"
            placeholder="选择 Harness"
            className="new-sheet-row"
            value={harness?.id}
            leading={harness ? <HarnessTile harness={harness} size={16} /> : undefined}
            disabled={disabled}
            options={entries.map(entry => ({
              value: entry.harness.id,
              label: entry.label,
              description: entry.line,
              media: <HarnessTile harness={entry.harness} size={20} />,
              ...(entry.disabledReason ? { disabledReason: entry.disabledReason } : {}),
            }))}
            onValueChange={harnessId => onChoice({ harnessId })}
          />
          {harness?.models === 'host' ? (
            <>
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
              <StaticRow label="思考" value="模型默认" />
            </>
          ) : (
            harness && (
              <>
                <StaticRow label="模型" value={`${DEFAULT_MODEL} · 开始后可以换`} />
                <StaticRow label="思考" value="默认 · 开始后可以换" />
              </>
            )
          )}
          {permission && (
            <ValuePicker
              variant="row"
              label="权限"
              className={`new-sheet-row new-sheet-permission${permission.amber ? ' is-amber' : ''}`}
              value="current"
              options={[{ value: 'current', label: permission.label }]}
              footer={<MenuFooterNote>{permission.note ?? permission.line}</MenuFooterNote>}
              onValueChange={() => {}}
            />
          )}
          {onBrowseFiles && (
            <Button variant="ghost" onClick={onBrowseFiles}>
              浏览项目文件
            </Button>
          )}
        </div>
      )}
      {present && !catalog && (
        <div className="new-sheet-card">
          <div className="new-sheet-row">
            <span className="new-sheet-label">方式</span>
            <ModeSwitch value={choice.mode} disabled={disabled} onChange={mode => onChoice({ mode })} />
          </div>
        </div>
      )}
      {present && demo && (
        <p className="new-sheet-note">
          <FlaskConical size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          <Badge tone="warn">演示</Badge>回复由本地脚本生成，不调用模型服务。
        </p>
      )}
      {present && setup}
      {present && composer}
    </Sheet>
  )
}
