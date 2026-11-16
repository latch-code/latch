import { COMPUTER_TOOL_GROUPS, type HarnessInfo, type McpComputerCheck } from '@latch/protocol'

/**
 * 「操控这台 Mac」's tools as its settings list them: by group (看, 操作, 启动 App, …), in the driver's order within each,
 * and any tool no group names (new to Latch) under 其他. Empty groups are left out.
 */
export function computerToolSections(tools: readonly string[]): Array<{ id: string; label: string; tools: string[] }> {
  const sections = COMPUTER_TOOL_GROUPS.map(group => ({
    id: group.id,
    label: group.label,
    tools: tools.filter(tool => group.tools.includes(tool)),
  }))
  const grouped = new Set(COMPUTER_TOOL_GROUPS.flatMap(group => group.tools))
  const other = tools.filter(tool => !grouped.has(tool))
  return [...sections, { id: 'other', label: '其他', tools: other }].filter(section => section.tools.length > 0)
}

/** `a` against `b` by their `x.y.z` (a pre-release counts as its release); undefined when either is not one. */
function versionOrder(a: string, b: string): number | undefined {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)/u.exec(value)?.slice(1).map(Number)
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return undefined
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1
  return 0
}

/** The driver's version against the preset's minimum: in a word, with the minimum and the pinned release on hover. */
export function computerVersion(check: McpComputerCheck): { tone: 'done' | 'warn' | 'neutral'; text: string; title: string } {
  const title = `最低 ${check.minimum} · 安装命令 ${check.pinned}`
  if (!check.version) return { tone: 'neutral', text: '未知', title }
  const order = versionOrder(check.version, check.minimum)
  return { tone: order !== undefined && order >= 0 ? 'done' : 'warn', text: check.version, title }
}

/** The Harnesses that can use a local command such as this one: those that take Latch's MCP servers (`skills: 'server'`). */
export function computerHarnesses(harnesses: readonly HarnessInfo[]): Array<{ harness: HarnessInfo; usable: boolean }> {
  return harnesses.map(harness => ({ harness, usable: harness.skills === 'server' }))
}

/** The one-time note after the Host moved the preset's switches to new defaults: 「已按新默认调整 · 批量、启动 App 已开 · 整屏已关」. */
export function defaultsNote(moved: ReadonlyArray<'run_steps' | 'launch_app' | 'get_desktop_state'>): string {
  const on = [moved.includes('run_steps') && '批量', moved.includes('launch_app') && '启动 App'].filter(Boolean).join('、')
  // A space between Latin and Chinese, as everywhere in the UI: 「启动 App 已开」, 「批量已开」.
  const opened = on && `${on}${/[A-Za-z]$/u.test(on) ? ' ' : ''}已开`
  return ['已按新默认调整', opened, moved.includes('get_desktop_state') && '整屏已关'].filter(Boolean).join(' · ')
}
