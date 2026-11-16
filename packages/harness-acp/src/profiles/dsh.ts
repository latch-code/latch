import { bareVersion } from '../version-line.ts'
import type { HarnessProfile } from './types.ts'
import { DSH_MODES, prepareDshMode, readDshMode } from './dsh-mode.ts'
import { pairedModels } from './gateway-model.ts'

const GATEWAY_PROVIDER = 'latch-gateway'
const GATEWAY_MODELS = pairedModels(GATEWAY_PROVIDER)
const GATEWAY_PATCH = 'dsh-gateway.patch.json'
const API = {
  'chat-completions': 'openai-completions',
  responses: 'openai-responses',
  'anthropic-messages': 'anthropic-messages',
} as const

const MINIMUM_VERSION = {
  args: ['--version'],
  read: bareVersion,
  minimum: '0.2.2-rc.1',
  upgrade: 'npm i -g @deepseek-ai/dsh@latest',
}

export const dshProfile: HarnessProfile = {
  presetId: 'dsh',
  version: 4,
  processMode: { prepare: prepareDshMode, read: readDshMode },
  // dsh-acp offers `reasoning_effort` when the exact model declares one (its README).
  thinkingPerModel: true,
  // An empty session runs no turn and calls no model.
  catalogueRead: { when: 'select' },
  gateway: {
    via: 'launch',
    wires: ['chat-completions', 'responses', 'anthropic-messages'],
    tokenEnv: 'LMG_TOKEN',
    envNames: [],
    templates: { args: 1, files: 1 },
    models: GATEWAY_MODELS,
    minimumVersion: MINIMUM_VERSION,
    // ACP reports the application's hard-coded 0.0.1, not the dsh release version.
    commandVersionOnly: true,
    deliver(place, route) {
      const provider = GATEWAY_PROVIDER
      const selection = { provider, model: route.model }
      const patch = [
        {
          id: 'llm-pi-ai',
          config: {
            providers: {
              [provider]: {
                displayName: 'Latch',
                apiKeyEnv: 'LMG_TOKEN',
                api: API[route.wire],
                baseURL: place.baseURL,
                retryPolicy: { mode: 'normal', maxRetries: 0 },
                models: place.models.map(({ id, capabilities }) => ({
                  id,
                  name: id,
                  input: capabilities?.vision ? ['text', 'image'] : ['text'],
                  // llm-pi-ai's own model field; without it the provider's `defaultContextWindow` (1,000,000) applies.
                  ...(capabilities?.contextTokens ? { contextWindow: capabilities.contextTokens } : {}),
                  reasoningEfforts: capabilities?.thinking?.length
                    ? Object.fromEntries(capabilities.thinking.map(level => [level, level === 'off' ? null : level]))
                    : false,
                })),
              },
            },
          },
        },
        { id: 'acp', config: selection },
        { id: 'agent-default-model', config: selection },
        { id: 'session-log-deepseek', disabled: true },
        { id: 'plugin-package-inventory-deepseek', disabled: true },
      ]
      return { args: ['--patch', place.file(GATEWAY_PATCH)], files: { [GATEWAY_PATCH]: `${JSON.stringify(patch, null, 2)}\n` } }
    },
  },
  permission: {
    approvals: 'prompts',
    // DeepSeek Harness takes any non-empty DSH_TELEMETRY_DISABLED as off.
    defaultEnv: { DSH_PERMISSION_MODE: 'read-only', DSH_TELEMETRY_DISABLED: '1' },
    expectedMode: 'read-only',
    modeLadder: [...DSH_MODES],
    modeTiers: {
      'read-only': { tier: 'plan', line: '只读，不改文件' },
      'workspace-write': { tier: 'rule', line: '直接写工作目录与允许的临时目录；扩大范围前问你' },
      'danger-full-access': { tier: 'never', line: '直接改文件和运行命令' },
    },
    readback: 'mode',
    inheritEnv: ['DSH_HOME'],
    notes: ['Latch 的私有插件通过 DeepSeek Harness 的权限服务设置和读回档位；空闲时换档会重启并恢复会话'],
  },
  // DeepSeek Harness refuses additionalDirectories and keeps to the session directory.
  folderAccess: 'primary',
  // `dsh --version` prints the bare version. Before 0.1.2 there is no `acp` profile: `dsh --profile acp` exits with
  // "profile does not exist", or a profile of that name made by hand boots something that never answers ACP. Until
  // 0.2.1-rc.1, @deepseek-ai/dsh-acp settled a prompt when the root agent went idle, with subagents still running, and a
  // cancel did not wait for them (its README of 0.2.0-rc.2 and 0.2.1-rc.1); a stop then is not a real settlement.
  minimumVersion: MINIMUM_VERSION,
}
