import { COMPUTER_TOOL_GROUPS, type HarnessInfo, type McpComputerCheck } from '@latch/protocol'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    other: '其他',
    updated: '已按新默认调整',
    off: '整屏已关',
    unknown: '未知',
    version: (minimum: string, pinned: string) => `最低 ${minimum} · 安装命令 ${pinned}`,
    enabled: (batch: boolean, launch: boolean) => {
      const on = [batch && '批量', launch && '启动 App'].filter(Boolean).join('、')
      return on && `${on}${launch ? ' ' : ''}已开`
    },
  },
  {
    other: 'Other',
    updated: 'Updated to the new defaults',
    off: 'Entire screen off',
    unknown: 'Unknown',
    version: (minimum: string, pinned: string) => `Minimum ${minimum} · Install command ${pinned}`,
    enabled: (batch: boolean, launch: boolean) => [batch && 'Batch actions on', launch && 'Launch app on'].filter(Boolean).join(' · '),
  },
)

const GROUP_COPY = defineCopy<Partial<Record<string, string>>>(
  {},
  {
    look: 'Inspect',
    act: 'Actions',
    launch: 'Launch apps',
    batch: 'Batch actions',
    script: 'Scripts',
    browser: 'Browser',
    clipboard: 'Clipboard',
    record: 'Screen recording',
    manage: 'Manage',
  },
)

/**
 * 「操控这台 Mac」's tools as its settings list them: by group (看, 操作, 启动 App, …), in the driver's order within each,
 * and any tool no group names (new to Latch) under 其他. Empty groups are left out.
 */
export function computerToolSections(tools: readonly string[]): Array<{ id: string; label: string; tools: string[] }> {
  const sections = COMPUTER_TOOL_GROUPS.map(group => ({
    id: group.id,
    label: GROUP_COPY[group.id] ?? group.label,
    tools: tools.filter(tool => group.tools.includes(tool)),
  }))
  const grouped = new Set(COMPUTER_TOOL_GROUPS.flatMap(group => group.tools))
  const other = tools.filter(tool => !grouped.has(tool))
  return [...sections, { id: 'other', label: COPY.other, tools: other }].filter(section => section.tools.length > 0)
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
  const title = COPY.version(check.minimum, check.pinned)
  if (!check.version) return { tone: 'neutral', text: COPY.unknown, title }
  const order = versionOrder(check.version, check.minimum)
  return { tone: order !== undefined && order >= 0 ? 'done' : 'warn', text: check.version, title }
}

/** The Harnesses that can use a local command such as this one: those that take Latch's MCP servers (`skills: 'server'`). */
export function computerHarnesses(harnesses: readonly HarnessInfo[]): Array<{ harness: HarnessInfo; usable: boolean }> {
  return harnesses.map(harness => ({ harness, usable: harness.skills === 'server' }))
}

/** The one-time note after the Host moved the preset's switches to new defaults: 「已按新默认调整 · 批量、启动 App 已开 · 整屏已关」. */
export function defaultsNote(moved: ReadonlyArray<'run_steps' | 'launch_app' | 'get_desktop_state'>): string {
  const opened = COPY.enabled(moved.includes('run_steps'), moved.includes('launch_app'))
  return [COPY.updated, opened, moved.includes('get_desktop_state') && COPY.off].filter(Boolean).join(' · ')
}
