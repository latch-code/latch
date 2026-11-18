import { useShortcutBindings } from '../core/shortcutBindings.ts'
import { useEffect } from 'react'
import type { HarnessInfo, QuotaState } from '@latch/protocol'
import { AlertGlyph, Icon, Tooltip } from '@latch/ui'
import { harnessName } from '../composerChoice.ts'
import { useTicker } from '../core/hostClock.ts'
import { currentShell } from '../core/shell.ts'
import { useModelSpend } from '../settings/ModelSpend.tsx'
import { shortcutKeys } from '../workbenchShortcuts.ts'
import { budgetLimit, chipParts, harnessLimits, limitWords, usedWords } from './limits.ts'
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
 * The composer's one word on a limit, last before send: the tightest window by name and how much of it is used, a short
 * bar of the same, amber from 80% and red at the limit. A click opens 额度与用量 on what it stands for; its tooltip says
 * when it resets and the shortcut.
 */
function LimitChip({
  label,
  name,
  figure,
  state,
  percent,
  reset,
  request,
}: {
  label: string
  /** The window's name, which a narrow row shortens first. */
  name: string
  /** 「已用 68%」 or the state's words, never shortened. */
  figure: string
  state: QuotaState
  percent: number | undefined
  reset: string | undefined
  request: UsageRequest
}) {
  useShortcutBindings()
  const keys = shortcutKeys('usage', currentShell() !== null) ?? undefined
  const words = limitWords(name, figure)
  return (
    <span className="composer-control composer-usage">
      {/* The words lead the hover too: a short row shows the bar alone (usage.css). */}
      <Tooltip
        content={
          <>
            <span>{words}</span> · <span>{reset ?? label}</span>
          </>
        }
        shortcut={keys}
        describe={false}>
        <button
          type="button"
          className="chip usage-chip"
          data-state={state}
          aria-label={COPY.chipLabel(label, reset ? `${words} · ${reset}` : words)}
          aria-haspopup="dialog"
          onClick={() => {
            openUsage(request)
          }}>
          {percent !== undefined ? (
            <span className="usage-chip-bar" aria-hidden="true">
              <span style={{ '--used': `${Math.min(Math.max(percent, 0), 100)}%` }} />
            </span>
          ) : (
            <Icon icon={AlertGlyph} size={14} />
          )}
          <span className="chip-text usage-chip-text">
            {name && <span className="usage-chip-name">{name}</span>}
            <span className="usage-chip-figure">{figure}</span>
          </span>
        </button>
      </Tooltip>
    </span>
  )
}

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
  return (
    <LimitChip
      label={COPY.quota(harnessName(harness))}
      {...chipParts(limits)}
      state={limits.account || !limits.tightest ? 'limited' : limits.tightest.state}
      percent={limits.account ? undefined : limits.tightest?.percent}
      reset={limits.tightest?.reset}
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
  return (
    <LimitChip
      label={COPY.budget(name)}
      name={view.name}
      figure={usedWords(view)}
      state={view.state}
      percent={view.percent}
      reset={view.reset}
      request={{ view: 'usage', providerId }}
    />
  )
}
