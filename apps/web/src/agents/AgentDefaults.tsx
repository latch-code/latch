import type { HostCatalog } from '@latch/protocol'
import { Button } from '@latch/ui'
import { DraftModelControl } from '../composer/ModelControl.tsx'
import { DraftThinkingControl } from '../composer/ThinkingControl.tsx'
import { PermissionChip } from '../composer/PermissionChip.tsx'
import { draftPermission, draftRead } from '../composer/permission.ts'
import { readOnSelect, readsOnPermission, useReading } from '../composer/harnessCatalogue.tsx'
import { draftConfig, withLadderMode, type ComposerChoice } from '../composerChoice.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { agentDefaultChoice, usesHostModels, withAgentDefaultChoice, type AgentDraft } from './model.ts'

/** The same controls as a new Code session, saved as defaults without writing to any existing topic. */
export function AgentDefaults({
  catalog,
  draft,
  access,
  disabled,
  onDraft,
  onRead,
  onManage,
}: {
  catalog: HostCatalog
  draft: AgentDraft
  access: DeviceAccess
  disabled: boolean
  onDraft(draft: AgentDraft): void
  onRead?: () => void | Promise<void>
  onManage?: () => void
}) {
  const harness = catalog.harnesses.find(item => item.id === draft.harnessId)
  const choice = agentDefaultChoice(catalog, draft)
  const reading = useReading(harness)
  const permission = draftPermission(
    harness,
    draft.mode,
    withLadderMode(harness, draftConfig(harness, choice.config)?.config, choice.config),
    draftRead(harness, access, reading),
  )
  const update = (patch: Partial<ComposerChoice>) => {
    if (!disabled) onDraft(withAgentDefaultChoice(catalog, draft, patch))
  }
  return (
    <>
      <dt>模型</dt>
      <dd>
        <DraftModelControl
          catalog={catalog}
          choice={choice}
          onChoice={update}
          access={access}
          disabled={disabled}
          onRead={onRead}
          onManageModels={onManage}
        />
      </dd>
      <dt>思考</dt>
      <dd>
        <DraftThinkingControl catalog={catalog} choice={choice} onChoice={update} access={access} disabled={disabled} onRead={onRead} />
      </dd>
      <dt>做事前</dt>
      <dd>
        {permission && (
          <PermissionChip
            view={
              disabled ? { ...permission, rows: permission.rows?.map(row => ({ ...row, disabledReason: '正在确认修改结果' })) } : permission
            }
            onChoose={(option, value) => update({ config: { ...choice.config, [option.id]: value } })}
            onOpenChange={open => {
              if (open && !disabled && readsOnPermission(harness, access)) readOnSelect(harness, onRead)
            }}
          />
        )}
      </dd>
      {(draft.model || draft.engineOptions) && (
        <dd>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              const { model: _model, engineOptions: _options, ...rest } = draft
              onDraft(rest)
            }}>
            {usesHostModels(harness) ? '用默认模型' : '用 Harness 默认'}
          </Button>
        </dd>
      )}
    </>
  )
}
