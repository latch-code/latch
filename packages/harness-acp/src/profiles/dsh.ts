import { bareVersion } from '../version-line.ts'
import type { HarnessProfile } from './types.ts'

export const dshProfile: HarnessProfile = {
  presetId: 'dsh',
  version: 1,
  // An empty session runs no turn and calls no model.
  catalogueRead: { when: 'select' },
  permission: {
    approvals: 'prompts',
    // DeepSeek Harness takes any non-empty DSH_TELEMETRY_DISABLED as off.
    defaultEnv: { DSH_PERMISSION_MODE: 'read-only', DSH_TELEMETRY_DISABLED: '1' },
    readback: 'none',
    inheritEnv: ['DSH_HOME'],
    notes: ['无法读回权限模式'],
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
    minimum: '0.2.1-rc.1',
    upgrade: 'npm i -g @deepseek-ai/dsh@latest',
  },
}
