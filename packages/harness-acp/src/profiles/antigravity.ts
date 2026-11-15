import type { HarnessProfile } from './types.ts'

const CUSTOMIZATIONS = ['.agents', '.agent', '_agents', '_agent', '.gemini/config.json'] as const

export const antigravityProfile: HarnessProfile = {
  presetId: 'antigravity',
  version: 2,
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
  minimumVersion: {
    args: ['--version'],
    read: output => /^\s*(\d+\.\d+\.\d+)\s*$/u.exec(output)?.[1],
    minimum: '1.5.8',
    upgrade: 'agy update',
  },
}
