import type { ModelRef, ProviderKind, SessionConfigOption } from '@latch/protocol'
import type { Brief } from '../core/securityCopy.ts'
import type { ConfigUnknownState } from './Composer.tsx'
import { currentShell } from '../core/shell.ts'
import { COMPOSER_CONTROLS, shortcutCaps, shortcutKeys, type ComposerControl } from '../workbenchShortcuts.ts'

export interface SessionConfigFeedback {
  kind: 'failed' | 'unknown'
  message: string
  /** The option the change was for: only its control says 结果未知. Older feedback names none and marks every control. */
  configId?: string
  /** What was asked for, in the Harness's own name for the value. */
  valueName?: string
  /** When the change was sent (ms). */
  at?: number
  /** 核对 is asking the Host. */
  checking?: boolean
  /** 核对 could not settle it in a way that may not change on its own: 放弃这次结果 is offered. */
  abandonable?: boolean
}

/** Whether this feedback belongs to a control showing these options. */
export function feedbackFor(feedback: SessionConfigFeedback | undefined, ids: readonly (string | undefined)[]): boolean {
  if (!feedback) return false
  return feedback.configId === undefined || ids.includes(feedback.configId)
}

export const CONFIG_UNKNOWN_REASON = '上次切换的结果未知，请先核对。'

/** The bar above the input while the open session's config change is unknown. */
export function configUnknownBar(
  feedback: SessionConfigFeedback | undefined,
  harness: string,
  check: () => Promise<void>,
  retry: () => Promise<void>,
  abandon?: () => void,
): ConfigUnknownState | undefined {
  if (feedback?.kind !== 'unknown' || feedback.at === undefined || feedback.valueName === undefined) return undefined
  return {
    what: feedback.valueName,
    harness,
    at: feedback.at,
    checking: feedback.checking === true,
    onCheck: () => {
      void check()
    },
    onRetry: () => {
      void retry()
    },
    ...(feedback.abandonable && abandon ? { onAbandon: abandon } : {}),
  }
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

/**
 * The model menu's few words on a model the Harness has not told Latch of. Nothing when it reported one, and nothing
 * before a start: the menu then shows what will be used, 默认模型.
 */
export function unreportedModelNote(harness: string, started: boolean, config: readonly SessionConfigOption[]): string | undefined {
  if (!started) return undefined
  return config.some(option => option.category === 'model') ? undefined : `由 ${harness} 决定`
}

/** A Harness that reports levels for every model that has them reported none for this one. */
export const NO_THINKING_LEVELS = '这个模型没有思考档位'

/**
 * The thinking menu's few words on levels the Harness has not told Latch of. Nothing when it reported them, and nothing
 * before a start: the menu then shows what will be used, 默认. `perModel`: the Harness reports them for every model that
 * has them (`models.thinkingPerModel`), so none means the model has none.
 */
export function unreportedThinkingNote(
  harness: string,
  started: boolean,
  config: readonly SessionConfigOption[],
  perModel = false,
): string | undefined {
  if (!started) return undefined
  if (config.some(option => option.category === 'thought_level')) return undefined
  return perModel && config.some(option => option.category === 'model') ? NO_THINKING_LEVELS : `用 ${harness} 的默认值`
}

/** On a model of a service with no level declared or reported: 默认 is the service's own, as the trigger's hover says. */
export const SERVICE_DEFAULT_HINT = '用模型服务的默认值'

/** On the built-in Harness, for a model with no thinking levels declared in settings. */
export const BUILTIN_THINKING_NOTE: Brief = { label: '用模型默认值', detail: '可以在 设置 › 模型 里为它选择。' }

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
 * `reasoning.effort` for Responses and `output_config.effort` for the Messages API. Which one a model takes is the service's to say, so nothing is preselected.
 */
export const THINKING_SETS: Readonly<Record<ProviderKind, ReadonlyArray<readonly string[]>>> = {
  'openai-compatible': OPENAI_SETS,
  'openai-responses': OPENAI_SETS,
  anthropic: [
    ['low', 'medium', 'high'],
    ['low', 'medium', 'high', 'max'],
    ['low', 'medium', 'high', 'xhigh', 'max'],
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

/** The name of the model a Harness reported among its options, as its model menu shows it. */
export function ownModelName(config: readonly SessionConfigOption[] | undefined): string | undefined {
  const option = config?.find(item => item.category === 'model')
  return option ? agentConfigLabel(option) : undefined
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
  return option && (option.currentValue !== value || option.source === 'launch') && option.options.some(item => item.value === value)
    ? { configId, value }
    : undefined
}

/**
 * The keys that open one of the composer's four controls, as its menu's title shows them: only in the desktop app,
 * whose keys are settled; a browser's are not drawn (J14).
 */
export function controlKeyCaps(control: ComposerControl): string[] | undefined {
  if (currentShell() === null) return undefined
  const keys = shortcutKeys('controls', true)
  const first = keys === null ? undefined : shortcutCaps(keys)[0]
  if (!first?.caps.length) return undefined
  return [...first.caps.slice(0, -1), String(COMPOSER_CONTROLS.indexOf(control) + 1)]
}
