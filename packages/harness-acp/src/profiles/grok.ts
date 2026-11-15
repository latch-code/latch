import { dirname } from 'node:path'
import type { ModelWire } from '@latch/protocol'
import type { HarnessProfile } from './types.ts'

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
 * Grok Build's user configuration for a session on a model service: one custom model per model of the service, each
 * naming the variable its key is read from, with the session's as the default and as the model of its own web search
 * tool. It is the whole of a home directory of the session's own (`GROK_HOME`), since the user configuration is the
 * only documented place for a custom model: the person's own Grok login, hooks and plugins are not in that home, so a
 * model of xAI's own has no login to answer with there.
 */
function gatewayConfig(baseURL: string, wire: ModelWire, model: string, models: readonly string[]): string {
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

export const grokProfile: HarnessProfile = {
  presetId: 'grok',
  // 2: a session on a model service runs in a home of its own that holds its custom models.
  version: 2,
  gateway: {
    via: 'launch',
    wires: ['chat-completions', 'responses', 'anthropic-messages'],
    // Wired from its documentation and one run without a login; not from its source.
    experimental: true,
    tokenEnv: 'LMG_TOKEN',
    // No documented switch keeps its environment from the commands it runs outside its sandbox.
    credentialInherited: true,
    envNames: ['GROK_HOME'],
    templates: { files: 1 },
    deliver(place, route) {
      const path = place.file(GATEWAY_CONFIG)
      return {
        env: { GROK_HOME: dirname(path) },
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
  projectConfigPaths: ['.grok'],
  minimumVersion: {
    args: ['--version'],
    read: output => /^grok (\d+\.\d+\.\d+)(?:\s|$)/u.exec(output.trim())?.[1],
    minimum: '1.0.77',
    upgrade: 'grok update',
  },
}
