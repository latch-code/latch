import type { BoardGroup } from '@latch/protocol'
import { Icon, PullRequestGlyph, RunningGlyph, WaitingGlyph, type IconComponent } from '@latch/ui'

const COUNTED = [
  { group: 'attention', label: '等你处理', icon: WaitingGlyph },
  { group: 'running', label: '进行中', icon: RunningGlyph },
  { group: 'deliver', label: '可交付', icon: PullRequestGlyph },
] as const satisfies readonly { group: BoardGroup; label: string; icon: IconComponent }[]

/**
 * The start screen's one line under its input: 等你处理 · 进行中 · 可交付, each only while it is not zero, amber only for
 * 等你处理. Each opens 看板 on its group. The line keeps its height when it is empty, so the input never moves.
 */
export function StartCounts({ counts, onGroup }: { counts: Record<BoardGroup, number>; onGroup: (group: BoardGroup) => void }) {
  const shown = COUNTED.filter(item => counts[item.group] > 0)
  return (
    <nav className="start-counts" aria-label="看板" data-empty={shown.length === 0 ? '' : undefined}>
      {shown.map(item => (
        <button
          key={item.group}
          type="button"
          className="start-count"
          data-group={item.group}
          onClick={() => {
            onGroup(item.group)
          }}>
          <Icon icon={item.icon} size={12} />
          <span className="start-count-value">{counts[item.group]}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  )
}
