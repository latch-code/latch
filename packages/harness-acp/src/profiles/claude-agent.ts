import type { HarnessProfile } from './types.ts'

export const claudeAgentProfile: HarnessProfile = {
  presetId: 'claude-agent',
  version: 1,
  permission: {
    approvals: 'prompts',
    defaultEnv: {},
    // The adapter starts a session in Auto unless settings say otherwise, so every turn sets this first.
    expectedMode: 'default',
    // Planning sits below Manual: it edits nothing, though its commands may go to Claude's own classifier (notes).
    modeLadder: ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'],
    neverAskModes: ['bypassPermissions'],
    modeAnswers: [
      // ExitPlanMode's one-time choice: leave the plan and ask before each edit.
      { optionId: 'exit-plan-default', mode: 'default' },
      // EnterPlanMode asks with the adapter's plain allow option on a mode-switching call.
      { optionId: 'allow-once', toolKind: 'switch_mode', mode: 'plan' },
    ],
    readback: 'mode',
    // Later 0.x adapters only; a new major version may start sessions or report modes differently.
    versionRule: { pattern: '^0\\.(?:99|[1-9]\\d{2,})\\.', message: 'Claude Agent 适配器需要 0.99 或之后的 0.x 版本' },
    // Where Claude Code keeps its settings and the login the adapter shares; a name, never a secret.
    inheritEnv: ['CLAUDE_CONFIG_DIR'],
    notes: [
      '工作目录内的读取、只读命令等 Claude 不需要批准的调用不会出现在 Latch 的审批里',
      '你在 Claude Code 设置里写的允许规则与 hooks 先于 Latch 生效，Latch 看不到',
      '自动模式下由 Claude 的分类器决定是否执行，不问你；计划模式下若自动模式可用，命令也可能由分类器决定',
      '项目的 .mcp.json 中的服务器会直接连接，不经询问',
    ],
  },
  // Claude asks before it reads or writes outside the session directory.
  folderAccess: 'primary-asks',
  // Project settings (permission rules, hooks, agents, skills) and MCP servers, from the session directory upwards.
  projectConfigPaths: ['.claude', '.mcp.json'],
  // Worktrees Claude creates for its own subagents.
  projectConfigManaged: { skip: ['.claude/worktrees'] },
}
