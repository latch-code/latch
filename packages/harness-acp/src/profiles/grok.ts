import { dirname } from 'node:path'
import type { ModelWire } from '@latch/protocol'
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
  // SessionStart hooks and project plugins may run before the first prompt.
  catalogueRead: { when: 'request' },
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
