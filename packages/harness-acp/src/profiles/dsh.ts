import { bareVersion } from '../version-line.ts'
import type { HarnessProfile } from './types.ts'
import { DSH_MODES, prepareDshMode, readDshMode } from './dsh-mode.ts'

export const dshProfile: HarnessProfile = {
  presetId: 'dsh',
  version: 2,
  processMode: { prepare: prepareDshMode, read: readDshMode },
  // dsh-acp offers `reasoning_effort` when the exact model declares one (its README).
  thinkingPerModel: true,
  // An empty session runs no turn and calls no model.
  catalogueRead: { when: 'select' },
  permission: {
    approvals: 'prompts',
    // DeepSeek Harness takes any non-empty DSH_TELEMETRY_DISABLED as off.
    defaultEnv: { DSH_PERMISSION_MODE: 'read-only', DSH_TELEMETRY_DISABLED: '1' },
    expectedMode: 'read-only',
    modeLadder: [...DSH_MODES],
    modeTiers: {
      'read-only': { tier: 'plan', line: '只读，不改文件' },
      'workspace-write': { tier: 'rule', line: '直接写工作目录与允许的临时目录；扩大范围前问你' },
      'danger-full-access': { tier: 'never', line: '直接改文件和运行命令' },
    },
    readback: 'mode',
    inheritEnv: ['DSH_HOME'],
    notes: ['Latch 的私有插件通过 DeepSeek Harness 的权限服务设置和读回档位；空闲时换档会重启并恢复会话'],
  },
  // DeepSeek Harness refuses additionalDirectories and keeps to the session directory.
  folderAccess: 'primary',
  // `dsh --version` prints the bare version. Before 0.1.2 there is no `acp` profile: `dsh --profile acp` exits with
  // "profile does not exist", or a profile of that name made by hand boots something that never answers ACP. Until
  // 0.2.1-rc.1, @deepseek-ai/dsh-acp settled a prompt when the root agent went idle, with subagents still running, and a
  // cancel did not wait for them (its README of 0.2.0-rc.2 and 0.2.1-rc.1); a stop then is not a real settlement.
  minimumVersion: {
    args: ['--version'],
    read: bareVersion,
    minimum: '0.2.2-rc.1',
    upgrade: 'npm i -g @deepseek-ai/dsh@latest',
  },
}
