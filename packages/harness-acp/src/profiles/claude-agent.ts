import { claudeErrorQuota, claudeUsageQuota } from '../quota.ts'
import type { ModelRoute } from '@latch/sdk'
import type { GatewayPlace, HarnessProfile, LoginCheck, SessionUpdate, ToolDenial } from './types.ts'

const DAY_MS = 24 * 60 * 60_000

/** `claude --version`, or the adapter's `--cli --version`, which reports the same native binary its SDK sessions run. */
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
  // The gateway has already tried again what heals in seconds and marks the rest `x-should-retry: false`; what is left
  // for Claude Code is a reply that broke off, which only it can send again (code.claude.com/docs/en/errors, "Automatic
  // retries"; its default is 10).
  CLAUDE_CODE_MAX_RETRIES: '2',
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

/**
 * The window the service declared for the model this process starts on, as Claude Code's settings take it
 * (code.claude.com/docs/en/model-config, "Correct the window for a gateway or custom model ID" and "Set the auto-compact
 * window"). `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is the window of an ID Claude Code does not know, which it otherwise takes
 * for 1M (2.1.327; the adapter's own Claude Code may assume less); it does nothing for an ID Claude Code knows.
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is when to compact, for any ID, but only from 100,000 to 1,000,000 and never above the
 * window Claude Code assumes. With nothing declared Claude Code's own window stays.
 */
function claudeWindow(declared: number | undefined): Record<string, string> {
  if (!declared) return {}
  return {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(declared),
    ...(declared >= 100_000 && declared <= 1_000_000 ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(declared) } : {}),
  }
}

/** What Claude needs to send its model calls to Latch's gateway, through the adapter or directly: the same either way. */
function claudeGatewayDeliver(place: GatewayPlace, route: ModelRoute) {
  return {
    env: {
      ...GATEWAY_DEFAULTS,
      ANTHROPIC_BASE_URL: place.baseURL,
      ...(route.upstream && route.upstream !== route.wire ? { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' } : {}),
      ...Object.fromEntries(GATEWAY_MODEL_NAMES.map(name => [name, route.model])),
      // Per process, like the model above: a model changed inside the session takes its window at the next start.
      ...claudeWindow(place.models.find(model => model.id === route.model)?.capabilities?.contextTokens),
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
}

const CLAUDE_GATEWAY_ENV_NAMES = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  ...Object.keys(GATEWAY_DEFAULTS),
  ...GATEWAY_MODEL_NAMES,
]

/**
 * Claude Code's permission modes and how Latch reads each, the same whether the adapter or the SDK drives it: the
 * adapter's mode IDs are Claude Code's own.
 */
const CLAUDE_PERMISSION = {
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
  // Where Claude Code keeps its settings and its login; a name, never a secret.
  inheritEnv: ['CLAUDE_CONFIG_DIR'],
  notes: [
    '工作目录内的读取、只读命令等 Claude 不需要批准的调用不会出现在 Latch 的审批里',
    '你在 Claude Code 设置里写的允许规则与 hooks 先于 Latch 生效，Latch 看不到',
    '自动模式下由 Claude 的分类器决定是否执行，不问你；计划模式下若自动模式可用，命令也可能由分类器决定',
    '项目的 .mcp.json 中的服务器会直接连接，不经询问',
  ],
} satisfies HarnessProfile['permission']

/** What Claude's profiles share besides permissions: the session directory, its project files and the plan it proposes. */
const CLAUDE_SHARED = {
  // Claude asks before it reads or writes outside the session directory.
  folderAccess: 'primary-asks',
  // Project settings (permission rules, hooks, agents, skills) and MCP servers, from the session directory upwards.
  projectConfigPaths: ['.claude', '.mcp.json'],
  // Worktrees Claude creates for its own subagents.
  projectConfigManaged: { skip: ['.claude/worktrees'] },
  readDenial: readClaudeDenial,
  // ExitPlanMode: asked with the `exit-plan-*` options and the plan in the call's input. Leaving the plan to ask before
  // each edit; the other exits widen the mode or swap the context, so they are never offered.
  planAnswers: ['exit-plan-default'],
  readPlan(toolCall, options) {
    const input = toolCall.rawInput
    if (!options.some(option => option.optionId.startsWith('exit-plan-'))) return undefined
    return input && typeof input === 'object' && typeof (input as { plan?: unknown }).plan === 'string'
      ? (input as { plan: string }).plan
      : undefined
  },
  // Each window's share used and status as each turn reports them; Latch never sends `/usage` for them.
  quota: { update: claudeUsageQuota, error: claudeErrorQuota },
  // Checked on the adapter 2026-11-16: each answer counts its own turn, with cache reads and writes outside the input.
  usageScope: 'turn',
  inputExcludesCache: true,
} satisfies Partial<HarnessProfile>

/** The gateway as Claude Code takes it, through the adapter or directly; only the version check differs. */
const CLAUDE_GATEWAY = {
  via: 'launch',
  wires: ['anthropic-messages'],
  tokenEnv: 'ANTHROPIC_AUTH_TOKEN',
  envNames: CLAUDE_GATEWAY_ENV_NAMES,
  templates: { session: 2 },
  models: { value: (id: string) => id, id: (value: string) => value || undefined, reportedOnly: true },
  // Default hands effort back to Claude, which then sends `high` of its own (2.1.318).
  defaultThinking: 'default',
  // ACP reports the adapter version, not the Claude Code version that owns provider routing and subprocesses.
  commandVersionOnly: true,
  usage: 'tokens-only',
  deliver: claudeGatewayDeliver,
} as const

/** Claude Code through the ACP adapter `claude-agent-acp`: what a definition on the adapter runs with. */
export const claudeAgentProfile: HarnessProfile = {
  presetId: 'claude-agent',
  version: 4,
  gateway: {
    ...CLAUDE_GATEWAY,
    wires: [...CLAUDE_GATEWAY.wires],
    minimumVersion: {
      args: ['--cli', '--version'],
      read: readClaudeVersion,
      minimum: '2.1.318',
      upgrade: 'npm i -g @agentclientprotocol/claude-agent-acp@latest',
    },
  },
  // Starting Claude Code runs the person's SessionStart hooks and loads their plugins, so its lists are read only on
  // request, as pi's are.
  catalogueRead: { when: 'request' },
  permission: {
    ...CLAUDE_PERMISSION,
    // Later 0.x adapters only; a new major version may start sessions or report modes differently.
    versionRule: { pattern: '^0\\.(?:99|[1-9]\\d{2,})\\.', message: 'Claude Agent 适配器需要 0.99 或之后的 0.x 版本' },
  },
  ...CLAUDE_SHARED,
  // The adapter's `--cli` hands the rest to the Claude CLI it ships, the one its sessions use; it is how the date a
  // sign-in ends is known without reading the login.
  loginStatus: {
    program: 'adapter',
    expires: true,
    args: ['--cli', 'auth', 'status', '--json'],
    read: ({ output }) => readClaudeStatus(output),
  },
}

/** The oldest Claude Code the direct wire runs: the one the SDK it is built on ships (`claudeCodeVersion` of 0.3.322). */
const CLAUDE_DIRECT_MINIMUM = '2.1.322'
const CLAUDE_UPGRADE = 'npm i -g @anthropic-ai/claude-code@latest'

/**
 * Claude Code itself, driven through the official Claude Agent SDK (`wires/claude.ts`): the person's own `claude`, its
 * own login and settings. Mode, option and session IDs are the adapter's, so a session goes on whichever route runs it.
 */
export const claudeProfile: HarnessProfile = {
  presetId: 'claude-agent',
  version: 1,
  wire: 'claude',
  gateway: {
    ...CLAUDE_GATEWAY,
    wires: [...CLAUDE_GATEWAY.wires],
    minimumVersion: { args: ['--version'], read: readClaudeVersion, minimum: CLAUDE_DIRECT_MINIMUM, upgrade: CLAUDE_UPGRADE },
  },
  catalogueRead: { when: 'request' },
  // A new `query()` on a resumed session starts at Claude's default effort and the model `claude` resumes with, so what
  // the session showed is set again before the next prompt.
  resumeResetsOptions: true,
  permission: CLAUDE_PERMISSION,
  ...CLAUDE_SHARED,
  minimumVersion: { args: ['--version'], read: readClaudeVersion, minimum: CLAUDE_DIRECT_MINIMUM, upgrade: CLAUDE_UPGRADE },
  loginStatus: {
    expires: true,
    args: ['auth', 'status', '--json'],
    read: ({ output }) => readClaudeStatus(output),
  },
}
