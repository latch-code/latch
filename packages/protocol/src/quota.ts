/**
 * What a harness's own program said about the subscription it is logged in to: how much of each window is used and when
 * it resets. A fact about the harness on this Host, not about a session. Every value is a number or one of a fixed set;
 * nothing a vendor wrote as text is passed on.
 */

/**
 * `five-hour`, `weekly`: the rolling windows of a plan. `weekly-opus`, `weekly-sonnet`: a weekly window of one model
 * family. `billing-period`: the plan's billing period, which is not a rolling window. `rolling`: another rolling window,
 * told by `windowMinutes`.
 */
export const QUOTA_WINDOW_KINDS = ['five-hour', 'weekly', 'weekly-opus', 'weekly-sonnet', 'billing-period', 'rolling'] as const
export type QuotaWindowKind = (typeof QUOTA_WINDOW_KINDS)[number]

/** The model groups a harness meters apart from each other (Antigravity): its own models, and Claude's and GPT's. */
export const QUOTA_GROUPS = ['gemini', 'claude-gpt'] as const
export type QuotaGroup = (typeof QUOTA_GROUPS)[number]

/** Plan names Latch shows. A harness's word for a plan outside this set is not shown. */
export const QUOTA_PLANS = [
  'free',
  'go',
  'plus',
  'pro',
  'prolite',
  'promax',
  'max',
  'ultra',
  'team',
  'business',
  'enterprise',
  'edu',
  'supergrok',
  'supergrok-heavy',
] as const
export type QuotaPlan = (typeof QUOTA_PLANS)[number]

export type QuotaState = 'ok' | 'near' | 'limited'

export interface QuotaWindow {
  kind: QuotaWindowKind
  /** The model group the window is for, where the harness has several. Absent: the whole plan. */
  group?: QuotaGroup
  /** 0 to 100. Absent: the harness gives no figure for this window, only `state`. */
  usedPercent?: number
  /** ISO time the window starts over. */
  resetsAt?: string
  /** The window's length, for a `rolling` one. */
  windowMinutes?: number
  /** The harness itself said the window is nearly used up or used up; a window with a figure is judged by the figure. */
  state?: 'near' | 'limited'
}

/** The currencies a prepaid balance is shown in. */
export const QUOTA_CURRENCIES = ['USD', 'CNY'] as const
export type QuotaCurrency = (typeof QUOTA_CURRENCIES)[number]

export interface HarnessQuota {
  /** In the order of `QUOTA_WINDOW_KINDS`; at least one, unless there is a `balanceCents`. */
  windows: QuotaWindow[]
  plan?: QuotaPlan
  /** The account's address with all but three characters and the last label hidden (`n•••@f•••.com`), masked on the Host. */
  account?: string
  /** Prepaid credit left, in hundredths of `currency`. */
  balanceCents?: number
  /** The balance's currency. Absent: US dollars. */
  currency?: QuotaCurrency
  /** The worst of the windows, or `limited` when the harness said the account is. */
  state: QuotaState
  /** When the harness last said any of it. */
  observedAt: string
}

/**
 * Why a read of a harness's limits ended with nothing: `login`, the program says it is not logged in; `no-key`, the
 * Host's own read found no key it may use (DeepSeek Harness); `failed`, anything else.
 */
export type QuotaReadFailure = 'login' | 'no-key' | 'failed'

/** The reads of a harness's limits Latch makes when someone looks at them (docs/HARNESSES.md#额度). */
export interface HarnessQuotaRead {
  /** A read is on its way. */
  running?: true
  /** The last read ended with nothing, and why; it is gone once any figure arrives. */
  failed?: { at: string; reason: QuotaReadFailure }
  /**
   * Nothing can be asked outside a turn: the program reports its limits only as one of its turns runs, and only some of
   * the time (Claude Agent).
   */
  afterTurn?: true
}

/** From this share of a window on, it is nearly used up. */
export const QUOTA_NEAR_PERCENT = 80

const RANK: Record<QuotaState, number> = { ok: 0, near: 1, limited: 2 }

export function quotaWindowState(window: QuotaWindow): QuotaState {
  if (window.usedPercent === undefined) return window.state ?? 'ok'
  const figure: QuotaState = window.usedPercent >= 100 ? 'limited' : window.usedPercent >= QUOTA_NEAR_PERCENT ? 'near' : 'ok'
  return RANK[window.state ?? 'ok'] > RANK[figure] ? window.state! : figure
}

/** The window a single mark stands for: the worst, then the fullest, then the first. */
export function leadingQuotaWindow(windows: readonly QuotaWindow[]): QuotaWindow | undefined {
  let lead: QuotaWindow | undefined
  for (const window of windows) {
    if (!lead) lead = window
    else {
      const rank = RANK[quotaWindowState(window)] - RANK[quotaWindowState(lead)]
      if (rank > 0 || (rank === 0 && (window.usedPercent ?? -1) > (lead.usedPercent ?? -1))) lead = window
    }
  }
  return lead
}

/**
 * What still holds of a snapshot at `now`: a window past its reset says nothing about the window that began then, so it
 * goes, and the state is that of the windows left. A balance reported alone has no reset and stays. Undefined once
 * nothing is left.
 */
export function currentQuota(quota: HarnessQuota, now: number): HarnessQuota | undefined {
  const windows = quota.windows.filter(window => window.resetsAt === undefined || Date.parse(window.resetsAt) > now)
  // A balance reported with windows goes with them; one reported alone stays.
  if (!windows.length && (quota.windows.length > 0 || quota.balanceCents === undefined)) return undefined
  if (windows.length === quota.windows.length) return quota
  // A limit the harness reported for the account, which no window showed, does not end with one of the windows.
  const account = quota.state === 'limited' && !quota.windows.some(window => quotaWindowState(window) === 'limited')
  const worst = windows.reduce<QuotaState>(
    (state, window) => {
      const own = quotaWindowState(window)
      return RANK[own] > RANK[state] ? own : state
    },
    account ? 'limited' : 'ok',
  )
  return { ...quota, windows, state: worst }
}
