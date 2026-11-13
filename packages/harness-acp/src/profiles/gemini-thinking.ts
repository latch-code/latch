import type { SessionConfigOption } from '@latch/protocol'

export const GEMINI_THINKING = '~gemini-thinking'
export interface LaunchThinking {
  model: string
  value: string
}

/** Explicitly documented families only. An alias or an unknown model cannot inherit another model's thinking limits. */
function choices(model: string): readonly string[] | undefined {
  if (/^gemini-(?:3-flash|3\.1-flash-lite)(?:-preview)?$/u.test(model)) return ['minimal', 'low', 'medium', 'high']
  if (/^gemini-3\.1-pro(?:-preview)?$/u.test(model)) return ['low', 'medium', 'high']
  if (/^gemini-3-pro(?:-preview)?$/u.test(model)) return ['low', 'high']
  if (model === 'gemini-2.5-pro') return ['-1', '128', '1024', '8192', '32768']
  if (model === 'gemini-2.5-flash' || model === 'gemini-2.5-flash-lite') return ['-1', '0', '1024', '8192', '24576']
  return undefined
}

/** A launch setting owned by Latch, explicitly distinct from an effective value reported by Gemini's ACP server. */
export function geminiThinkingOption(model: string | undefined, selected?: LaunchThinking): SessionConfigOption | undefined {
  const values = model && choices(model)
  if (!values) return undefined
  const names: Record<string, string> = { minimal: '最低', low: '低', medium: '中', high: '高', '-1': '自动', '0': '关闭' }
  const value = selected?.model === model && values.includes(selected.value) ? selected.value : 'default'
  return {
    id: GEMINI_THINKING,
    name: '思考',
    category: 'thought_level',
    source: 'launch',
    currentValue: value,
    description: 'Latch 启动设置；Gemini CLI 不独立报告有效值',
    options: [{ value: 'default', name: 'Gemini CLI 默认' }, ...values.map(value => ({ value, name: names[value] ?? `${value} tokens` }))],
  }
}

/** Only this exact model alias changes. Other models, helpers, tools and the person's files remain the CLI's own. */
export function geminiThinkingSettings(selected: LaunchThinking | undefined): Record<string, unknown> {
  if (!selected || selected.value === 'default') return {}
  const levels = choices(selected.model)
  if (!levels?.includes(selected.value)) throw new Error('Unsupported Gemini thinking choice for this model')
  const budget = selected.model.startsWith('gemini-2.5-')
  const thinkingConfig = budget ? { thinkingBudget: Number(selected.value) } : { thinkingLevel: selected.value.toUpperCase() }
  return {
    modelConfigs: {
      customAliases: {
        [selected.model]: {
          extends: budget ? 'chat-base-2.5' : 'chat-base-3',
          modelConfig: { model: selected.model, generateContentConfig: { thinkingConfig } },
        },
      },
    },
  }
}
