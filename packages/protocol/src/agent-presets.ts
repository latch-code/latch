/**
 * Agents that speak ACP over stdio from a command the person installed: open-source ones, and vendors' own commands
 * their documentation supports, each with its licence or terms. Browser-safe: no Node imports. Permission behaviour is
 * Host-only.
 */
export interface AgentPreset {
  id: string
  name: string
  command: string
  args: string[]
  license: string
  homepage: string
  description: string
  /** The command to copy when `command` is missing. Latch never installs or downloads agents itself. */
  install?: string
  /** What the install command does not say, such as a version it needs. */
  installNote?: string
  /**
   * The program a person already knows, when `command` is an adapter that runs without it. It lets the page say the
   * program was found and only the adapter is missing, and a launch test read its version; nothing waits on it.
   */
  agentCommand?: string
  /**
   * The program's own login, which a person runs in a terminal; Latch never logs in for them. `note`: what to do once it
   * opens, for a program that logs in from inside. `bundled`: the same login through an adapter that ships the program.
   */
  login?: { command: string; args: string[]; note?: string; bundled?: { command: string; args: string[] } }
  /**
   * For a harness whose terms leave signing in to its vendor's own flow, so Latch shows no login command or button: one
   * sentence on how the person signs in themselves.
   */
  signIn?: string
  /** False: no verified brand asset is used (including text-only vendor terms); pages draw the neutral agent glyph. */
  brandMark?: false
  /** False when the agent takes no MCP servers over ACP, so it cannot fetch an agent's skills. */
  skillServer?: false
  /**
   * An ACP adapter that runs the same agent, for when `command` (the agent's own protocol) cannot be used: definitions
   * saved with it keep it, and a draft gets it when only it is installed or `command` is older than its preset supports.
   * `drives`: the program the adapter runs, as `agentCommand` says for a preset whose command is an adapter.
   */
  fallback?: {
    command: string
    args: string[]
    install: string
    homepage: string
    license: string
    /** What the preset's own description says, for the adapter route. */
    description: string
    /** What a saved definition on the adapter says the direct route needs, behind its hint. */
    direct: string
    drives?: string
  }
}

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: 'codex',
    name: 'Codex',
    // Codex's own app-server (`codex app-server`), the protocol its own clients use; the wire adds the subcommand.
    command: 'codex',
    args: [],
    license: 'Apache-2.0',
    homepage: 'https://github.com/openai/codex',
    description: '直接连接 Codex；模型、登录与沙箱由 Codex 自身配置。',
    install: 'npm i -g @openai/codex',
    installNote: '0.156.0 或更高版本',
    login: { command: 'codex', args: ['login'], bundled: { command: 'codex-acp', args: ['cli', 'login'] } },
    fallback: {
      command: 'codex-acp',
      args: [],
      install: 'npm i -g @agentclientprotocol/codex-acp',
      homepage: 'https://github.com/agentclientprotocol/codex-acp',
      license: 'Apache-2.0',
      description: '经适配器 codex-acp 运行它自带的 Codex；模型、登录与沙箱由 Codex 自身配置。',
      direct: '直接连接需要 Codex 0.156.0 或更高版本：npm i -g @openai/codex',
      drives: 'codex',
    },
  },
  {
    id: 'claude-agent',
    name: 'Claude Agent',
    command: 'claude-agent-acp',
    args: [],
    license: 'Apache-2.0 适配器；Claude Code 专有',
    homepage: 'https://github.com/agentclientprotocol/claude-agent-acp',
    description: '用你在 Claude Code 中已有的登录；Latch 不读取凭据。',
    install: 'npm i -g @agentclientprotocol/claude-agent-acp',
    installNote: '还要在 Claude Code 中登录',
    signIn: '在终端里按 Claude Code 自己的方式登录（或在它的设置里使用你自己的 API key）后重试。',
  },
  {
    id: 'pi',
    skillServer: false,
    name: 'pi',
    command: 'pi',
    args: [],
    license: 'MIT',
    homepage: 'https://github.com/earendil-works/pi',
    description: '模型与登录由 pi 管理；权限由 Latch 扩展设置。',
    install: 'npm i -g @earendil-works/pi-coding-agent',
    installNote: '原生模型需 0.84.4 或更高；经 Latch 使用服务需 1.5.0 或更高',
    login: { command: 'pi', args: [], note: '进入 pi 后输入 /login，按提示登录。' },
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    args: ['acp'],
    license: 'MIT',
    homepage: 'https://github.com/anomalyco/opencode',
    description: '模型与登录由 OpenCode 管理。',
    install: 'npm i -g @opencode/cli',
    installNote: '经 Latch 使用服务需 2.2.6 或更高',
    login: { command: 'opencode', args: ['auth', 'login'] },
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    command: 'dsh',
    args: ['--profile', 'acp'],
    license: 'MIT',
    homepage: 'https://github.com/deepseek-ai/deepseek-harness',
    description: '按完整消息回复，不逐字流式输出。',
    install: 'npm i -g @deepseek-ai/dsh',
    installNote: '0.2.2-rc.1 或更高版本',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    args: ['--acp', '--approval-mode', 'default'],
    license: 'Apache-2.0',
    homepage: 'https://github.com/google-gemini/gemini-cli',
    description: '登录与模型由 Gemini CLI 管理。',
    install: 'npm i -g @google/gemini-cli',
    login: { command: 'gemini', args: [], note: '进入 Gemini CLI 后按提示登录，或输入 /auth。' },
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    command: 'qwen',
    args: ['--acp'],
    license: 'Apache-2.0',
    homepage: 'https://github.com/QwenLM/qwen-code',
    description: '登录与模型由 Qwen Code 管理。',
    install: 'npm i -g @qwen-code/qwen-code',
    login: { command: 'qwen', args: [], note: '进入 Qwen Code 后输入 /auth，按提示登录。' },
  },
  {
    id: 'goose',
    name: 'goose',
    command: 'goose',
    args: ['acp'],
    license: 'Apache-2.0',
    homepage: 'https://github.com/block/goose',
    description: '模型在 goose 中配置。',
    install: 'brew install block-goose-cli',
    login: { command: 'goose', args: ['configure'] },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    // The installer links `agent` and `cursor-agent` to one program; only this name cannot belong to something else.
    command: 'cursor-agent',
    args: ['acp'],
    license: '专有（Cursor 服务条款）',
    homepage: 'https://cursor.com/docs/cli/acp',
    description: '运行 Cursor 官方 CLI，使用你自己的 Cursor 账号；模型与登录由 Cursor 管理。',
    install: 'curl https://cursor.com/install -fsS | bash',
    login: { command: 'cursor-agent', args: ['login'] },
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    command: 'agy',
    args: ['acp', '--disable-telemetry', '--process-per-session'],
    license: '专有（Google Antigravity 条款）',
    homepage: 'https://antigravity.google/docs/ide/extensions/acp/',
    description: '使用本机 Antigravity CLI 的模型与登录。',
    installNote: '需要 Antigravity CLI 1.5.8 或更高版本',
    login: { command: 'agy', args: ['acp', '--login'] },
  },
  {
    id: 'grok',
    name: 'Grok Build',
    command: 'grok',
    args: ['--no-auto-update', '--permission-mode', 'default', 'agent', 'stdio'],
    license: 'Grok Build 发布版条款；开源源码 Apache-2.0',
    homepage: 'https://docs.x.ai/build',
    description: '使用本机 Grok Build 的模型与登录。',
    install: 'npm i -g @xai-official/grok',
    installNote: '1.0.77 或更高版本',
    login: { command: 'grok', args: ['login'] },
  },
]

/**
 * Variables Latch sets or clears for every agent, or that would replace a preset's permission settings; a definition
 * cannot set them. OpenCode reads permission rules from each of the `OPENCODE_*` names, several after Latch's own.
 */
export const GLOBAL_RESERVED_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'NODE_OPTIONS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'INITIAL_AGENT_MODE',
  'GOOSE_MODE',
  'DSH_PERMISSION_MODE',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_PERMISSION',
  'OPENCODE_TEST_HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
  // The gateway token's variable: only the Host sets it, for a session on a route.
  'LMG_TOKEN',
]

/** `LATCH_*` are the Host's own settings, a model key among them. */
export const RESERVED_ENV_PREFIXES: readonly string[] = ['npm_', 'LATCH_', 'DYLD_', 'LD_', 'GIT_CONFIG_']

const RESERVED_NAMES = new Set(GLOBAL_RESERVED_ENV.map(name => name.toUpperCase()))
const RESERVED_PREFIXES = RESERVED_ENV_PREFIXES.map(prefix => prefix.toUpperCase())

/**
 * Case-insensitive: several tools read both spellings (`npm_config_*` and `NPM_CONFIG_*`, `http_proxy` and
 * `HTTP_PROXY`), and Windows treats names case-insensitively.
 */
export function isReservedAgentEnvName(name: string): boolean {
  const upper = name.toUpperCase()
  return RESERVED_NAMES.has(upper) || RESERVED_PREFIXES.some(prefix => upper.startsWith(prefix))
}

/** Icons no preset owns: `latch` for the built-in harness only, `plugin` for a third-party one that names no other. */
const NEUTRAL_MARKS = ['latch', 'plugin'] as const

/** Whether a client has an icon under this key. */
export function isHarnessMark(mark: unknown): mark is string {
  return (
    typeof mark === 'string' && ((NEUTRAL_MARKS as readonly string[]).includes(mark) || AGENT_PRESETS.some(preset => preset.id === mark))
  )
}
