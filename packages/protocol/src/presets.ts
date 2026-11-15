import type { ProviderKind } from './types.ts'

/** Starting values for the provider form. Browser-safe: no credentials and no Node imports. */
export interface ProviderPreset {
  id: string
  name: string
  /** The protocol a new service starts with. */
  kind: ProviderKind
  /** The other protocols the same address speaks, offered in the form; absent when it speaks only `kind`. */
  otherKinds?: ProviderKind[]
  /** Empty for custom endpoints, which the user must fill in. */
  baseURL: string
  requiresKey: boolean
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai-responses',
    otherKinds: ['openai-compatible'],
    baseURL: 'https://api.openai.com/v1',
    requiresKey: true,
  },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseURL: 'https://api.anthropic.com', requiresKey: true },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', baseURL: 'https://api.deepseek.com/v1', requiresKey: true },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', requiresKey: true },
  { id: 'moonshot', name: 'Moonshot Kimi', kind: 'openai-compatible', baseURL: 'https://api.moonshot.cn/v1', requiresKey: true },
  { id: 'zhipu', name: '智谱 GLM', kind: 'openai-compatible', baseURL: 'https://open.bigmodel.cn/api/paas/v4', requiresKey: true },
  {
    id: 'dashscope',
    name: '阿里云百炼',
    kind: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    requiresKey: true,
  },
  { id: 'volcengine', name: '火山方舟', kind: 'openai-compatible', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', requiresKey: true },
  { id: 'siliconflow', name: '硅基流动', kind: 'openai-compatible', baseURL: 'https://api.siliconflow.cn/v1', requiresKey: true },
  { id: 'ollama', name: 'Ollama', kind: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1', requiresKey: false },
  { id: 'lmstudio', name: 'LM Studio', kind: 'openai-compatible', baseURL: 'http://127.0.0.1:1234/v1', requiresKey: false },
  {
    id: 'custom',
    name: '自定义服务',
    kind: 'openai-compatible',
    otherKinds: ['openai-responses', 'anthropic'],
    baseURL: '',
    requiresKey: false,
  },
]
