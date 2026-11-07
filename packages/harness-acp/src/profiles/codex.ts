import type { HarnessProfile } from './types.ts'

export const codexProfile: HarnessProfile = {
  presetId: 'codex',
  version: 1,
  permission: {
    approvals: 'prompts',
    defaultEnv: { INITIAL_AGENT_MODE: 'read-only' },
    expectedMode: 'read-only',
    modeLadder: ['read-only', 'workspace-write', 'agent', 'agent-full-access'],
    // `agent` is codex-acp's 「Auto review」: the sandbox of `workspace-write`, with every request it would ask about decided
    // by Codex's own review model, which approves or denies and never passes one on.
    modeTiers: {
      'read-only': { tier: 'ask', line: '只读；改文件或联网前先问你' },
      'workspace-write': { tier: 'rule', line: '项目里直接改和运行；越界或联网前问你' },
      agent: { tier: 'model', line: '项目里直接做；越界或联网由它的模型判断，可能判错' },
      'agent-full-access': { tier: 'never', line: '直接读写这台 Mac 上的文件、联网并运行命令' },
    },
    reviewCallPrefix: 'guardian_assessment:',
    // Accepting these would store a rule inside Codex that outlives the session.
    hiddenOptionIds: ['accept_execpolicy_amendment', 'apply_network_policy_amendment*'],
    readback: 'mode',
    inheritEnv: ['CODEX_HOME', 'CODEX_SQLITE_HOME'],
    // codex-acp ships a Codex of its own and runs this one instead when it is named, so the person's version and login apply.
    programEnv: { CODEX_PATH: 'codex' },
    notes: [],
  },
  // codex-acp trusts every folder it receives and loads its `.agents/skills`; in workspace-write mode they are writable too.
  folders: { via: 'acp', configPaths: ['.codex', '.agents/skills'] },
  // A trusted project's own config.toml, hooks, agents and exec policies, from the session directory up to its root.
  projectConfigPaths: ['.codex'],
  // codex-acp configures one provider, `openai`, whose only API type is `openai`: Codex's Responses protocol. Its models are
  // then those the gateway lists that Codex itself knows.
  gateway: { wires: ['responses'], experimental: true, knownOnly: true, via: 'providers', providerId: 'openai', apiType: 'openai' },
  // The same Codex the sessions run: the adapter's `cli` runs the one `CODEX_PATH` names, else its own.
  catalogueRead: { codexModels: ['cli', 'app-server'] },
  // `codex --version` prints `codex-cli <version>`. Each pair is a codex-acp release and the `@openai/codex` range its
  // package.json depends on, from the npm registry: 2.3.0 ^0.164.0, 2.4.0 and 2.5.0 ^0.165.0.
  programVersion: {
    args: ['--version'],
    read: output => /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/u.exec(output)?.[1],
    checked: [
      { adapter: '^2\\.3\\.0$', program: '^0\\.164\\.\\d+$' },
      { adapter: '^2\\.[45]\\.0$', program: '^0\\.165\\.\\d+$' },
    ],
  },
  // Every failure exits 1 as well, so only its own sentence means logged out. API keys print partly here: nothing is kept.
  loginStatus: {
    args: ['login', 'status'],
    bundledArgs: ['cli', 'login', 'status'],
    read: ({ code, output }) =>
      code === 0 ? 'authenticated' : code === 1 && /\bNot logged in\b/u.test(output) ? 'unauthenticated' : 'unknown',
  },
}
