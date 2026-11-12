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
  /** False: the vendor's terms allow its name in text only, so pages draw the neutral agent glyph, never its logo. */
  brandMark?: false
  /** False when the agent takes no MCP servers over ACP, so it cannot fetch an agent's skills. */
  skillServer?: false
}

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex-acp',
    args: [],
    license: 'Apache-2.0',
    homepage: 'https://github.com/agentclientprotocol/codex-acp',
    description: '通过适配器运行 Codex；模型、登录与沙箱由 Codex 自身配置。',
    install: 'npm i -g @agentclientprotocol/codex-acp',
    agentCommand: 'codex',
    login: { command: 'codex', args: ['login'], bundled: { command: 'codex-acp', args: ['cli', 'login'] } },
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
    brandMark: false,
  },
  {
    id: 'pi',
    skillServer: false,
    name: 'pi',
    command: 'pi',
    args: [],
    license: 'MIT',
    homepage: 'https://github.com/earendil-works/pi',
    description: '模型与登录由 pi 管理；执行工具前不询问。',
    install: 'npm i -g @earendil-works/pi-coding-agent',
    installNote: '0.84.4 或更高版本',
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
    install: 'npm i -g opencode-ai',
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
    installNote: '0.2.1-rc.1 或更高版本',
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
    brandMark: false,
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
