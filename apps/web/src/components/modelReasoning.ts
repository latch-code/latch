import type { SessionConfigOption } from '@latch/protocol'

export interface SessionConfigFeedback {
  kind: 'failed' | 'unknown'
  message: string
}

export interface AgentConfigState {
  busy: string | null
  disabled?: boolean
  feedback?: SessionConfigFeedback
}

/** Categories are Agent-provided semantic metadata; IDs and model names cannot establish a reasoning capability. */
export function agentModelControls(config: readonly SessionConfigOption[]): {
  primary?: SessionConfigOption
  related: SessionConfigOption[]
} {
  const primary = config.find(option => option.category === 'model') ?? config.find(option => option.category === 'thought_level')
  return {
    ...(primary ? { primary } : {}),
    related: primary
      ? config.filter(option => option.id !== primary.id && (option.category === 'thought_level' || option.category === 'model_config'))
      : [],
  }
}

/** Keep the Agent's order and wire values, with only duplicate IDs removed for an unambiguous control. */
export function agentConfigValues(option: SessionConfigOption): SessionConfigOption['options'] {
  const seen = new Set<string>()
  return option.options.filter(item => {
    if (seen.has(item.value)) return false
    seen.add(item.value)
    return true
  })
}

export function agentConfigLabel(option: SessionConfigOption): string {
  return option.options.find(item => item.value === option.currentValue)?.name ?? option.currentValue
}

export function agentConfigBlocked(state: AgentConfigState): boolean {
  return state.disabled === true || state.busy !== null || state.feedback?.kind === 'unknown'
}

/** A choice is an intent, never an optimistic update of the authoritative value. */
export function agentConfigChoice(
  config: readonly SessionConfigOption[],
  configId: string,
  value: string,
  state: AgentConfigState,
): { configId: string; value: string } | undefined {
  if (agentConfigBlocked(state)) return undefined
  const option = config.find(item => item.id === configId)
  return option && option.currentValue !== value && option.options.some(item => item.value === value) ? { configId, value } : undefined
}
