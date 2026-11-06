import type { HarnessProfile } from './types.ts'

/** Every tool asks except reading, which skips `.env` files; subagents are off because their asks are not routed. */
const ASK_FIRST = {
  '*': 'ask',
  read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny' },
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  external_directory: 'ask',
  task: 'deny',
}

/** Repeated per agent because an agent's own `permission` block would otherwise replace the global one. */
const CONFIG = JSON.stringify({
  permission: ASK_FIRST,
  agent: { build: { permission: ASK_FIRST }, plan: { permission: ASK_FIRST } },
})

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
  version: 1,
  permission: {
    approvals: 'prompts',
    defaultEnv: { OPENCODE_CONFIG_CONTENT: CONFIG },
    expectedMode: 'build',
    modeLadder: ['plan', 'build'],
    readback: 'mode',
    // The configuration keys above are those of OpenCode 1.x, which 2.x still reads as the same ordered rules (`task` as
    // `subagent`); another major version may read them differently.
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
}
