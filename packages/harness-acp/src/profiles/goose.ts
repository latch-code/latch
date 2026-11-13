import type { HarnessProfile } from './types.ts'

export const gooseProfile: HarnessProfile = {
  presetId: 'goose',
  version: 1,
  // An empty session runs no turn and calls no model.
  catalogueRead: { when: 'select' },
  permission: {
    approvals: 'prompts',
    defaultEnv: { GOOSE_MODE: 'approve' },
    expectedMode: 'approve',
    modeLadder: ['chat', 'approve', 'smart_approve', 'auto'],
    // Tools the person set to always allow in goose run without asking in `approve` and `smart_approve` alike.
    modeTiers: {
      chat: { tier: 'plan', line: '只聊天，不用工具' },
      approve: { tier: 'ask', line: '运行工具前问你' },
      smart_approve: { tier: 'model', line: '只读的不问，其余问你' },
      auto: { tier: 'never', line: '直接运行所有工具' },
    },
    readback: 'mode',
    inheritEnv: ['GOOSE_PATH_ROOT', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'],
    notes: [],
  },
  // goose has no other folders to receive and does not limit the paths its tools use.
  folderAccess: 'primary-unbounded',
}
