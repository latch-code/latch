import type { HarnessProfile } from './types.ts'

export const gooseProfile: HarnessProfile = {
  presetId: 'goose',
  version: 1,
  permission: {
    approvals: 'prompts',
    defaultEnv: { GOOSE_MODE: 'approve' },
    expectedMode: 'approve',
    modeLadder: ['chat', 'approve', 'auto'],
    forbiddenModes: ['smart_approve'],
    readback: 'mode',
    notes: [],
  },
}
