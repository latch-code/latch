import type { HarnessProfile } from './types.ts'

export const dshProfile: HarnessProfile = {
  presetId: 'dsh',
  version: 1,
  permission: {
    approvals: 'prompts',
    defaultEnv: { DSH_PERMISSION_MODE: 'read-only' },
    readback: 'none',
    inheritEnv: ['DSH_HOME'],
    notes: ['无法读回权限模式'],
  },
  // DeepSeek Harness refuses additionalDirectories and keeps to the session directory.
  folderAccess: 'primary',
}
