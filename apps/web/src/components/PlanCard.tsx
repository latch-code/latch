import { Circle, CircleDot } from 'lucide-react'
import type { PlanEntry } from '@latch/protocol'
import { ICON_STROKE, StatusGlyph, CircleCheckGlyph } from '@latch/ui'

/**
 * `active`: the session is still running, so the step in progress is drawn in ink; once it settles that step reads as
 * unfinished. The step in progress is a still mark: the running tool already turns its spinner on its row. Nearer to now
 * reads stronger: done steps are the faintest. A step whose state changes while the page watches cross-fades its mark.
 */
export function PlanList({ plan, active }: { plan: PlanEntry[]; active: boolean }) {
  return (
    <ol className={active ? 'plan-list' : 'plan-list is-settled'}>
      {plan.map((entry, index) => (
        <li key={index} className={`plan-entry plan-${entry.status}`}>
          <StatusGlyph className="plan-icon" state={entry.status}>
            {entry.status === 'completed' ? (
              <CircleCheckGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} />
            ) : entry.status === 'in_progress' ? (
              <CircleDot size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} />
            ) : (
              <Circle size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} />
            )}
          </StatusGlyph>
          <span className="plan-text">{entry.content}</span>
          <span className="sr-only">
            {entry.status === 'completed' ? '，已完成' : entry.status === 'in_progress' ? (active ? '，进行中' : '，未完成') : '，待开始'}
          </span>
        </li>
      ))}
    </ol>
  )
}

export function planProgress(plan: PlanEntry[]) {
  const done = plan.filter(entry => entry.status === 'completed').length
  return { done, total: plan.length }
}
