import type { HarnessProfile } from './types.ts'

/** A line of `goose --version` that is the version alone, with or without the program's name before it. */
const readGooseVersion = (output: string) => /^\s*(?:goose\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\s*$/mu.exec(output)?.[1]

export const gooseProfile: HarnessProfile = {
  presetId: 'goose',
  // 2: a session on a model service is pointed at the gateway through goose's own variables.
  version: 2,
  /**
   * Through the gateway by the environment alone, which goose reads before its configuration file and, for a key, before
   * the keyring (1.57.0 and 1.59.0 `crates/goose/src/config/base.rs`), so it needs no login of its own. Its built-in `openai` and
   * `anthropic` providers fix the names.
   *
   * Experimental, for a reason no setting removes: its `delegate` tool runs a subagent on the provider a recipe names
   * (`settings.goose_provider`), or, for an agent source with a model, on the `provider` the model itself passes, and
   * both come before `GOOSE_SUBAGENT_PROVIDER` (`crates/goose/src/agents/platform_extensions/summon.rs`). Such a
   * subagent uses a provider the person set up in goose, where they set one up.
   */
  gateway: {
    via: 'launch',
    wires: ['chat-completions', 'responses', 'anthropic-messages'],
    experimental: true,
    tokenEnv: 'OPENAI_API_KEY',
    tokenEnvByWire: { 'anthropic-messages': 'ANTHROPIC_API_KEY' },
    // No documented switch keeps a provider's key from the commands goose runs.
    credentialInherited: true,
    // Resumed without its variables, goose 1.57 keeps reporting the service's model and sends the next turn to its own
    // provider, logged in or not: nothing Latch can read says whether its own login took over.
    sessionBoundToRoute: true,
    envNames: [
      'GOOSE_PROVIDER',
      'GOOSE_MODEL',
      'GOOSE_SUBAGENT_PROVIDER',
      'GOOSE_SUBAGENT_MODEL',
      'GOOSE_TOOLSHIM',
      'OPENAI_HOST',
      'OPENAI_BASE_PATH',
      'ANTHROPIC_HOST',
    ],
    templates: {},
    // Its `provider` option would move the session to a service the person configured in goose.
    hiddenConfig: ['provider'],
    // Read in the sources of 1.57.0 and 1.59.0, and run without a login on 1.57.0.
    minimumVersion: { args: ['--version'], read: readGooseVersion, minimum: '1.57.0', upgrade: 'goose update' },
    deliver(place, route) {
      const provider = route.wire === 'anthropic-messages' ? 'anthropic' : 'openai'
      // Both providers take the address without a version and add the path themselves.
      const host = place.baseURL.replace(/\/v1\/?$/u, '')
      return {
        env: {
          GOOSE_PROVIDER: provider,
          GOOSE_MODEL: route.model,
          GOOSE_SUBAGENT_PROVIDER: provider,
          GOOSE_SUBAGENT_MODEL: route.model,
          // The tool shim sends each reply to a local interpreter model of the person's own.
          GOOSE_TOOLSHIM: 'false',
          ...(provider === 'anthropic'
            ? { ANTHROPIC_HOST: host }
            : {
                OPENAI_HOST: host,
                // goose treats exactly `v1/chat/completions` as its default and then picks Responses by the model's
                // name; any other path that names the API fixes it, and the leading slash makes this one another path
                // to the same address (`crates/goose-providers/src/openai.rs`, `should_use_responses_api`).
                OPENAI_BASE_PATH: route.wire === 'responses' ? 'v1/responses' : '/v1/chat/completions',
              }),
        },
        // No `_meta.provider` on the session: goose then starts it on that provider's default model, not `GOOSE_MODEL`
        // (`crates/goose/src/model_config.rs`, `resolve_provider_and_model_config`; seen in a real run of 1.57.0).
      }
    },
  },
  // An empty session runs no turn and calls no model.
  catalogueRead: { when: 'select' },
  permission: {
    approvals: 'prompts',
    defaultEnv: { GOOSE_MODE: 'approve' },
    expectedMode: 'approve',
    modeLadder: ['chat', 'approve', 'smart_approve', 'auto'],
    // Tools the person set to always allow in goose run without asking in `approve` and `smart_approve` alike.
    modeTiers: {
      chat: { tier: 'plan', line: '只聊天，不用工具' },
      approve: { tier: 'ask', line: '运行工具前问你' },
      smart_approve: { tier: 'model', line: '只读的不问，其余问你' },
      auto: { tier: 'never', line: '直接运行所有工具' },
    },
    readback: 'mode',
    inheritEnv: ['GOOSE_PATH_ROOT', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'],
    notes: [],
  },
  // goose has no other folders to receive and does not limit the paths its tools use.
  folderAccess: 'primary-unbounded',
}
