import { ChevronDown, Circle, CircleCheck, CircleDot } from 'lucide-react'
import type { PlanEntry } from '@latch/protocol'
import { ICON_STROKE, Popover, StatusGlyph, type MenuTriggerProps } from '@latch/ui'

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
              <CircleCheck size={14} strokeWidth={ICON_STROKE[14]} />
            ) : entry.status === 'in_progress' ? (
              <CircleDot size={14} strokeWidth={ICON_STROKE[14]} />
            ) : (
              <Circle size={14} strokeWidth={ICON_STROKE[14]} />
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

/** The chip that opens the plan, for `n` of `total` steps done. */
const planTrigger = (done: number, total: number) =>
  function PlanTrigger(props: MenuTriggerProps) {
    return (
      <button {...props} type="button" className="plan-chip" aria-label={`计划 ${done}/${total}`}>
        <span>
          计划 {done}/{total}
        </span>
        <ChevronDown size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
      </button>
    )
  }

/**
 * The running harness's latest plan as a chip in the run bar, 「计划 2/4」; it opens the whole list in a 320-wide layer
 * headed 「计划」 with its count (on phones a bottom sheet whose title carries the count, so the list has no head of its
 * own there).
 */
export function PlanChip({ plan }: { plan: PlanEntry[] }) {
  const { done, total } = planProgress(plan)
  return (
    <Popover
      label="计划"
      title={
        <>
          计划 <span className="plan-sheet-count">{`${done}/${total}`}</span>
        </>
      }
      side="top"
      align="end"
      width={320}
      trigger={planTrigger(done, total)}>
      <div className="plan-popover">
        <p className="plan-popover-head">
          <span>计划</span>
          <span className="plan-popover-count">
            {done}/{total}
          </span>
        </p>
        <PlanList plan={plan} active />
      </div>
    </Popover>
  )
}
