import { useEffect, type ReactNode, type RefObject } from 'react'
import { FlaskConical } from 'lucide-react'
import type { AppSnapshot, PersonalAssistantSummary } from '@latch/protocol'
import { Badge, Button, ICON_STROKE, MOTION, Sheet, SwitchRow, usePresence, ValuePicker } from '@latch/ui'
import { engineEntries, harnessName, type ComposerChoice } from '../composerChoice.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { MODE_COPY } from '../core/securityCopy.ts'
import { HarnessTile } from '../components/BrandTile.tsx'
import { ModelPicker, ModeSwitch, ProjectPicker } from '../components/Pickers.tsx'
import { draftPermission } from '../composer/permission.ts'

function StaticRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="new-sheet-row">
      <span className="new-sheet-label">{label}</span>
      <span className="new-sheet-value">{value}</span>
    </div>
  )
}

/** The phone's new session: one row per choice (Agent, 项目, 引擎, 模型, 权限), then the input; 开始 is in the header. */
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
  const permission = draftPermission(harness)
  const canChatOnly = harness?.modes.includes('chat') === true && harness.modes.includes('agent')
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
          <StaticRow label="Agent" value="通用" />
          {choice.mode !== 'chat' && (
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
          <ValuePicker
            variant="row"
            label="引擎"
            placeholder="选择引擎"
            className="new-sheet-row"
            value={harness?.id}
            leading={harness ? <HarnessTile harness={harness} size={16} /> : undefined}
            disabled={disabled}
            options={entries.map(entry => ({
              value: entry.harness.id,
              label: entry.label,
              media: <HarnessTile harness={entry.harness} size={20} />,
              ...(entry.disabledReason ? { disabledReason: entry.disabledReason } : {}),
            }))}
            onValueChange={harnessId => {
              const chosen = entries.find(entry => entry.harness.id === harnessId)?.harness
              onChoice({ harnessId, ...(choice.mode === 'chat' && !chosen?.modes.includes('chat') ? { mode: 'agent' as const } : {}) })
            }}
          />
          {harness?.models === 'host' ? (
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
          ) : (
            harness && <StaticRow label="模型" value={`${harnessName(harness)} 自带`} />
          )}
          {permission && (
            <StaticRow label="权限" value={permission.label === MODE_COPY.afterStart ? permission.label : MODE_COPY.askWhenNeeded} />
          )}
          {canChatOnly && (
            <SwitchRow
              className="new-sheet-row"
              title="只聊天，不读写文件"
              checked={choice.mode === 'chat'}
              disabled={disabled}
              onCheckedChange={chat => onChoice({ mode: chat ? 'chat' : 'agent' })}
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
