import type { HarnessProfile } from './types.ts'

export const piProfile: HarnessProfile = {
  presetId: 'pi',
  version: 1,
  permission: {
    approvals: 'none',
    defaultEnv: {},
    readback: 'none',
    notes: ['pi 执行工具前不请求审批'],
  },
  // What pi gates behind project trust: `.pi` settings, MCP servers, extensions, skills, prompts, themes and system
  // prompts, and `.agents/skills` in the session directory or above it. A trust decision can be saved for later runs.
  projectConfigPaths: ['.pi', '.agents/skills'],
  // Packages that project settings declare are installed below `.pi` by pi itself; the declarations are compared.
  projectConfigManaged: { skip: ['.pi/npm', '.pi/git'] },
}
