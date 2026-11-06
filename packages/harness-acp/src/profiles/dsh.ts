import type { HarnessProfile } from './types.ts'

export const dshProfile: HarnessProfile = {
  presetId: 'dsh',
  version: 1,
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
}
