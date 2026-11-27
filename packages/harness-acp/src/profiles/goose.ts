import type { HarnessProfile } from './types.ts'

/** goose's key for an extension name (1.57.0 `config/extensions.rs`, `name_to_key`). */
function gooseExtensionKey(name: string): string {
  let key = ''
  for (const char of name) {
    if (/^[A-Za-z0-9_-]$/u.test(char)) key += char
    else if (/^\s$/u.test(char)) continue
    else key += '_'
  }
  return key.toLowerCase()
}

/** A line of `goose --version` that is the version alone, with or without the program's name before it. */
/** The Homebrew formula goose ships as; its own installer leaves a layout no lookup names. */
const GOOSE_SOURCE = { brew: ['block-goose-cli'] } as const

const readGooseVersion = (output: string) => /^\s*(?:goose\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\s*$/mu.exec(output)?.[1]

export const gooseProfile: HarnessProfile = {
  presetId: 'goose',
  // 2: a session on a model service is pointed at the gateway through goose's own variables.
  // 3: Latch's MCP servers are removed from goose's record of a session before its process stops, and the project's
  // recipes and agent sources count in the launch fingerprint.
  version: 3,
  /**
   * goose has no `session/resume`, and its `session/load` goes on with a turn that stopped on a tool confirmation, as a
   * run of its own: it asks the question again, or applies an answer it already holds, and calls the model after
   * (1.57.0 `load_session.rs`, `agent.rs` `resume_state_machine_turn_inner`). On a new process 1.57.0 answers an approved
   * tool as expired instead of running it (`ops_toolcalling.rs`, seen in a real run), but the turn still goes on.
   */
  loadResumesTurn: true,
  // `summon` keeps a subagent as a session of its own (`parent_session_id`), which `session/delete` leaves.
  childSessionsInRecord: true,
  /**
   * The `mcpServers` of `session/new` and `session/load` are kept in the session's `enabled_extensions`
   * (`prepare_session_for_activation`, seen in a real run of 1.57.0); this removes one from that session's list only
   * (`ExtensionManager::disable`).
   */
  mcpRemoval: {
    method: '_goose/unstable/session/extensions/remove',
    params: (sessionId, name) => ({ sessionId, extensionKey: gooseExtensionKey(name) }),
  },
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
    minimumVersion: { args: ['--version'], read: readGooseVersion, minimum: '1.57.0', upgrade: 'goose update', source: GOOSE_SOURCE },
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
  // Its `session/new` starts every extension the person enabled in goose, their stdio MCP programs among them, and waits
  // for each (1.57.0 `prepare_acp_session_agent`; a real run waited 20 s on one that never answered).
  // No gate of its own: read only to tell a person a newer formula is out.
  releases: { args: ['--version'], read: readGooseVersion, source: GOOSE_SOURCE },
  // The read's `session/new` starts those extensions too and waits for them; a draft still prefetches once per definition.
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
  // The recipes and agent sources `summon` reads from the project (1.57.0 `summon.rs`): a recipe's
  // `settings.goose_provider`, or an agent source with a model, can move its subagent to another provider. Claude's own
  // project `.claude/agents`, which it reads too, is left out: Latch does not read Claude's settings.
  projectConfigPaths: ['.goose', '.agents/recipes', '.agents/agents'],
  // Its prompt answer's `usage` is the session's last model call (1.57.0 `acp/server.rs`, `session.usage`): the context
  // then, not this turn's tokens nor a running total. The Host reads the turn's calls from goose's own ledger instead.
  usageScope: 'none',
}
