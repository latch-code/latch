import { useState } from 'react'
import { Check, ChevronRight, Circle, CircleDot, ListChecks } from 'lucide-react'
import type { PlanEntry } from '@latch/protocol'
import { ICON_STROKE, StatusGlyph } from '@latch/ui'

/**
 * `active`: the session is still running, so the step in progress is drawn in ink; once it settles that step reads as
 * unfinished. The step in progress is a still mark: the running tool already turns its comets on its row and in the
 * run bar. A step whose state changes while the page watches cross-fades its mark.
 */
export function PlanList({ plan, active }: { plan: PlanEntry[]; active: boolean }) {
  return (
    <ol className={active ? 'plan-list' : 'plan-list is-settled'}>
      {plan.map((entry, index) => (
        <li key={index} className={`plan-entry plan-${entry.status}`}>
          <StatusGlyph className="plan-icon" state={entry.status}>
            {entry.status === 'completed' ? (
              <Check size={14} strokeWidth={ICON_STROKE[14]} />
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
  return { done, total: plan.length, ratio: plan.length ? done / plan.length : 0 }
}

/** The running harness's latest plan, pinned above the composer while the run lasts and collapsed by default. */
export function PlanCard({ plan }: { plan: PlanEntry[] }) {
  const [open, setOpen] = useState(false)
  const { done, total, ratio } = planProgress(plan)
  const current = plan.find(entry => entry.status === 'in_progress')
  return (
    <section className={`plan-card ${open ? 'is-open' : ''}`} aria-label="计划">
      <button
        type="button"
        className="plan-card-header"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
        }}>
        <ListChecks size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
        <span className="plan-card-title">
          计划 · {done}/{total}
        </span>
        {!open && current && <span className="plan-card-current">{current.content}</span>}
        <span className="progress" aria-hidden="true">
          <i style={{ width: `${Math.round(ratio * 100)}%` }} />
        </span>
        <ChevronRight className="chevron" size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
      </button>
      {open && (
        <div className="plan-card-body">
          <PlanList plan={plan} active />
        </div>
      )}
    </section>
  )
}
