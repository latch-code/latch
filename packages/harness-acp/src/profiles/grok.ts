import { lstat, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { ModelWire, SessionConfigOption } from '@latch/protocol'
import { GROK_BILLING_METHOD, grokQuota } from '../quota.ts'
import { z } from 'zod'
import type { TurnTokens } from '../protocol.ts'
import type { HarnessProfile } from './types.ts'

const count = z.number().nonnegative().finite()
/** The prompt answer's `_meta.usage` (Grok 1.0.x, checked 2026-11-16): this turn's model calls, cached input inside input. */
const turnMeta = z.object({
  _meta: z.object({
    usage: z.object({
      inputTokens: count,
      outputTokens: count,
      cachedReadTokens: count.optional().catch(undefined),
      cacheCreationTokens: count.optional().catch(undefined),
      reasoningTokens: count.optional().catch(undefined),
    }),
  }),
})

function grokTurnUsage(result: unknown): TurnTokens | undefined {
  const parsed = turnMeta.safeParse(result)
  if (!parsed.success) return undefined
  const { inputTokens, outputTokens, cachedReadTokens, cacheCreationTokens, reasoningTokens } = parsed.data._meta.usage
  return {
    inputTokens,
    outputTokens,
    ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cachedWriteTokens: cacheCreationTokens } : {}),
    ...(reasoningTokens !== undefined ? { thoughtTokens: reasoningTokens } : {}),
  }
}

const name = z.string().min(1).max(200)
const effort = z.object({ value: name, label: name, description: z.string().max(1000).optional().catch(undefined) })
/**
 * `initialize._meta.modelState` (1.0.89): the default model and each model's reasoning efforts, the same list and IDs its
 * session/new then reports as the `model` and `reasoning_effort` options.
 */
const modelState = z.object({
  currentModelId: name,
  availableModels: z
    .array(
      z.object({
        modelId: name,
        name,
        _meta: z
          .object({
            reasoningEffort: name.optional().catch(undefined),
            reasoningEfforts: z.array(effort).max(16).optional().catch(undefined),
          })
          .optional()
          .catch(undefined),
      }),
    )
    .min(1)
    .max(200),
})

/** Grok's thinking option for one model as its session/new reports it, or undefined for a model without one. */
function effortOption(model: z.infer<typeof modelState>['availableModels'][number]): SessionConfigOption | undefined {
  const efforts = model._meta?.reasoningEfforts
  const current = model._meta?.reasoningEffort
  if (!efforts?.length || !current || !efforts.some(item => item.value === current)) return undefined
  return {
    id: 'reasoning_effort',
    name: 'Reasoning Effort',
    category: 'thought_level',
    currentValue: current,
    options: efforts.map(item => ({ value: item.value, name: item.label, ...(item.description ? { description: item.description } : {}) })),
  }
}

/** The model list and each model's thinking before any session, from Grok's answer to initialize. */
export function grokStartCatalogue(
  meta: unknown,
): { options: SessionConfigOption[]; perModel: Array<{ model: string; options: SessionConfigOption[] }> } | undefined {
  const parsed = z.object({ modelState }).safeParse(meta)
  if (!parsed.success) return undefined
  const { currentModelId, availableModels } = parsed.data.modelState
  const current = availableModels.find(model => model.modelId === currentModelId)
  if (!current) return undefined
  const model: SessionConfigOption = {
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue: currentModelId,
    options: availableModels.map(item => ({ value: item.modelId, name: item.name })),
  }
  const thinking = effortOption(current)
  return {
    options: [model, ...(thinking ? [thinking] : [])],
    perModel: availableModels.map(item => ({ model: item.modelId, options: [effortOption(item)].filter(option => option !== undefined) })),
  }
}

/**
 * Grok's saved 「Always allow」 and 「never allow」 answers for the project of `cwd`: `permission.toml` and per-client
 * `permission_<client>.toml` in `$GROK_HOME/sessions/<URL-encoded scope root>/`, the scope root being the git
 * repository's root or else the folder (its user guide, 22-permissions-and-safety「Persistence Is Per Project」). Their
 * shape is not documented, so only whether such a file holds anything is read, never what it says. A scope root whose
 * encoding is longer than a file name (Grok then writes a hashed name) and a worktree's main checkout are not looked up.
 */
export async function grokSavedRules(cwd: string, env: Readonly<Record<string, string>>): Promise<string[]> {
  const home = env.GROK_HOME || (env.HOME ? join(env.HOME, '.grok') : undefined)
  if (!home || !isAbsolute(home)) return []
  let root = cwd
  for (let at = cwd; ; at = dirname(at)) {
    if (
      await lstat(join(at, '.git')).then(
        () => true,
        () => false,
      )
    ) {
      root = at
      break
    }
    if (dirname(at) === at) break
  }
  // The path as given and as resolved: which of the two Grok records was not checked.
  const scopes = [...new Set([root, await realpath(root).catch(() => root)])].map(path => encodeURIComponent(path))
  const saved = new Set<string>()
  for (const scope of scopes.filter(item => Buffer.byteLength(item) <= 255)) {
    const directory = join(home, 'sessions', scope)
    const names = await readdir(directory).catch(() => [] as string[])
    for (const name of names.filter(item => /^permission(?:_[\w.-]+)?\.toml$/u.test(item)).slice(0, 8)) {
      const stats = await lstat(join(directory, name)).catch(() => undefined)
      if (stats?.isFile() && stats.size > 0) saved.add(name)
    }
  }
  return saved.size
    ? [
        `Grok 在这个项目存有你在它自己界面里给过的「始终允许」或「不再允许」回答（${[...saved].join('、')}），在 Latch 的会话里同样生效；Latch 不改也不显示其内容。`,
      ]
    : []
}

const GATEWAY_CONFIG = 'config.toml'
/** Grok Build's `api_backend` for each protocol (docs.x.ai/build/settings, "Example config.toml"). */
const BACKENDS: Partial<Record<ModelWire, string>> = {
  'chat-completions': 'chat_completions',
  responses: 'responses',
  'anthropic-messages': 'messages',
}
/** A TOML basic string: JSON's escapes are TOML's, for the model IDs and addresses written here. */
const text = (value: string) => JSON.stringify(value)

/**
 * What keeps the session's token in Grok alone. With its own home it still reads the person's real home for other
 * tools' configuration, and every stdio MCP server it starts from there inherits its whole environment, the token
 * included (Grok 1.0.89, checked 2026-11-20 with a recording server in a temporary HOME):
 * - `compat.*.mcps`: `~/.claude.json`, `~/.cursor/mcp.json` and the project's `.cursor/mcp.json`;
 * - the Claude import marker (`[claude_compat] imported`, what `/import-claude` writes): the plugins Claude's
 *   `enabledPlugins` turns on, with their MCP servers, and a project's `.mcp.json`. It also drops the allow rules of
 *   `~/.claude/settings.json`; its deny rules stay;
 * - `compat.*.hooks`: Claude's, Cursor's and Codex's hooks, documented but not seen to run without folder trust.
 * Its bash tool and terminals leave out the token by `shell_environment_policy` (its documentation; not checked
 * without a turn). The variables repeat the switches so that a definition's own cannot turn them back on.
 */
const ISOLATION = [
  '[claude_compat]',
  'imported = true',
  '',
  '[compat.claude]',
  'mcps = false',
  'hooks = false',
  '',
  '[compat.cursor]',
  'mcps = false',
  'hooks = false',
  '',
  '[compat.codex]',
  'hooks = false',
  '',
  '[shell_environment_policy]',
  'exclude = ["LMG_TOKEN"]',
  '',
].join('\n')
const ISOLATION_ENV = {
  GROK_CLAUDE_MCPS_ENABLED: '0',
  GROK_CURSOR_MCPS_ENABLED: '0',
  GROK_CLAUDE_HOOKS_ENABLED: '0',
  GROK_CURSOR_HOOKS_ENABLED: '0',
}

/**
 * Grok Build's custom models for a session on a model service: one per model of the service, each naming the variable
 * its key is read from, with the session's as the default and as the model of its own web search tool.
 */
export function grokGatewayModels(baseURL: string, wire: ModelWire, model: string, models: readonly string[]): string {
  const backend = BACKENDS[wire]
  if (!backend) throw new Error(`Grok Build is not pointed at ${wire}`)
  // Its Responses and Chat addresses end in the version; Anthropic's is given the same way.
  const address = wire === 'anthropic-messages' ? `${baseURL}/v1` : baseURL
  return [
    '[models]',
    `default = ${text(model)}`,
    `web_search = ${text(model)}`,
    ...models.flatMap(id => [
      '',
      `[model.${text(id)}]`,
      `model = ${text(id)}`,
      `name = ${text(id)}`,
      `base_url = ${text(address)}`,
      'env_key = "LMG_TOKEN"',
      `api_backend = ${text(backend)}`,
    ]),
    '',
  ].join('\n')
}

/**
 * Grok Build's user configuration for a session on a model service: its custom models and what keeps the token in
 * Grok. It is the whole of a home directory of the session's own (`GROK_HOME`), since the user configuration is the
 * only documented place for a custom model: the person's own Grok login, hooks, plugins and MCP servers are not in
 * that home, so a model of xAI's own has no login to answer with there.
 */
function gatewayConfig(baseURL: string, wire: ModelWire, model: string, models: readonly string[]): string {
  return `${grokGatewayModels(baseURL, wire, model, models)}\n${ISOLATION}`
}

export const grokProfile: HarnessProfile = {
  presetId: 'grok',
  // 2: a session on a model service runs in a home of its own that holds its custom models.
  // 3: that home reads no other tool's MCP servers or hooks; Claude's, Cursor's and agents' project files count.
  // Also in 3: its own delete, its sessions brought in, its models read from initialize, /always-approve withheld.
  version: 3,
  gateway: {
    via: 'launch',
    wires: ['chat-completions', 'responses', 'anthropic-messages'],
    // Wired from its documentation and one run without a login; not from its source.
    experimental: true,
    tokenEnv: 'LMG_TOKEN',
    // The MCP servers Latch gives it get the token blanked; its bash tool leaves it out by its own policy. Kept until a
    // real tool call shows that policy holds.
    credentialInherited: true,
    // A routed session's record lives in its private home, which the person's own Grok never reads.
    sessionBoundToRoute: true,
    recordInPrivateHome: true,
    envNames: ['GROK_HOME', ...Object.keys(ISOLATION_ENV)],
    templates: { files: 2 },
    deliver(place, route) {
      const path = place.file(GATEWAY_CONFIG)
      return {
        env: { GROK_HOME: dirname(path), ...ISOLATION_ENV },
        files: {
          [GATEWAY_CONFIG]: gatewayConfig(
            place.baseURL,
            route.wire,
            route.model,
            place.models.map(item => item.id),
          ),
        },
      }
    },
  },
  // It does not advertise session/delete (-32601) but answers its own with `{ success: true }` and removes the session's
  // folder, an empty one too (1.0.89, checked 2026-11-20 on a temporary GROK_HOME).
  deleteMethod: '_x.ai/session/delete',
  // `/always-approve on` turns the session to approving everything and reports nothing over ACP (1.0.89 lists it in
  // its commands; readback covers plan only).
  modeCommands: ['always-approve'],
  savedRules: grokSavedRules,
  // 1.0.89 reports no `agentInfo`, only `_meta.agentVersion`.
  versionInMeta: true,
  // Its session/list without a folder lists the sessions of every folder (`sessionId`, `cwd`, `title`, `updatedAt`),
  // leaving out ones with no message, and session/load replays the session's recorded updates, each marked
  // `_meta.isReplay` (1.0.89, checked 2026-11-20 against hand-written sessions in a temporary GROK_HOME, not its
  // source). It reports no session as open elsewhere and keeps no lock Latch can see.
  historyImport: { version: '^1\\.0\\.89$', useUnknown: true },
  // Its answer to initialize lists the models and their thinking; that process opens no session and starts none of the
  // person's MCP servers or hooks (1.0.89, checked 2026-11-20), so a draft reads it by itself.
  catalogueRead: { fromInitialize: grokStartCatalogue },
  permission: {
    approvals: 'prompts',
    defaultEnv: {},
    // Grok 1.0.77 reports model and reasoning_effort, but no ACP permission option or current_mode_update.
    readback: 'none',
    inheritEnv: ['GROK_HOME'],
    configEnv: ['GROK_*'],
    notes: ['Grok 以 default 启动，仍按自己的权限规则运行；当前 ACP 接口不报告有效权限档位'],
  },
  // Its own, and what it reads for Claude Code, Cursor and agents compatibility: rules, permission rules, MCP servers,
  // skills and hooks (its user guide, 05-configuration「Harness compatibility」, 07-mcp-servers「Compatibility」).
  projectConfigPaths: ['.grok', '.claude', '.mcp.json', '.cursor', '.agents'],
  // Worktrees Claude creates for its own subagents.
  projectConfigManaged: { skip: ['.claude/worktrees'] },
  // The request Grok's own `/usage` makes; it needs no turn.
  quota: { request: { method: GROK_BILLING_METHOD, read: grokQuota } },
  usageScope: 'turn',
  turnUsage: grokTurnUsage,
  minimumVersion: {
    args: ['--version'],
    read: output => /^grok (\d+\.\d+\.\d+)(?:\s|$)/u.exec(output.trim())?.[1],
    minimum: '1.0.77',
    upgrade: 'grok update',
  },
}
