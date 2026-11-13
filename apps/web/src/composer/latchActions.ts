/** Shared action names and words for slash completion, typed interception and the command palette. */
export const LATCH_ACTIONS = [
  { name: 'clear', label: '清空上下文' },
  { name: 'btw', label: '旁支提问', inputHint: '问题' },
  { name: 'fork', label: '从最新一轮分叉', inputHint: '第一句（可选）' },
  { name: 'new', label: '新会话', inputHint: '第一句（可选）' },
  { name: 'model', label: '选择模型', inputHint: '筛选（可选）' },
  { name: 'think', label: '选择思考深度' },
  { name: 'permissions', label: '选择权限' },
  { name: 'changes', label: '打开改动' },
] as const

export type LatchActionName = (typeof LATCH_ACTIONS)[number]['name']
const NAMES = new Set<string>(LATCH_ACTIONS.map(action => action.name))
export const isLatchAction = (name: string): name is LatchActionName => NAMES.has(name)

/** Only the initial whole token is reserved. A path, a substring and inline prose remain ordinary text. */
export function latchActionOf(draft: string): { name: LatchActionName; argument: string } | undefined {
  const match = /^[/／]([^\s/／]+)(?:\s+([\s\S]*))?$/u.exec(draft.trimStart())
  const name = match?.[1]?.toLowerCase()
  if (!match || !name || !isLatchAction(name)) return undefined
  return { name, argument: (match[2] ?? '').trim() }
}
