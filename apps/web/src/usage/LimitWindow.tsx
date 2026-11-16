import type { QuotaState } from '@latch/protocol'
import { usedWords, type LimitView } from './limits.ts'

/**
 * How much of a limit is used, as one continuous bar that fills its container: meter ink, amber from 80%, red at the
 * limit. It is read as a meter named `label` with the words the page writes beside it.
 */
export function LimitBar({ percent, state, label }: { percent: number; state: QuotaState; label: string }) {
  const value = Math.min(Math.max(percent, 0), 100)
  return (
    <span
      className="limit-bar"
      data-state={state}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={usedWords({ percent: value })}>
      <span className="limit-bar-fill" style={{ '--used': `${value}%` }} />
    </span>
  )
}

/**
 * One limit window, the same wherever it is shown (a Harness's window, a monthly budget): its name and 「已用 N%」 on one
 * line, the bar under them, then when it resets. Amber from 80% and red at the limit, on the bar and the figure
 * together. A window the source gave no figure for says its state in words, without a bar; one that has not started
 * shows no reset time.
 */
export function LimitWindow({ view, detail }: { view: LimitView; detail?: string | undefined }) {
  return (
    <div className="limit-window" data-state={view.state} data-quota-window={view.key}>
      <span className="limit-window-name">{view.name}</span>
      <span className="limit-window-value">{usedWords(view)}</span>
      {view.percent !== undefined ? (
        <LimitBar percent={view.percent} state={view.state} label={view.name} />
      ) : (
        <span className="limit-bar" data-state={view.state} data-empty="" aria-hidden="true" />
      )}
      {(view.reset || detail) && <span className="limit-window-reset">{[detail, view.reset].filter(Boolean).join(' · ')}</span>}
    </div>
  )
}
