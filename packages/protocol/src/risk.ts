import type { ApprovalRiskReason, DeviceScope, ModeTier, PermissionTier } from './types.ts'

/**
 * Why the Host classed a built-in request as high risk, as one plain clause after the object it names (「写入 ~/.zshrc ·
 * 在项目文件夹之外」), in the words the approval drawer and the confirmation details both use.
 */
export const RISK_REASON_TEXT: Readonly<Record<ApprovalRiskReason, string>> = {
  'code-root': 'Latch 自己的代码',
  'protected-path': '受保护的文件',
  'outside-workspace': '在项目文件夹之外',
  'unresolved-path': '不是项目里的相对路径',
  'unlisted-tool': 'Latch 不认识的工具',
  'unparsable-arguments': '参数无法解析',
  'sensitive-field': '密码等敏感输入框',
  'mcp-tool': '远程 MCP 服务器的工具',
}

/**
 * Latch 内置's permission levels, strictest first. Each ID is its tier: the level decides who answers a call the Host
 * classed, never the class itself.
 */
export const BUILTIN_MODES = ['plan', 'ask', 'rule', 'model', 'never'] as const satisfies readonly PermissionTier[]
export type BuiltinMode = (typeof BUILTIN_MODES)[number]
/** Where every session of Latch 内置 starts: Latch never picks a wider level for anyone. */
export const BUILTIN_DEFAULT_MODE: BuiltinMode = 'ask'

/** Each level's line, in the words other Harnesses' levels use. */
export const BUILTIN_MODE_TIERS: Readonly<Record<BuiltinMode, ModeTier>> = {
  plan: { tier: 'plan', line: '只读项目；要改的一律不做' },
  ask: { tier: 'ask', line: '读项目不问；写文件每次问你' },
  rule: { tier: 'rule', line: '项目里的改动直接做；越界、插件和联网先问你' },
  model: { tier: 'model', line: '项目里的改动直接做；其余先由模型判断，拿不准问你' },
  never: { tier: 'never', line: '都不问你；Latch 自己的代码和密码框仍问' },
}

/** R2 reasons that ask the person at every level: Latch's own program folder, and a password, code, card or hidden field. */
export const ALWAYS_ASK_REASONS: readonly ApprovalRiskReason[] = ['code-root', 'sensitive-field']

/** A stored or requested level as one Latch 内置 has; anything else is undefined. */
export function builtinMode(value: unknown): BuiltinMode | undefined {
  return typeof value === 'string' && (BUILTIN_MODES as readonly string[]).includes(value) ? (value as BuiltinMode) : undefined
}

/**
 * The scopes a device needs, beside `run`, to put a Latch 内置 session at a level: the approvals that level answers for
 * the person. 按规则放行 runs R1 unasked, so it takes `approve:standard`; 由模型判断 and 不再询问 can run R2 unasked, so
 * they take `approve:elevated` too. A device that may not approve a call cannot choose a level that approves it.
 */
export function modeScopes(mode: BuiltinMode): DeviceScope[] {
  if (mode === 'rule') return ['approve:standard']
  if (mode === 'model' || mode === 'never') return ['approve:standard', 'approve:elevated']
  return []
}
