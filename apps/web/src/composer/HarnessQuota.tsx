import { Fragment } from 'react'
import type { HarnessQuota } from '@latch/protocol'
import { AlertGlyph, Icon, Meter, Popover, Tooltip } from '@latch/ui'
import { useTicker } from '../core/hostClock.ts'
import { quotaView, type QuotaRow, type QuotaView } from './harnessQuota.ts'

const RADIUS = 5.5
const ROUND = 2 * Math.PI * RADIUS

/** The share of the window that is used, as an arc from twelve o'clock. Decoration: the figure is written beside it. */
function Ring({ percent }: { percent: number }) {
  return (
    <svg className="quota-ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle className="quota-ring-track" cx="7" cy="7" r={RADIUS} />
      <circle
        className="quota-ring-fill"
        cx="7"
        cy="7"
        r={RADIUS}
        strokeDasharray={`${(Math.min(Math.max(percent, 0), 100) / 100) * ROUND} ${ROUND}`}
        transform="rotate(-90 7 7)"
      />
    </svg>
  )
}

function Row({ row }: { row: QuotaRow }) {
  return (
    <li className="quota-row" data-state={row.state} data-quota-window={row.key}>
      <span className="quota-row-name">{row.name}</span>
      <span className="quota-row-value">{row.percent !== undefined ? `${row.percent}%` : row.status}</span>
      {row.percent !== undefined && (
        <Meter
          className="quota-row-meter"
          value={row.percent}
          max={100}
          label={row.name}
          valueText={`已用 ${row.percent}%`}
          cells={16}
          size="md"
        />
      )}
      {row.reset && <span className="quota-row-reset">{row.reset}</span>}
    </li>
  )
}

/** Each window with its figure and reset time, then the plan and the masked account. */
export function QuotaPanel({ view }: { view: QuotaView }) {
  return (
    <div className="quota-panel">
      <ul className="quota-rows">
        {view.rows.map((row, index) => (
          <Fragment key={row.key}>
            {row.group && row.group !== view.rows[index - 1]?.group && <li className="quota-group">{row.group}</li>}
            <Row row={row} />
          </Fragment>
        ))}
      </ul>
      {view.facts.length > 0 && <p className="quota-facts">{view.facts.join(' · ')}</p>}
    </div>
  )
}

/**
 * Beside the Harness control: how much of its subscription's fullest window is used, as its own program last said. A
 * Harness that said nothing draws nothing. Amber from 80%, red at the limit, each with the figure or the reset time;
 * the line behind hover names the window, and the panel lists every window.
 */
export function HarnessQuotaMark({ quota, harness }: { quota: HarnessQuota | undefined; harness: string }) {
  const now = useTicker(quota ? 'minute' : false)
  const view = quotaView(quota, now)
  if (!view) return null
  return (
    <span className="composer-control composer-quota">
      <Popover
        label={`${harness} 额度`}
        width={296}
        side="top"
        align="start"
        trigger={props => (
          <Tooltip content={view.line} describe={false}>
            <button
              {...props}
              type="button"
              className="chip quota-mark"
              data-state={view.state}
              aria-label={`${harness} 额度：${view.line}`}>
              {view.percent !== undefined ? <Ring percent={view.percent} /> : <Icon icon={AlertGlyph} size={14} />}
              <span className="chip-text">{view.text}</span>
            </button>
          </Tooltip>
        )}>
        <QuotaPanel view={view} />
      </Popover>
    </span>
  )
}
