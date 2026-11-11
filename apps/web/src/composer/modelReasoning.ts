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

/**
 * Categories are Agent-provided semantic metadata; IDs and model names cannot establish a reasoning capability. The model
 * and thinking are separate controls, each taking the first option of its category; the model's menu holds the other
 * model settings.
 */
export function agentModelControls(config: readonly SessionConfigOption[]): {
  model?: SessionConfigOption
  thinking?: SessionConfigOption
  related: SessionConfigOption[]
} {
  const model = config.find(option => option.category === 'model')
  const thinking = config.find(option => option.category === 'thought_level')
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    // With neither reported, the model's other settings stay under the composer's 「⋯」.
    related: model || thinking ? config.filter(option => option.category === 'model_config') : [],
  }
}

export const DEFAULT_MODEL = '默认模型'
/** The thinking control's value when no level is chosen or none was reported: the model's own default. */
export const DEFAULT_LEVEL = '默认'

/** The model menu's one sentence on a model the Harness has not told Latch of. Nothing when it reported one. */
export function unreportedModelNote(harness: string, started: boolean, config: readonly SessionConfigOption[]): string | undefined {
  if (!started) return `${harness} 开始后才报告可选的模型，发第一条消息后可以在这里换。`
  return config.some(option => option.category === 'model') ? undefined : `${harness} 没有报告可选的模型，由它自己决定。`
}

/** The thinking menu's one sentence on levels the Harness has not told Latch of. Nothing when it reported them. */
export function unreportedThinkingNote(harness: string, started: boolean, config: readonly SessionConfigOption[]): string | undefined {
  if (!started) return `${harness} 开始后才报告有哪些思考，发第一条消息后可以在这里换。`
  return config.some(option => option.category === 'thought_level') ? undefined : `${harness} 没有报告思考，用它自己的默认值。`
}

/** A draft picked a model no session has run on yet, so what thinking it offers is not known. */
export const THINKING_AFTER_START = (harness: string) => `这个模型有哪些思考，${harness} 开始后才告诉 Latch。`

/** On the built-in Harness, for a model with no thinking levels declared in settings. */
export const BUILTIN_THINKING_NOTE = '这个模型没有设置思考，用它自己的默认值。可以在 设置 › 模型 里为它选择。'

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

const OPENAI_SETS = [
  ['low', 'medium', 'high'],
  ['minimal', 'low', 'medium', 'high'],
  ['none', 'low', 'medium', 'high', 'xhigh'],
] as const

/**
 * The level sets offered when declaring what a model accepts, by protocol: `reasoning_effort` for Chat Completions,
 * `reasoning.effort` for Responses, `output_config.effort` for the Messages API and `thinkingLevel` for Gemini 3 and
 * later. Which one a model takes is the service's to say, so nothing is preselected.
 */
export const THINKING_SETS: Readonly<Record<ProviderKind, ReadonlyArray<readonly string[]>>> = {
  'openai-compatible': OPENAI_SETS,
  'openai-responses': OPENAI_SETS,
  anthropic: [
    ['low', 'medium', 'high'],
    ['low', 'medium', 'high', 'max'],
    ['low', 'medium', 'high', 'xhigh', 'max'],
  ],
  gemini: [
    ['low', 'high'],
    ['minimal', 'low', 'medium', 'high'],
  ],
}

/** A built-in model with its thinking level, as the switch notice says it. */
export const modelWords = (model: ModelRef): string => (model.effort ? `${model.model} · ${thinkingWord(model.effort)}` : model.model)

/** The same model of the same service, whatever level of thinking goes with it. */
export const sameModelId = (a: ModelRef | undefined, b: ModelRef | undefined): boolean =>
  a?.providerId === b?.providerId && a?.model === b?.model

/** Undoing a built-in switch that applies from the next message, in the model's and the thinking's menu alike. */
export const resetModelLabel = (current: ModelRef | undefined) => (current ? `撤销切换，继续使用 ${modelWords(current)}` : '撤销切换')

export const thinkingSetText = (levels: readonly string[]): string => levels.map(thinkingWord).join(' · ')

/**
 * What the composer's 「⋯」 holds: every option no other control shows, so one the Latch does not recognise stays
 * reachable. An agent's model control already holds its related options, the thinking control its level and the 权限
 * chip the mode.
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
