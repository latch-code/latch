import type { HarnessProfile } from './types.ts'

export const qwenProfile: HarnessProfile = {
  presetId: 'qwen',
  version: 1,
  permission: {
    approvals: 'prompts',
    defaultEnv: {},
    expectedMode: 'default',
    modeLadder: ['plan', 'default', 'auto-edit', 'yolo'],
    forbiddenModes: ['auto'],
    readback: 'mode',
    notes: ['恢复会话会恢复旧模式，Latch 每轮前重新设置'],
  },
  // Workspace settings, commands, agents and extensions, as in Gemini CLI from which Qwen Code derives.
  projectConfigPaths: ['.qwen'],
}
