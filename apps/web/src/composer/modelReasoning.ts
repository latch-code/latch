import type { ModelRef, ProviderKind, SessionConfigOption } from '@latch/protocol'

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

export const DEFAULT_MODEL = '默认模型'
export const DEFAULT_THINKING = '默认思考'

/** The model control's label: both facts, always, with the words for a value the Harness has not told Latch. */
export const modelChipText = (model: string | undefined, thinking: string | undefined): string =>
  `${model ?? DEFAULT_MODEL} · ${thinking ?? DEFAULT_THINKING}`

/** The model control's one sentence on a value the Harness has not told Latch. Nothing when it reported both. */
export function unreportedNote(harness: string, started: boolean, config: readonly SessionConfigOption[]): string | undefined {
  if (!started) return `${harness} 开始后才报告模型和思考深度，发第一条消息后可以在这里换。`
  const model = config.some(option => option.category === 'model')
  const thinking = config.some(option => option.category === 'thought_level')
  if (model && thinking) return undefined
  if (!model && !thinking) return `${harness} 没有报告模型和思考深度，由它自己决定。`
  return model ? `${harness} 没有报告思考深度，用它自己的默认值。` : `${harness} 没有报告可选的模型，由它自己决定。`
}

/** A draft picked a model no session has run on yet, so what thinking it offers is not known. */
export const THINKING_AFTER_START = (harness: string) => `这个模型有哪些思考深度，${harness} 开始后才告诉 Latch。`

/** On the built-in Harness, for a model with no thinking levels declared in settings. */
export const BUILTIN_THINKING_NOTE = '这个模型没有设置思考深度，用它自己的默认值。可以在 设置 › 模型 里为它选择。'

const THINKING_WORDS: Readonly<Record<string, string>> = {
  none: '不思考',
  minimal: '最少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
}

/** A thinking level in words; a level Latch has no word for shows as sent. */
export const thinkingWord = (level: string): string => THINKING_WORDS[level] ?? level

/**
 * The level sets offered when declaring what a model accepts, by protocol: `reasoning_effort` for Chat Completions,
 * `output_config.effort` for the Messages API. Which one a model takes is the service's to say, so nothing is preselected.
 */
export const THINKING_SETS: Readonly<Record<ProviderKind, ReadonlyArray<readonly string[]>>> = {
  'openai-compatible': [
    ['low', 'medium', 'high'],
    ['minimal', 'low', 'medium', 'high'],
    ['none', 'low', 'medium', 'high', 'xhigh'],
  ],
  anthropic: [
    ['low', 'medium', 'high'],
    ['low', 'medium', 'high', 'max'],
    ['low', 'medium', 'high', 'xhigh', 'max'],
  ],
}

/** A built-in model with its thinking level, as the chip and the switch notice say it. */
export const modelWords = (model: ModelRef): string => (model.effort ? `${model.model} · ${thinkingWord(model.effort)}` : model.model)

export const thinkingSetText = (levels: readonly string[]): string => levels.map(thinkingWord).join(' · ')

/**
 * What the composer's 「⋯」 holds: every option no other control shows, so one the Latch does not recognise stays
 * reachable. An agent's model control already holds its related options, and the 权限 chip the mode.
 */
export function composerOptions(config: readonly SessionConfigOption[], hostModels: boolean): SessionConfigOption[] {
  const held = hostModels ? [] : agentModelControls(config).related
  return config.filter(
    option =>
      !held.includes(option)
      && option.category !== 'model'
      && option.category !== 'thought_level'
      && option.category !== 'mode'
      && option.id !== 'mode',
  )
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
