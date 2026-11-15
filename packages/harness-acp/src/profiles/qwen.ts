import type { ModelWire } from '@latch/protocol'
import { bareVersion } from '../version-line.ts'
import type { GatewayModelValues, HarnessProfile } from './types.ts'

const GATEWAY_SETTINGS = 'qwen-system-settings.json'

/**
 * The `modelProviders` key, which is also Qwen Code's auth type, that speaks each protocol Latch points it at; `openai`
 * covers two. Its `gemini` list is not used.
 */
type QwenWire = 'chat-completions' | 'responses' | 'anthropic-messages'
const AUTH_TYPES: Record<QwenWire, 'openai' | 'anthropic'> = {
  'chat-completions': 'openai',
  responses: 'openai',
  'anthropic-messages': 'anthropic',
}
const authOf = (wire: ModelWire | undefined): 'openai' | 'anthropic' | undefined =>
  wire === undefined ? undefined : (AUTH_TYPES as Partial<Record<ModelWire, 'openai' | 'anthropic'>>)[wire]
/**
 * The protocol a model's value names: an entry with `wireApi: "responses"` is listed under its effective protocol,
 * `openai-responses`, though it sits in the `openai` list (docs `model-providers.md`; seen in a real run of 0.26.8).
 */
const listedAs = (wire: ModelWire | undefined): string | undefined => (wire === 'responses' ? 'openai-responses' : authOf(wire))

/**
 * Qwen Code's ACP names a model `<id>(<auth type>)` while that pair is unique among its routes, and by an opaque route
 * ID otherwise. Only the exact first form of the route's own auth type is a service model, and only when Qwen Code
 * reports it: an ID it lists another way is not offered.
 */
const GATEWAY_MODELS: GatewayModelValues = {
  value: (id, wire) => `${id}(${listedAs(wire) ?? 'openai'})`,
  id(value, wire) {
    const listed = listedAs(wire)
    if (!listed) return undefined
    const suffix = `(${listed})`
    return value.endsWith(suffix) && value.length > suffix.length ? value.slice(0, -suffix.length) : undefined
  },
  reportedOnly: true,
}

/** Every `modelProviders` key Qwen Code routes by itself, the legacy Responses one among them (`settingsSchema.ts`). */
const BUILT_IN_PROVIDERS = ['openai', 'anthropic', 'gemini', 'vertex-ai', 'openai-responses'] as const

/**
 * Through the gateway: a system settings file of the session's own, merged last, over the person's and the project's
 * settings (0.26.8 and 0.27.3 `packages/cli/src/config/settings.ts`, `mergeSettings`). A list under a `modelProviders` key
 * replaces the person's list of that key, an empty one too (`utils/deepMerge.ts`: no merge strategy applies below
 * `modelProviders`), so every built-in key is written: the route's with the service's models, each naming the variable
 * its key is read from, the others empty. An entry's own `baseUrl` and `envKey` come before the environment
 * (`core/src/models/modelConfigResolver.ts`), so a project `.env` cannot move one.
 *
 * What cannot be emptied this way are provider IDs of the person's own (mapped by their `providerProtocol`) and Qwen
 * Code's built-in OAuth models, so whatever could pick one for part of a turn is switched off instead: the models of
 * its side calls and fallbacks are cleared, no model grade is allowed (`agents.allowedGrades`), and the Agent tool is
 * denied, since a subagent's own file may name any model (`core/src/subagents/subagent-manager.ts`).
 */
function routedSettings(baseUrl: string, wire: ModelWire, model: string, models: ReadonlyArray<{ id: string; vision: boolean }>): unknown {
  const auth = authOf(wire)
  if (!auth) throw new Error(`Qwen Code is not pointed at ${wire}`)
  return {
    security: { auth: { selectedType: auth } },
    // `baseUrl` here is what its model picker stores to tell entries of one ID apart; the person's must not pick for it.
    model: { name: model, baseUrl },
    modelProviders: {
      ...Object.fromEntries(BUILT_IN_PROVIDERS.map(key => [key, []])),
      [auth]: models.map(({ id, vision }) => ({
        id,
        name: id,
        baseUrl,
        envKey: 'LMG_TOKEN',
        ...(auth === 'openai' ? { wireApi: wire === 'responses' ? 'responses' : 'chat-completions' } : {}),
        ...(vision ? { generationConfig: { modalities: { image: true } } } : {}),
      })),
    },
    fastModel: '',
    visionModel: '',
    compactionModel: '',
    advisorModel: '',
    imageModel: '',
    voiceModel: '',
    modelFallbacks: '',
    // An empty whitelist leaves the Agent tool no grade (`getAvailableModelGrades`); the map itself only merges.
    agents: { builtin: { exploreModel: 'inherit' }, allowedGrades: [] },
    // Deny rules of every scope are joined, so the person's settings cannot take this one back.
    permissions: { deny: ['Agent'] },
  }
}

export const qwenProfile: HarnessProfile = {
  presetId: 'qwen',
  // 2: a model choice is marked as the session's alone, and a session on a model service gets private system settings
  // that leave it no subagents.
  version: 2,
  // Its `session/set_config_option` already keeps a model choice to the session; this says so wherever it reads it.
  modelSetMeta: { 'qwen.session.modelPersistDefault': false },
  // Read in the sources of 0.26.8 and 0.27.3: per-model `wireApi`, `envKey` and the session-only model choice over ACP.
  gateway: {
    via: 'launch',
    wires: ['chat-completions', 'responses', 'anthropic-messages'],
    // Wired from its source and documentation; no real Qwen Code has run through it.
    experimental: true,
    tokenEnv: 'LMG_TOKEN',
    // Its child environment drops only Qwen Code's own internal tokens (`sanitize-child-env.ts`).
    credentialInherited: true,
    envNames: ['QWEN_CODE_SYSTEM_SETTINGS_PATH'],
    templates: { files: 1 },
    models: GATEWAY_MODELS,
    minimumVersion: { args: ['--version'], read: bareVersion, minimum: '0.26.8', upgrade: 'npm i -g @qwen-code/qwen-code@latest' },
    deliver(place, route) {
      const settings = routedSettings(
        place.baseURL,
        route.wire,
        route.model,
        place.models.map(({ id, capabilities }) => ({ id, vision: capabilities?.vision === true })),
      )
      return {
        env: { QWEN_CODE_SYSTEM_SETTINGS_PATH: place.file(GATEWAY_SETTINGS) },
        files: { [GATEWAY_SETTINGS]: `${JSON.stringify(settings, null, 2)}\n` },
      }
    },
  },
  // An empty session runs no turn and calls no model.
  catalogueRead: { when: 'select' },
  permission: {
    approvals: 'prompts',
    defaultEnv: {},
    expectedMode: 'default',
    modeLadder: ['plan', 'default', 'auto-edit', 'auto', 'yolo'],
    modeTiers: {
      plan: { tier: 'plan', line: '只看和规划，不改文件' },
      default: { tier: 'ask', line: '改文件或运行命令前问你' },
      'auto-edit': { tier: 'rule', line: '直接改文件，命令前问你' },
      // The person's allow rules, read-only tools and edits inside the project (not `.git`, `package.json` and the like)
      // pass before its classifier; it asks when the classifier cannot decide, and reports no verdict.
      auto: { tier: 'model', line: '项目内不问，其余由模型判断' },
      yolo: { tier: 'never', line: '直接改文件和运行命令' },
    },
    readback: 'mode',
    inheritEnv: ['QWEN_HOME', 'QWEN_RUNTIME_DIR'],
    notes: ['恢复会话会恢复旧模式，Latch 每轮前重新设置'],
  },
  // The process arguments apply to its ACP sessions, and the value is split on commas.
  folders: { via: 'args', flag: '--include-directories', maxExtra: 4 },
  // Workspace settings, commands, agents and extensions.
  projectConfigPaths: ['.qwen'],
  // Qwen Code names the tool a call runs only in `_meta.toolName`, where ACP has `name`.
  normalizeUpdate(update) {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return update
    const meta = update._meta
    const named = typeof meta === 'object' && meta !== null ? (meta as { toolName?: unknown }).toolName : undefined
    return update.name == null && typeof named === 'string' && named ? { ...update, name: named } : update
  },
}
