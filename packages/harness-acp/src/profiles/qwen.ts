import type { HarnessProfile } from './types.ts'

export const qwenProfile: HarnessProfile = {
  presetId: 'qwen',
  version: 1,
  permission: {
    approvals: 'prompts',
    defaultEnv: {},
    expectedMode: 'default',
    modeLadder: ['plan', 'default', 'auto-edit', 'auto', 'yolo'],
    modeTiers: {
      plan: { tier: 'plan', line: '只看和规划，不改文件' },
      default: { tier: 'ask', line: '改文件或运行命令前问你' },
      'auto-edit': { tier: 'rule', line: '直接改文件；运行命令前问你' },
      // The person's allow rules, read-only tools and edits inside the project (not `.git`, `package.json` and the like)
      // pass before its classifier; it asks when the classifier cannot decide, and reports no verdict.
      auto: { tier: 'model', line: '只读和改项目文件不问；其余由它的模型判断，可能判错' },
      yolo: { tier: 'never', line: '直接读写这台 Mac 上的文件并运行命令' },
    },
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
