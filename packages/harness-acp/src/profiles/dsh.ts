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

/**
 * The output cap and compaction headroom for a model whose window the service declared. dsh-compaction-basic starts at
 * `floor(min(W × 0.8, W − O − headroomTokens))`, where O is the request's output cap: the model's `maxTokens`, else
 * llm-pi-ai's `defaultMaxTokens` of 128,000, and headroom defaults to 65,536 (its README, "Tuning when condensation
 * starts"). Left alone, a 64,000 window never compacts and a 200,000 one compacts above 6,464 tokens. A quarter of the
 * window for output (at most 32,768) and an eighth for headroom (at most the default) start it at 62.5% of a 64,000 or
 * 128,000 window, 71% of 200,000 and 80% of 1,000,000.
 */
export function dshWindowBudget(window: number): { maxTokens: number; headroomTokens: number } {
  return { maxTokens: Math.min(32_768, Math.floor(window / 4)), headroomTokens: Math.min(65_536, Math.floor(window / 8)) }
}

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
  // dsh has no way to delete a session, and even the empty one of a list read is written to its history.
  removesOwnSessions: true,
  // dsh-acp offers `reasoning_effort` when the exact model declares one (its README).
  thinkingPerModel: true,
  // An empty session runs no turn and calls no model.
  catalogueRead: { when: 'select' },
  gateway: {
    via: 'launch',
    wires: ['chat-completions', 'responses', 'anthropic-messages'],
    tokenEnv: 'LMG_TOKEN',
    envNames: [],
    templates: { args: 1, files: 3 },
    models: GATEWAY_MODELS,
    minimumVersion: MINIMUM_VERSION,
    // ACP reports the application's hard-coded 0.0.1, not the dsh release version.
    commandVersionOnly: true,
    deliver(place, route) {
      const provider = GATEWAY_PROVIDER
      const selection = { provider, model: route.model }
      // Each plugin the route needs says `disabled: false`: a layer that only sets `config` leaves a plugin the person
      // disabled in their own `cordis.patch.yml` disabled (seen with `--dump-config` on 0.2.2-rc.1).
      const patch = [
        {
          id: 'llm-pi-ai',
          disabled: false,
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
                  // llm-pi-ai's own model fields; without them the provider's `defaultContextWindow` (1,000,000) and
                  // `defaultMaxTokens` (128,000) apply.
                  ...(capabilities?.contextTokens
                    ? { contextWindow: capabilities.contextTokens, maxTokens: dshWindowBudget(capabilities.contextTokens).maxTokens }
                    : {}),
                  reasoningEfforts: capabilities?.thinking?.length
                    ? Object.fromEntries(capabilities.thinking.map(level => [level, level === 'off' ? null : level]))
                    : false,
                })),
              },
            },
          },
        },
        {
          id: 'compaction-basic',
          disabled: false,
          config: {
            modelPolicies: place.models.flatMap(({ id, capabilities }) =>
              capabilities?.contextTokens
                ? [{ provider, model: id, headroomTokens: dshWindowBudget(capabilities.contextTokens).headroomTokens }]
                : [],
            ),
          },
        },
        { id: 'acp', disabled: false, config: selection },
        { id: 'agent-default-model', disabled: false, config: selection },
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
