import { z } from 'zod'
import { dirname } from 'node:path'
import { bareVersion } from '../version-line.ts'
import { prefixedModels } from './gateway-model.ts'
import type { HarnessProfile, ProjectedChild } from './types.ts'

/**
 * Every tool asks except reading, which skips `.env` files. Subagents: 1.x's ACP drops a subagent's requests unanswered,
 * so `task` stays off there; 2.x reads `task` as `subagent` and then the later `subagent` rule, so starting one asks,
 * and its requests reach the session that started it. 1.x has no `subagent` permission, so it ignores that key.
 */
/** The agents Latch adds as OpenCode's own modes; OpenCode shows these IDs as their names. */
const EDIT_AGENT = 'auto-edit'
const YOLO_AGENT = 'yolo'

const ASK_FIRST = {
  '*': 'ask',
  read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny' },
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  external_directory: 'ask',
  task: 'deny',
  subagent: 'ask',
}

/**
 * Repeated per agent because an agent's own `permission` block would otherwise replace the global one. OpenCode applies
 * the last matching rule, so `plan` refuses edits (its write and patch tools included) and commands after `'*': 'ask'`,
 * and starts no subagent: a subagent works under its own agent's rules and these global ones, not under `plan`'s.
 */
const CONFIG = JSON.stringify({
  permission: ASK_FIRST,
  agent: {
    build: { permission: ASK_FIRST },
    plan: { permission: { ...ASK_FIRST, edit: 'deny', bash: 'deny', subagent: 'deny' } },
    // Two more primary agents with no prompt of their own, so they work like `build` under other rules. `mode` is named
    // because 1.x makes an agent the configuration adds `all`, which a subagent could also be started as. Spreading
    // ASK_FIRST keeps its order, so `'*'` is still the first rule and the narrower ones after it still apply.
    [EDIT_AGENT]: {
      mode: 'primary',
      description: 'Edits files without asking; asks before commands and outside the folder (set by Latch)',
      permission: { ...ASK_FIRST, edit: 'allow' },
    },
    // Everything runs unasked but `.env` reads. 1.x keeps `task` off as everywhere; in 2.x a subagent starts unasked
    // and then works under its own agent and the global rules above, so its own calls still ask.
    [YOLO_AGENT]: {
      mode: 'primary',
      description: 'Runs every tool without asking, except reading .env files (set by Latch)',
      permission: { ...ASK_FIRST, '*': 'allow', external_directory: 'allow', subagent: 'allow' },
    },
  },
})

const GATEWAY_MODELS = prefixedModels('latch')
const GATEWAY_ENV_PLUGIN = 'index.ts'
const GATEWAY_PACKAGES = {
  'chat-completions': '@opencode/ai/providers/openai-compatible',
  responses: '@opencode/ai/providers/openai-compatible/responses',
  'anthropic-messages': '@opencode/ai/providers/anthropic-compatible',
} as const

/** 2.2.6's spawner overlays its environment: an empty entry also clears a token inherited from the Agent process. */
const GATEWAY_PLUGIN = `export default {
  id: 'latch.gateway-environment',
  async setup(context) {
    const registration = await context.shell.hook('create.before', invocation => {
      for (const name of Object.keys(invocation.env)) {
        if (name.toLowerCase() === 'lmg_token') invocation.env[name] = ''
      }
    });
    return () => registration.dispose();
  },
};\n`

/** What 2.x adds to a subagent's update or request it sends on the session that started the subagent. */
const CHILD_SESSION = 'opencode/child-session'
const childSession = z.object({
  id: z.string().min(1).max(512),
  parentID: z.string().min(1).max(512),
  title: z.string().max(2000).optional().catch(undefined),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 2.x prefixes the subagent's call IDs with its session ID and its call titles with its title; these come off. */
function projectedChild(value: Record<string, unknown>): { child: ProjectedChild; value: Record<string, unknown> } | undefined {
  const meta = value._meta
  if (!isRecord(meta) || !Object.hasOwn(meta, CHILD_SESSION)) return undefined
  const parsed = childSession.safeParse(meta[CHILD_SESSION])
  if (!parsed.success) return undefined
  const { id, parentID, title } = parsed.data
  const own: Record<string, unknown> = { ...value }
  const { [CHILD_SESSION]: _child, ...rest } = meta
  if (Object.keys(rest).length) own._meta = rest
  else delete own._meta
  if (typeof own.toolCallId === 'string' && own.toolCallId.startsWith(`${id}:`)) own.toolCallId = own.toolCallId.slice(id.length + 1)
  if (title && typeof own.title === 'string') {
    // A request with no title of its own carries the subagent's title alone.
    if (own.title === title) delete own.title
    else if (own.title.startsWith(`${title}: `)) own.title = own.title.slice(title.length + 2)
  }
  return { child: { sessionId: id, parentSessionId: parentID, ...(title ? { title } : {}) }, value: own }
}

/**
 * The `subagent` call ends with the subagent's session in its metadata: `status` `completed` when it finished, `running`
 * when it goes on in the background. A failed call carries the session from the call's progress.
 */
function childEnd(update: Record<string, unknown>): { sessionId: string; outcome: 'done' | 'failed' } | undefined {
  if (update.sessionUpdate !== 'tool_call_update') return undefined
  const output = update.rawOutput
  const metadata = isRecord(output) ? output.metadata : undefined
  const sessionId = isRecord(metadata) ? metadata.sessionID : undefined
  if (typeof sessionId !== 'string' || !sessionId) return undefined
  if (update.status === 'failed') return { sessionId, outcome: 'failed' }
  if (update.status === 'completed' && isRecord(metadata) && metadata.status === 'completed') return { sessionId, outcome: 'done' }
  return undefined
}

const OWN_PLUGIN = '@opencode-ai/plugin'

/** OpenCode creates `.opencode/package.json` when it is missing and adds its own plugin package at every start. */
function withoutOwnPlugin(text: string): unknown {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return text
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return text
  const rest: Record<string, unknown> = { ...value }
  const dependencies = rest.dependencies
  if (typeof dependencies === 'object' && dependencies !== null && !Array.isArray(dependencies)) {
    const others: Record<string, unknown> = { ...dependencies }
    delete others[OWN_PLUGIN]
    if (Object.keys(others).length) rest.dependencies = others
    else delete rest.dependencies
  }
  return Object.keys(rest).length ? rest : undefined
}

export const opencodeProfile: HarnessProfile = {
  presetId: 'opencode',
  version: 7,
  // It lists `effort` only for a model with variants (2.x `config-option.ts`).
  thinkingPerModel: true,
  // An empty session runs no turn and calls no model.
  catalogueRead: { when: 'select' },
  // Checked 2026-11-16: each prompt answer counts its own turn, cached input beside the input rather than in it.
  usageScope: 'turn',
  inputExcludesCache: true,
  // 2.x lists its sessions page by page and replays one on `session/load` (2.2.6 `acp/service.ts`, `acp/replay.ts`); 1.x
  // has no `session/list`. Its load and resume store the folders they are given as the session's grants
  // (`acp/directories.ts`), and Latch gives OpenCode none, so a session that holds some is left alone.
  historyImport: { version: '^2\\.', grants: 'refuse', useUnknown: true },
  gateway: {
    via: 'launch',
    wires: ['chat-completions', 'responses', 'anthropic-messages'],
    tokenEnv: 'LMG_TOKEN',
    envNames: ['OPENCODE_CONFIG_CONTENT'],
    templates: { files: 1 },
    models: GATEWAY_MODELS,
    minimumVersion: { args: ['--version'], read: bareVersion, minimum: '2.2.6', upgrade: 'npm i -g @opencode/cli@latest' },
    deliver(place, route) {
      const model = GATEWAY_MODELS.value(route.model)
      const baseURL = `${place.baseURL}${route.wire === 'anthropic-messages' ? '/v1' : ''}`
      const config = {
        ...(JSON.parse(CONFIG) as Record<string, unknown>),
        model,
        small_model: model,
        plugins: [dirname(place.file(GATEWAY_ENV_PLUGIN))],
        providers: {
          latch: {
            name: 'Latch',
            env: ['LMG_TOKEN'],
            package: GATEWAY_PACKAGES[route.wire],
            settings: { baseURL, encoding: 'none' },
            models: Object.fromEntries(
              place.models.map(({ id, capabilities }) => [
                id,
                {
                  name: id,
                  capabilities: {
                    input: capabilities?.vision ? ['text', 'image'] : ['text'],
                    output: ['text'],
                    reasoning: capabilities?.thinking?.length ? { supported: true, effort: capabilities.thinking } : { supported: false },
                  },
                  // 2.x `Config.Model.Limit`: the window its compaction works against for a model it has no catalogue entry for.
                  ...(capabilities?.contextTokens ? { limit: { context: capabilities.contextTokens } } : {}),
                },
              ]),
            ),
          },
        },
      }
      return { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, files: { [GATEWAY_ENV_PLUGIN]: GATEWAY_PLUGIN } }
    },
  },
  permission: {
    approvals: 'prompts',
    defaultEnv: { OPENCODE_CONFIG_CONTENT: CONFIG },
    expectedMode: 'build',
    modeLadder: ['plan', 'build', EDIT_AGENT, YOLO_AGENT],
    modeTiers: {
      plan: { tier: 'plan', line: '只看和规划，不改文件' },
      build: { tier: 'ask', line: '读文件不问，其余问你' },
      [EDIT_AGENT]: { tier: 'rule', line: '直接改文件，命令和目录外问你' },
      [YOLO_AGENT]: { tier: 'never', line: '直接改文件和运行命令，.env 不读' },
    },
    readback: 'mode',
    // The configuration keys above are those of OpenCode 1.x, which 2.x still reads as the same ordered rules (`task` as
    // `subagent`, `bash` as `shell`); another major version may read them differently.
    versionRule: { pattern: '^[12]\\.', message: 'OpenCode 仅支持 1.x 与 2.x' },
    // The user configuration, agents and plugins live under the XDG directories (or the home directory), loaded after
    // OPENCODE_CONFIG_CONTENT; the remaining OPENCODE_* switches have not been checked against the rules above.
    configEnv: ['XDG_*', 'OPENCODE_*', 'USERPROFILE'],
    // OpenCode merges project and user configuration around OPENCODE_CONFIG_CONTENT, some of it later, and Latch
    // cannot turn that off; the rules above are a default, not a guarantee.
    inheritEnv: ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'],
    notes: [
      '项目或用户的 OpenCode 配置（opencode.json、.opencode 目录中的配置与 Agent 定义）可以覆盖 Latch 设置的询问规则，此时 OpenCode 可能不经询问就执行命令或修改文件',
      'OpenCode 启动时会加载项目 .opencode 目录中的插件；在不信任的项目中使用会运行其中的代码',
      '「直接改文件」「不再询问」是 Latch 加给 OpenCode 的 auto-edit、yolo 两个 Agent；OpenCode 2.x 的子 Agent 按它自己的 Agent 工作，在这两档里仍先问你',
      'OpenCode 2.x 的子 Agent 可以在后台运行，本轮结束或停止后仍可能继续；Latch 不能单独停止它，它之后的请求照常出现在这个会话里。在后来的一轮里被继续的子 Agent 例外：OpenCode 不转发它的请求，它要批准时这一轮会一直运行，只能停止',
    ],
  },
  // Latch passes no other folders (1.x takes none over ACP); `external_directory: 'ask'` above asks before it leaves the
  // session directory, which 2.x would otherwise allow.
  folderAccess: 'primary-asks',
  // Searched from the session directory upwards, like OpenCode; `.opencode` loads after the rules above.
  projectConfigPaths: ['opencode.json', 'opencode.jsonc', '.opencode'],
  // At every start OpenCode 1.x installs its plugin package into each `.opencode` directory (package.json, bun.lock,
  // node_modules, .gitignore); its plan agent writes plans under `.opencode/plans` (2.x under the home directory).
  // None of these is configuration.
  projectConfigManaged: {
    skip: ['.opencode/node_modules', '.opencode/bun.lock', '.opencode/bun.lockb', '.opencode/.gitignore', '.opencode/plans'],
    reduce: { '.opencode/package.json': withoutOwnPlugin },
  },
  // OpenCode sends a reply's thinking under the ID of its reasoning part, not of the message, which would split one reply
  // in two; without an ID the thinking joins the reply it belongs to.
  normalizeUpdate(update) {
    if (update.sessionUpdate !== 'agent_thought_chunk' || update.messageId === undefined) return update
    const { messageId: _part, ...rest } = update
    return rest as typeof update
  },
  // 1.4 to 1.14 read a model back as `<provider>/<id>/<level>` after a pick of `<provider>/<id>`.
  configValueMatches: (configId, asked, reported) =>
    configId === 'model' && reported.startsWith(`${asked}/`) && !reported.slice(asked.length + 1).includes('/'),
  readProjectedChild: projectedChild,
  readChildEnd: childEnd,
}
