import type { HarnessProfile } from './types.ts'

export const grokProfile: HarnessProfile = {
  presetId: 'grok',
  version: 1,
  // SessionStart hooks and project plugins may run before the first prompt.
  catalogueRead: { when: 'request' },
  permission: {
    approvals: 'prompts',
    defaultEnv: {},
    // Grok 1.0.77 reports model and reasoning_effort, but no ACP permission option or current_mode_update.
    readback: 'none',
    inheritEnv: ['GROK_HOME'],
    configEnv: ['GROK_*'],
    notes: ['Grok 以 default 启动，仍按自己的权限规则运行；当前 ACP 接口不报告有效权限档位'],
  },
  projectConfigPaths: ['.grok'],
  minimumVersion: {
    args: ['--version'],
    read: output => /^grok (\d+\.\d+\.\d+)(?:\s|$)/u.exec(output.trim())?.[1],
    minimum: '1.0.77',
    upgrade: 'grok update',
  },
}
