import { antigravityQuotaCommand } from './antigravity-quota.ts'
import type { HarnessProfile } from './types.ts'

const CUSTOMIZATIONS = ['.agents', '.agent', '_agents', '_agent', '.gemini/config.json'] as const

export const antigravityProfile: HarnessProfile = {
  presetId: 'antigravity',
  // A launch test's login request changes nothing a session runs, so the version stays.
  version: 4,
  // Its own `/usage`, run beside a session: it starts no turn (checked on 1.5.8) and nothing waits for it.
  quota: { command: antigravityQuotaCommand },
  // Opening a session can load the person's hooks and plugins.
  catalogueRead: { when: 'request' },
  permission: {
    approvals: 'prompts',
    defaultEnv: {},
    expectedMode: 'default',
    // Plan adds instructions, not a tool boundary. It is deliberately not ordered as a stricter permission mode.
    modeLadder: ['default', 'accept-edits', 'auto'],
    modeTiers: {
      default: { tier: 'ask', name: '默认', line: '沿用 Antigravity 的工具权限规则' },
      'accept-edits': { tier: 'rule', line: '直接修改目录内文件，命令按自身规则询问' },
      auto: { tier: 'model', line: '自动改文件和评估命令，风险操作询问' },
    },
    // Plan is drawn as writing a plan, neither a second 默认 nor read-only (its docs: modes, planning).
    modeGlyphs: { plan: 'plan' },
    readback: 'mode',
    notes: ['Antigravity 的允许规则与 toolPermission 设置仍然生效；规划模式不保证只读'],
  },
  // Without a login its session/list is `-32000 Authentication required`; with one it lists, opening no session and
  // running no turn (1.5.11, checked 2026-11-19 in a temporary HOME, the login side with a Gemini API key).
  loginRequest: 'session/list',
  // Latch points it at no model service of another's. Its 1.5.x changelog and settings documentation describe a Gemini
  // API key route (`modelProvider: "gemini"`, `GEMINI_API_KEY`, and `GOOGLE_GEMINI_BASE_URL` for another address, the
  // last in the changelog only); whether requests reach that address was not checked, and the gateway has no Gemini
  // protocol. Display only.
  ownModelsOnly: true,
  folders: { via: 'acp', configPaths: CUSTOMIZATIONS },
  projectConfigPaths: CUSTOMIZATIONS,
  // 1.5.8 answers session/resume with its default model and thinking level (recorded 2026-11-15).
  resumeResetsOptions: true,
  // All a turn its backend refused says (agy 1.5.8, observed 2026-11-15): no error and no reason reach ACP.
  terminatedReplies: ['⚠ Agent execution terminated due to error.'],
  minimumVersion: {
    args: ['--version'],
    read: output => /^\s*(\d+\.\d+\.\d+)\s*$/u.exec(output)?.[1],
    minimum: '1.5.8',
    upgrade: 'agy update',
  },
}
