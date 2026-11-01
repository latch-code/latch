import type { HarnessProfile } from './types.ts'

export const gooseProfile: HarnessProfile = {
  presetId: 'goose',
  version: 1,
  permission: {
    approvals: 'prompts',
    defaultEnv: { GOOSE_MODE: 'approve' },
    expectedMode: 'approve',
    modeLadder: ['chat', 'approve', 'smart_approve', 'auto'],
    neverAskModes: ['auto'],
    readback: 'mode',
    inheritEnv: ['GOOSE_PATH_ROOT', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'],
    notes: [],
  },
  // goose has no other folders to receive and does not limit the paths its tools use.
  folderAccess: 'primary-unbounded',
}
