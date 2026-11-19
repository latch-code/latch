import { bareVersion } from '../version-line.ts'
import type { HarnessProfile } from './types.ts'
import { prefixedModels } from './gateway-model.ts'
import { deliverPiGateway, PI_GATEWAY_PROVIDER, piGatewayBudget, piGatewayStartupFailure } from './pi-gateway.ts'

export const piProfile: HarnessProfile = {
  presetId: 'pi',
  version: 8,
  wire: 'pi',
  gateway: {
    via: 'launch',
    wires: ['chat-completions', 'responses', 'anthropic-messages'],
    tokenEnv: 'LMG_TOKEN',
    envNames: [],
    templates: { args: 1, files: 1 },
    models: { ...prefixedModels(PI_GATEWAY_PROVIDER), reportedOnly: true },
    runtimeBudget: piGatewayBudget,
    startupFailure: piGatewayStartupFailure,
    minimumVersion: {
      args: ['--version'],
      read: bareVersion,
      minimum: '1.5.0',
      upgrade: 'npm i -g @earendil-works/pi-coding-agent@latest',
    },
    deliver: deliverPiGateway,
  },
  // pi itself never asks; Latch's own pi extension (`wires/pi-gate.ts`) asks or blocks before a tool runs, holds the
  // level and reports it, and only the wire can change it.
  permission: {
    approvals: 'prompts',
    defaultEnv: {},
    expectedMode: 'ask',
    modeLadder: ['plan', 'ask', 'rule', 'never'],
    modeTiers: {
      plan: { tier: 'plan', line: '只读文件，改文件和命令被拦下' },
      ask: { tier: 'ask', line: '读文件不问，其余问你' },
      rule: { tier: 'rule', line: '直接改文件，命令前问你' },
      never: { tier: 'never', line: '直接改文件和运行命令' },
    },
    readback: 'mode',
    // Where pi keeps its sessions, as in the person's terminal: the same files are listed for 接入已有会话.
    inheritEnv: ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR'],
    notes: [
      '权限由 Latch 随 pi 启动的扩展执行：只有 read、grep、find、ls 不问；其他扩展与 MCP 的工具和命令一样先问你',
      'pi 的其他扩展在 Latch 的询问之外运行，它们可以自己执行任何事',
    ],
  },
  // pi's RPC has no command that lists sessions: Latch reads pi's own session files (`pi-store.ts`), never through pi, and
  // offers them only where the start script lets the Host read CLI stores. pi keeps no lock on a session file.
  historyImport: { version: '.*', useUnknown: true },
  // pi has no other folders to receive and does not limit the paths its tools use.
  folderAccess: 'primary-unbounded',
  // What pi gates behind project trust: `.pi` settings, MCP servers, extensions, skills, prompts, themes and system
  // prompts, and `.agents/skills` in the session directory or above it. A trust decision can be saved for later runs.
  projectConfigPaths: ['.pi', '.agents/skills'],
  // Packages that project settings declare are installed below `.pi` by pi itself; the declarations are compared.
  projectConfigManaged: { skip: ['.pi/npm', '.pi/git'] },
  // Starting pi loads the person's extensions and runs their session hooks, so its lists are read only on request.
  // `pi --list-models` builds the same runtime with the extensions before it lists, and says only whether a model thinks.
  catalogueRead: { when: 'request' },
  // `pi --version` prints the bare version and exits before loading extensions. The wire's own `clear_queue` check
  // stays for a pi that prints none.
  minimumVersion: {
    args: ['--version'],
    read: bareVersion,
    minimum: '0.84.4',
    upgrade: 'npm i -g @earendil-works/pi-coding-agent@latest',
  },
}
