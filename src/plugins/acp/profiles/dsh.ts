import type { HarnessProfile } from './types.ts'

export const dshProfile: HarnessProfile = {
  presetId: 'dsh',
  version: 1,
  permission: {
    approvals: 'prompts',
    defaultEnv: { DSH_PERMISSION_MODE: 'read-only' },
    readback: 'none',
    notes: ['无法读回权限模式'],
  },
}
