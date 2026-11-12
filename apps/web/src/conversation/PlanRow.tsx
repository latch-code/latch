import { useState } from 'react'
import { ListChecks } from 'lucide-react'
import type { PlanEntry } from '@latch/protocol'
import { Collapse, ICON_STROKE, ChevronRightGlyph } from '@latch/ui'
import { PlanList, planProgress } from '../components/PlanCard.tsx'

/** The running agent's latest plan as a work row 「计划 2/5 ›」; opening it lists the steps. */
export function PlanRow({ plan, active }: { plan: PlanEntry[]; active: boolean }) {
  const [open, setOpen] = useState(false)
  const { done, total } = planProgress(plan)
  return (
    <div className="plan-row">
      <button
        type="button"
        className="process-row"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
        }}>
        <span className="process-slot" aria-hidden="true">
          <ListChecks size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} />
        </span>
        <span className="process-label">
          计划 {done}/{total}
        </span>
        <ChevronRightGlyph className="process-chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
      </button>
      <Collapse
        open={open}
        onReveal={() => {
          setOpen(true)
        }}>
        <div className="plan-row-body">
          <PlanList plan={plan} active={active} />
        </div>
      </Collapse>
    </div>
  )
}
