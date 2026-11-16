import type { HostCatalog } from '@latch/protocol'
import { Button } from '@latch/ui'
import { DraftModelControl, DraftThinkingControl, SessionModelControl, SessionThinkingControl } from '../composer/ModelPanel.tsx'
import { ConfigFeedback } from '../composer/ThinkingControl.tsx'
import { PermissionChip } from '../composer/PermissionChip.tsx'
import { draftPermission, draftRead, permissionView } from '../composer/permission.ts'
import { readOnSelect, readsOnPermission, useReading } from '../composer/harnessCatalogue.tsx'
import { draftConfig, withLadderMode, type ComposerChoice } from '../composerChoice.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { isPersonalChat, topicOwner } from './chat.ts'
import { agentDefaultChoice, usesHostModels, withAgentDefaultChoice, type AgentDraft } from './model.ts'
import { DEVICE_OFFLINE } from '../core/hostState.ts'

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
        <DraftThinkingControl
          catalog={catalog}
          choice={choice}
          onChoice={update}
          access={access}
          disabled={disabled}
          onRead={onRead}
          onManageModels={onManage}
        />
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

/** Live options for the currently bound external Harness, with the same receipts as Code. */
export function CurrentAgentOptions({ shell, owner }: { shell: ShellState; owner: string }) {
  const { current, catalog, harnessInfo, access } = shell
  if (
    !current
    || !catalog
    || harnessInfo?.level !== 'L3'
    || topicOwner(current.summary) !== owner
    || !isPersonalChat(shell.snapshot, current.summary)
  )
    return null
  const id = current.summary.id
  const busy = shell.configBusy.get(id) ?? null
  const feedback = shell.configFeedback.get(id)
  const config = current.config ?? []
  if (!config.length && !feedback) return null
  const locked = !access.scopes.has('run')
    ? '这台设备只能查看'
    : shell.connection === 'offline'
      ? DEVICE_OFFLINE
      : shell.active
        ? '这一轮结束后可用'
        : busy
          ? '正在确认会话选项'
          : undefined
  const permission = permissionView({
    harness: harnessInfo,
    mode: current.summary.mode,
    permission: current.permission,
    config,
    access,
    ...(locked ? { locked } : {}),
  })
  const options = {
    catalog,
    harness: harnessInfo,
    model: shell.effectiveModel,
    current: shell.currentModel,
    config,
    busy,
    ...(feedback ? { feedback } : {}),
    ...(locked ? { locked } : {}),
    onModel: (model: ShellState['effectiveModel']) => shell.submission.setOverride(id, model),
    onConfig: shell.setConfig,
    onRefresh: shell.refreshConfig,
  }
  return (
    <section className="agent-form-section" aria-label="当前聊天">
      <header>
        <h3>当前聊天</h3>
      </header>
      {config.length > 0 && (
        <div className="agent-current-options">
          <SessionModelControl {...options} reported={current.summary.model} route={current.summary.modelRoute} />
          <SessionThinkingControl {...options} reported={current.summary.model} route={current.summary.modelRoute} />
          {permission?.option && (
            <PermissionChip
              view={permission}
              onChoose={(option, value) => {
                void shell.setConfig(option.id, value)
              }}
            />
          )}
        </div>
      )}
      {feedback && <ConfigFeedback feedback={feedback} onRefresh={shell.refreshConfig} />}
    </section>
  )
}
