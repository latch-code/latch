import type { HarnessProfile } from './types.ts'

export const codexProfile: HarnessProfile = {
  presetId: 'codex',
  version: 1,
  permission: {
    approvals: 'prompts',
    defaultEnv: { INITIAL_AGENT_MODE: 'read-only' },
    expectedMode: 'read-only',
    modeLadder: ['read-only', 'workspace-write', 'agent-full-access'],
    forbiddenModes: ['agent'],
    // Accepting these would store a rule inside Codex that outlives the session.
    hiddenOptionIds: ['accept_execpolicy_amendment', 'apply_network_policy_amendment*'],
    readback: 'mode',
    notes: [],
  },
  // A trusted project's own config.toml, hooks, agents and exec policies, from the session directory up to its root.
  projectConfigPaths: ['.codex'],
}
