import type { HarnessProfile } from './types.ts'

export const qwenProfile: HarnessProfile = {
  presetId: 'qwen',
  version: 1,
  permission: {
    approvals: 'prompts',
    defaultEnv: {},
    expectedMode: 'default',
    modeLadder: ['plan', 'default', 'auto-edit', 'auto', 'yolo'],
    neverAskModes: ['yolo'],
    readback: 'mode',
    inheritEnv: ['QWEN_HOME', 'QWEN_RUNTIME_DIR'],
    notes: ['恢复会话会恢复旧模式，Latch 每轮前重新设置'],
  },
  // As in Gemini CLI: the process arguments apply to its ACP sessions, and the value is split on commas.
  folders: { via: 'args', flag: '--include-directories', maxExtra: 4 },
  // Workspace settings, commands, agents and extensions, as in Gemini CLI from which Qwen Code derives.
  projectConfigPaths: ['.qwen'],
  // Qwen Code names the tool a call runs only in `_meta.toolName`, where ACP has `name`.
  normalizeUpdate(update) {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return update
    const meta = update._meta
    const named = typeof meta === 'object' && meta !== null ? (meta as { toolName?: unknown }).toolName : undefined
    return update.name == null && typeof named === 'string' && named ? { ...update, name: named } : update
  },
}
