import type { HarnessProfile } from './types.ts'

export const codexProfile: HarnessProfile = {
  presetId: 'codex',
  version: 1,
  permission: {
    approvals: 'prompts',
    defaultEnv: { INITIAL_AGENT_MODE: 'read-only' },
    expectedMode: 'read-only',
    modeLadder: ['read-only', 'workspace-write', 'agent-full-access'],
    neverAskModes: ['agent-full-access'],
    forbiddenModes: ['agent'],
    // Accepting these would store a rule inside Codex that outlives the session.
    hiddenOptionIds: ['accept_execpolicy_amendment', 'apply_network_policy_amendment*'],
    readback: 'mode',
    notes: [],
  },
  // codex-acp trusts every folder it receives and loads its `.agents/skills`; in workspace-write mode they are writable too.
  folders: { via: 'acp', configPaths: ['.codex', '.agents/skills'] },
  // A trusted project's own config.toml, hooks, agents and exec policies, from the session directory up to its root.
  projectConfigPaths: ['.codex'],
}
