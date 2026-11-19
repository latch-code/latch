import { useShortcutBindings } from '../core/shortcutBindings.ts'
import { useEffect } from 'react'
import type { HarnessInfo, QuotaState } from '@latch/protocol'
import { Tooltip } from '@latch/ui'
import { harnessName } from '../composerChoice.ts'
import { useTicker } from '../core/hostClock.ts'
import { currentShell } from '../core/shell.ts'
import { useModelSpend } from '../settings/ModelSpend.tsx'
import { shortcutKeys } from '../workbenchShortcuts.ts'
import { budgetLimit, harnessLimits, limitWords, markParts, partReads, usedWords, type LimitView, type MarkPart } from './limits.ts'
import { openUsage, refreshLimits, type UsageRequest } from './surface.ts'
import { defineCopy, useLocale } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    quota: (value1: string | number) => `${value1} 额度`,
    monthlyBudget: '本月预算',
    chipLabel: (label: string, words: string) => `${label}：${words}`,
    budget: (value1: string | number) => `${value1} 预算`,
  },
  {
    quota: (value1: string | number) => `${value1} limits`,
    monthlyBudget: 'Monthly budget',
    chipLabel: (label: string, words: string) => `${label}: ${words}`,
    budget: (value1: string | number) => `${value1} budget`,
  },
)

/**
 * The composer's mark of a limit, at the end of the line under the input: each window it names in words of its own
 * state, 「5 小时 12% · 周 68%」, amber from 80% and red at the limit. A click opens 额度与用量 on what it stands for;
 * its tooltip says each window in full with when it resets, and the shortcut.
 */
function LimitChip({
  label,
  parts,
  tip,
  state,
  request,
}: {
  label: string
  parts: readonly MarkPart[]
  /** One line per window: its full name and the share used, then when it resets. */
  tip: ReadonlyArray<{ words: string; reset?: string | undefined }>
  /** The worst of the parts: the hover's tint. */
  state: QuotaState
  request: UsageRequest
}) {
  useShortcutBindings()
  const keys = shortcutKeys('usage', currentShell() !== null) ?? undefined
  return (
    <span className="composer-control composer-usage">
      <Tooltip
        content={
          <span className="usage-chip-tip">
            {tip.map(line => (
              <span key={line.words}>
                <span>{line.words}</span>
                {line.reset && (
                  <>
                    {' · '}
                    <span>{line.reset}</span>
                  </>
                )}
              </span>
            ))}
          </span>
        }
        shortcut={keys}
        describe={false}>
        <button
          type="button"
          className="chip usage-chip"
          data-state={state}
          aria-label={COPY.chipLabel(label, parts.map(partReads).join(' · '))}
          aria-haspopup="dialog"
          onClick={() => {
            openUsage(request)
          }}>
          <span className="chip-text usage-chip-text">
            {parts.map((part, index) => (
              <span key={part.key} className="usage-chip-part" data-state={part.state}>
                {index > 0 && (
                  <span className="usage-chip-dot" aria-hidden="true">
                    {' · '}
                  </span>
                )}
                {part.text}
              </span>
            ))}
          </span>
        </button>
      </Tooltip>
    </span>
  )
}

/** A window's line in the mark's tooltip: 「每周 已用 68%」, then 「5 天 23 小时后重置」. */
const tipLine = (view: LimitView) => ({ words: `${view.name} ${usedWords(view)}`, reset: view.reset })

/** A Harness on its own login: what its own program last said about its subscription; nothing when it said nothing. */
export function HarnessLimitChip({ harness }: { harness: HarnessInfo }) {
  useLocale()
  const now = useTicker(harness.quota ? 'minute' : false)
  // Choosing a Harness is looking at it: its limits are asked for when missing or old.
  const reports = harness.capabilities.models.quota === true && harness.offer === undefined
  useEffect(() => {
    if (reports) void refreshLimits([harness.id])
  }, [reports, harness.id])
  const limits = harnessLimits(harness.quota, now)
  // A balance alone is not a limit: the composer says something only once the account cannot be used.
  if (!limits || (!limits.tightest && !limits.account)) return null
  const parts = markParts(limits)
  return (
    <LimitChip
      label={COPY.quota(harnessName(harness))}
      parts={parts}
      tip={limits.account ? parts.map(part => ({ words: part.text })) : limits.shown.map(tipLine)}
      state={limits.account || !limits.tightest ? 'limited' : limits.tightest.state}
      request={{ view: 'limits', harnessId: harness.id }}
    />
  )
}

/**
 * A session on one of Latch's model services: that service's monthly budget, in the same words and bar as a Harness's
 * window; nothing when it has none. Read again as each turn ends (`revision`).
 */
export function ServiceBudgetChip({ providerId, name, revision }: { providerId: string; name: string; revision: unknown }) {
  useLocale()
  const { spend } = useModelSpend(true, revision)
  const budget = spend?.budgets.find(item => item.scope === 'service' && item.id === providerId)
  if (!spend || !budget) return null
  const view = budgetLimit(budget, COPY.monthlyBudget, spend.month)
  const part = {
    key: view.key,
    text: limitWords(view.name, usedWords(view)),
    state: view.state,
    ...(view.reset ? { reset: view.reset } : {}),
  }
  return (
    <LimitChip label={COPY.budget(name)} parts={[part]} tip={[tipLine(view)]} state={view.state} request={{ view: 'usage', providerId }} />
  )
}
