import { antigravityQuotaCommand } from './antigravity-quota.ts'
import type { HarnessProfile } from './types.ts'

const CUSTOMIZATIONS = ['.agents', '.agent', '_agents', '_agent', '.gemini/config.json'] as const

export const antigravityProfile: HarnessProfile = {
  presetId: 'antigravity',
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
    readback: 'mode',
    notes: ['Antigravity 的允许规则与 toolPermission 设置仍然生效；规划模式不保证只读'],
  },
  // It takes no model provider of another's: `--help` has only `--model` and `models`, and `cloud_code_endpoint` is
  // Google's own address. Display only.
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
