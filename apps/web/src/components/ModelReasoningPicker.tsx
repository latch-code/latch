import type { ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import type { SessionConfigOption } from '@latch/protocol'
import { Button, Icon, InlineNotice, ValuePicker, useLayerClose } from '@latch/ui'
import { escapeHiddenCharacters, VisibleText } from './VisibleText.tsx'
import {
  agentConfigBlocked,
  agentConfigChoice,
  agentConfigLabel,
  agentConfigValues,
  agentModelControls,
  type AgentConfigState,
} from './modelReasoning.ts'

export interface ModelReasoningPickerProps extends AgentConfigState {
  config: readonly SessionConfigOption[]
  identity?: ReactNode
  onChange: (configId: string, value: string) => void | Promise<void>
  /** Read authoritative state after an unknown result; it must not issue a different configuration write. */
  onRefresh?: () => void | Promise<void>
}

function RefreshConfig({ refresh }: { refresh: () => void | Promise<void> }) {
  const close = useLayerClose()
  return (
    <Button
      size="xs"
      onClick={() => {
        void Promise.resolve(refresh())
          .then(close)
          .catch(() => {})
      }}>
      刷新当前设置
    </Button>
  )
}

/** Actual Agent model options, with only explicitly categorized reasoning and model parameters nearby. */
export function ModelReasoningPicker(props: ModelReasoningPickerProps) {
  const { primary, related } = agentModelControls(props.config)
  if (!primary) return null
  const thought = related.find(option => option.category === 'thought_level')
  const current = agentConfigLabel(primary)
  const shown = primary.category === 'model' && thought ? `${current} · ${agentConfigLabel(thought)}` : current
  const blocked = agentConfigBlocked(props)
  const reason =
    props.feedback?.kind === 'unknown'
      ? '上次切换的结果未知，请先刷新当前设置。'
      : props.busy !== null
        ? '正在切换，请稍后。'
        : props.disabled
          ? '当前不能修改会话设置'
          : undefined
  const choose = (id: string, value: string) => {
    const intent = agentConfigChoice(props.config, id, value, props)
    if (intent) return props.onChange(intent.configId, intent.value)
  }
  const values = (option: SessionConfigOption) =>
    agentConfigValues(option).map(item => ({
      value: item.value,
      label: escapeHiddenCharacters(item.name),
      description: item.description ? escapeHiddenCharacters(item.description) : undefined,
      ...(blocked ? { disabledReason: reason ?? '当前不能修改会话设置' } : {}),
    }))
  return (
    <ValuePicker
      label={escapeHiddenCharacters(primary.name)}
      value={primary.currentValue}
      valueText={escapeHiddenCharacters(props.feedback?.kind === 'unknown' ? `${shown} · 结果未知` : shown)}
      options={values(primary)}
      leading={props.identity ?? <Icon icon={Sparkles} size={16} />}
      className="model-picker"
      searchable={primary.options.length > 8}
      header={
        primary.description ? { title: escapeHiddenCharacters(primary.name), meta: escapeHiddenCharacters(primary.description) } : undefined
      }
      pending={props.busy !== null}
      pendingLabel="正在切换…"
      onValueChange={value => choose(primary.id, value)}
      footer={
        related.length || props.feedback ? (
          <div className="setup-panel">
            <div className="setup-panel-body">
              {related.map(option => (
                <div key={option.id}>
                  <ValuePicker
                    variant="row"
                    label={escapeHiddenCharacters(option.name)}
                    value={option.currentValue}
                    options={values(option)}
                    disabled={blocked}
                    disabledReason={reason}
                    searchable={option.options.length > 8}
                    onValueChange={value => choose(option.id, value)}
                  />
                  {option.description && (
                    <p className="setup-panel-caption">
                      <VisibleText text={option.description} />
                    </p>
                  )}
                </div>
              ))}
              {props.feedback && (
                <InlineNotice
                  tone={props.feedback.kind === 'unknown' ? 'warn' : 'error'}
                  action={props.feedback.kind === 'unknown' && props.onRefresh ? <RefreshConfig refresh={props.onRefresh} /> : undefined}>
                  <VisibleText text={props.feedback.message} />
                </InlineNotice>
              )}
            </div>
          </div>
        ) : undefined
      }
    />
  )
}
