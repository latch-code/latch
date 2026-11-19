import { CURSOR_SDK_MODES } from '../wires/cursor.ts'
import type { HarnessProfile } from './types.ts'

/**
 * Cursor through its official SDK (`wires/cursor.ts`), chosen for a Cursor definition that carries `CURSOR_API_KEY`
 * (`permission.ts`). The SDK has no per-call approval: its tools run unasked, limited only by the toolset and the
 * sandbox the runner creates the agent with. So no mode here asks, the strictest is the default, and a session that
 * asks for a mode outside these is refused rather than run on a wider one.
 */
export const cursorSdkProfile: HarnessProfile = {
  presetId: 'cursor',
  version: 1,
  wire: 'cursor',
  ownModelsOnly: true,
  thinkingInModel: true,
  // Opening a session lists the account's models and creates a local agent in a private folder: no turn, no model call,
  // and only the project's own settings, of which an empty folder has none.
  catalogueRead: { when: 'select' },
  // The runner reports each run's tokens once it ends.
  usageScope: 'turn',
  // A resumed agent starts on the account's default model (the SDK keeps no model with it): set again before the next turn.
  resumeResetsOptions: true,
  permission: {
    approvals: 'none',
    defaultEnv: {},
    expectedMode: 'read-only',
    modeLadder: CURSOR_SDK_MODES,
    modeTiers: {
      'read-only': { tier: 'plan', name: '只读', line: '只给读取与搜索工具；没有命令、写入、子 Agent 与 MCP。' },
      sandbox: { tier: 'rule', name: '沙箱', line: '命令在 Cursor 沙箱里运行，写入限工作目录与临时目录，默认不联网；不问你。' },
      full: { tier: 'never', name: '完全访问', line: '不加沙箱，所有工具不问你。' },
    },
    readback: 'mode',
    notes: [
      'Cursor 的 SDK 没有逐次询问：只读靠工具名单，沙箱靠 Cursor 自己的沙箱，其余不问你；要逐次询问请用 cursor-agent acp 路线',
      '项目里 .cursor 下的规则、钩子与沙箱设置照常生效；它们计入启动指纹',
    ],
  },
  // Project rules, hooks, sandbox and MCP settings, as for the ACP route.
  projectConfigPaths: ['.cursor', '.cursorrules'],
}
