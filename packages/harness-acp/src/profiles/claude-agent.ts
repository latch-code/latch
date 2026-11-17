import { claudeErrorQuota, claudeUsageQuota } from '../quota.ts'
import type { HarnessProfile, LoginCheck, SessionUpdate, ToolDenial } from './types.ts'

const DAY_MS = 24 * 60 * 60_000

/** The adapter's `--cli --version` reports the same native binary its SDK sessions run. */
export function readClaudeVersion(output: string): string | undefined {
  const first = output.split(/\r?\n/u).find(line => line.trim()) ?? ''
  return /^\s*(\d+\.\d+\.\d+) \(Claude Code\)\s*$/u.exec(first)?.[1]
}

const GATEWAY_DEFAULTS = {
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_CUSTOM_HEADERS: '',
  ANTHROPIC_DEFAULT_MODEL: '',
  ANTHROPIC_DEFAULT_OPUS_MODEL: '',
  ANTHROPIC_DEFAULT_SONNET_MODEL: '',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
  ANTHROPIC_DEFAULT_FABLE_MODEL: '',
  ANTHROPIC_SMALL_FAST_MODEL: '',
  CLAUDE_CODE_OAUTH_TOKEN: '',
  CLAUDE_CODE_USE_ANTHROPIC_AWS: '',
  CLAUDE_CODE_USE_BEDROCK: '',
  CLAUDE_CODE_USE_MANTLE: '',
  CLAUDE_CODE_USE_VERTEX: '',
  CLAUDE_CODE_USE_FOUNDRY: '',
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
  CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP: '1',
}
const GATEWAY_MODEL_NAMES = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_AUTO_MODE_MODEL',
]

/** A date a sign-in ends, as seconds or milliseconds since the epoch or a date string; anything implausible is dropped. */
function loginEnds(value: unknown): string | undefined {
  const at = typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(at)) return undefined
  const now = Date.now()
  return at < now - 366 * DAY_MS || at > now + 5 * 366 * DAY_MS ? undefined : new Date(at).toISOString()
}

/**
 * `claude auth status --json`. It exits 1 when logged out and still prints JSON, so the code says nothing. `loggedIn`
 * covers only a claude.ai sign-in: a key or another provider counts as a credential too. The JSON also names the
 * account; only the verdict and the date leave this function.
 */
export function readClaudeStatus(output: string): LoginCheck {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  let parsed: unknown
  try {
    parsed = start >= 0 && end > start ? JSON.parse(output.slice(start, end + 1)) : undefined
  } catch {
    return { status: 'unknown' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'unknown' }
  const { loggedIn, apiKeySource, apiProvider, loginExpiresAt } = parsed as Record<string, unknown>
  if (typeof loggedIn !== 'boolean') return { status: 'unknown' }
  const elsewhere =
    (typeof apiKeySource === 'string' && apiKeySource !== '') || (typeof apiProvider === 'string' && apiProvider !== 'firstParty')
  const expiresAt = loggedIn ? loginEnds(loginExpiresAt) : undefined
  return { status: loggedIn || elsewhere ? 'authenticated' : 'unauthenticated', ...(expiresAt ? { expiresAt } : {}) }
}

const record = (value: unknown) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/**
 * The adapter reports a call it refused before it ran as a failed update whose `_meta.claudeCode.toolResponse` names why:
 * `decisionReasonType`, with `decisionReason` or `message` as the reason it shows. `rule` and `mode` are Claude's own
 * permission rules and modes; `classifier` is the model its auto mode asks. Any other source says nothing Latch can name,
 * so the call stays an ordinary failure.
 */
function readClaudeDenial(update: SessionUpdate): ToolDenial | undefined {
  if (update.sessionUpdate !== 'tool_call_update' || update.status !== 'failed') return undefined
  const response = record(record(record(update._meta)?.claudeCode)?.toolResponse)
  const type = response?.decisionReasonType
  const source = type === 'classifier' ? 'model' : type === 'rule' || type === 'mode' ? 'rule' : undefined
  if (!source) return undefined
  const reason = [response!.decisionReason, response!.message].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  )
  return { source, ...(reason ? { reason } : {}) }
}

export const claudeAgentProfile: HarnessProfile = {
  presetId: 'claude-agent',
  version: 3,
  gateway: {
    via: 'launch',
    wires: ['anthropic-messages'],
    tokenEnv: 'ANTHROPIC_AUTH_TOKEN',
    envNames: ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', ...Object.keys(GATEWAY_DEFAULTS), ...GATEWAY_MODEL_NAMES],
    templates: { session: 1 },
    models: { value: id => id, id: value => value || undefined, reportedOnly: true },
    // Default hands effort back to Claude, which then sends `high` of its own (2.1.318).
    defaultThinking: 'default',
    minimumVersion: {
      args: ['--cli', '--version'],
      read: readClaudeVersion,
      minimum: '2.1.318',
      upgrade: 'npm i -g @agentclientprotocol/claude-agent-acp@latest',
    },
    // ACP reports the adapter version, not the Claude Code version that owns provider routing and subprocesses.
    commandVersionOnly: true,
    usage: 'tokens-only',
    deliver(place, route) {
      return {
        env: {
          ...GATEWAY_DEFAULTS,
          ANTHROPIC_BASE_URL: place.baseURL,
          ...(route.upstream && route.upstream !== route.wire ? { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' } : {}),
          ...Object.fromEntries(GATEWAY_MODEL_NAMES.map(name => [name, route.model])),
        },
        sessionMeta: {
          claudeCode: {
            options: {
              settings: {
                apiKeyHelper: '',
                availableModels: place.models.map(model => model.id),
                modelPicker: {
                  replaceBuiltInOptions: true,
                  options: place.models.map(model => ({ model: model.id, label: model.id })),
                },
              },
            },
          },
        },
      }
    },
  },
  // Starting Claude Code runs the person's SessionStart hooks and loads their plugins, so its lists are read only on
  // request, as pi's are.
  catalogueRead: { when: 'request' },
  permission: {
    approvals: 'prompts',
    defaultEnv: {},
    // The adapter starts a session in Auto unless settings say otherwise, so every turn sets this first.
    expectedMode: 'default',
    // Planning sits below Manual: it edits nothing, though its commands may go to Claude's own classifier (notes).
    modeLadder: ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'],
    // Claude reports what its classifier denied (`readDenial`), not what it let run: a call that ran in `auto` is
    // recorded as run unasked.
    modeTiers: {
      plan: { tier: 'plan', line: '只看和规划，不改文件' },
      default: { tier: 'ask', line: '改文件或运行命令前问你' },
      acceptEdits: { tier: 'rule', line: '直接改文件，命令前问你' },
      auto: { tier: 'model', line: '由它的分类器判断' },
      bypassPermissions: { tier: 'never', line: '直接改文件和运行命令' },
    },
    modeAnswers: [
      // ExitPlanMode's one-time choice: leave the plan and ask before each edit.
      { optionId: 'exit-plan-default', mode: 'default' },
      // EnterPlanMode asks with the adapter's plain allow option on a mode-switching call.
      { optionId: 'allow-once', toolKind: 'switch_mode', mode: 'plan' },
    ],
    readback: 'mode',
    // Later 0.x adapters only; a new major version may start sessions or report modes differently.
    versionRule: { pattern: '^0\\.(?:99|[1-9]\\d{2,})\\.', message: 'Claude Agent 适配器需要 0.99 或之后的 0.x 版本' },
    // Where Claude Code keeps its settings and the login the adapter shares; a name, never a secret.
    inheritEnv: ['CLAUDE_CONFIG_DIR'],
    notes: [
      '工作目录内的读取、只读命令等 Claude 不需要批准的调用不会出现在 Latch 的审批里',
      '你在 Claude Code 设置里写的允许规则与 hooks 先于 Latch 生效，Latch 看不到',
      '自动模式下由 Claude 的分类器决定是否执行，不问你；计划模式下若自动模式可用，命令也可能由分类器决定',
      '项目的 .mcp.json 中的服务器会直接连接，不经询问',
    ],
  },
  // Claude asks before it reads or writes outside the session directory.
  folderAccess: 'primary-asks',
  // Project settings (permission rules, hooks, agents, skills) and MCP servers, from the session directory upwards.
  projectConfigPaths: ['.claude', '.mcp.json'],
  // Worktrees Claude creates for its own subagents.
  projectConfigManaged: { skip: ['.claude/worktrees'] },
  // The adapter's `--cli` hands the rest to the Claude CLI it ships, the one its sessions use; it is how the date a
  // sign-in ends is known without reading the login.
  loginStatus: {
    program: 'adapter',
    expires: true,
    args: ['--cli', 'auth', 'status', '--json'],
    read: ({ output }) => readClaudeStatus(output),
  },
  readDenial: readClaudeDenial,
  // Each window's share used and status as each turn reports them; Latch never sends `/usage` for them.
  quota: { update: claudeUsageQuota, error: claudeErrorQuota },
  // Checked on the adapter 2026-11-16: each answer counts its own turn, with cache reads and writes outside the input.
  usageScope: 'turn',
  inputExcludesCache: true,
}
