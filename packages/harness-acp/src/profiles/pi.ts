import type { HarnessProfile } from './types.ts'

export const piProfile: HarnessProfile = {
  presetId: 'pi',
  version: 2,
  wire: 'pi',
  permission: {
    approvals: 'none',
    defaultEnv: {},
    readback: 'none',
    inheritEnv: ['PI_CODING_AGENT_DIR'],
    notes: ['pi 执行工具前不请求审批，只有扩展要求确认时才会问你'],
  },
  // pi has no other folders to receive and does not limit the paths its tools use.
  folderAccess: 'primary-unbounded',
  // What pi gates behind project trust: `.pi` settings, MCP servers, extensions, skills, prompts, themes and system
  // prompts, and `.agents/skills` in the session directory or above it. A trust decision can be saved for later runs.
  projectConfigPaths: ['.pi', '.agents/skills'],
  // Packages that project settings declare are installed below `.pi` by pi itself; the declarations are compared.
  projectConfigManaged: { skip: ['.pi/npm', '.pi/git'] },
  // Starting pi loads the person's extensions and runs their session hooks, so its lists are read only on request.
  catalogueRead: { when: 'request' },
}
