import { useCallback, useEffect, useRef, useState } from 'react'
import {
  COST_CURRENCIES,
  type BudgetProgress,
  type CostCurrency,
  type ModelBudget,
  type ModelPrices,
  type ModelSpend,
} from '@latch/protocol'
import { Button, Dialog, Hint, InlineNotice, SegmentedControl, StatusWord, TextField } from '@latch/ui'
import { LimitBar } from '../usage/LimitWindow.tsx'
import { budgetLimit } from '../usage/limits.ts'
import { api, errorMessage } from '../core/api.ts'
import { SettingsRow } from './common.tsx'
import { useSpendWrite, type SpendChange } from './modelSpendWrites.tsx'
import { readDenied, type ModelSettingsReads } from './modelSettingsReads.ts'
import {
  CURRENCY_NAMES,
  budgetFields,
  budgetPercent,
  budgetProgressText,
  budgetWords,
  priceFields,
  readBudget,
  readPrices,
  type BudgetFields,
  type PriceFields,
} from './modelSpend.ts'
import { defineCopy, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    readFailed: '暂时读不到当前设置，请稍后重试。',
    unknown: '结果未知',
    conflict: '已在别处修改',
    loadCurrent: '载入当前设置',
    close: '关闭',
    stopWaiting: '放弃等待',
    retrySame: '重试同一请求',
    invalidNumber: '填数字',
    unitPrice: '单价',
    clear: '清除',
    cancel: '取消',
    save: '保存',
    currency: '币种',
    perMillion: '每百万 tokens',
    input: '输入',
    output: '输出',
    cacheInput: '缓存输入',
    sameAsInput: '同输入',
    cacheWrite: '缓存写入',
    monthlyBudget: '本月预算',
    uncounted: (count: number) => plural(count, { other: '未计入 {n} 次' }),
    uncountedTitle: '这些请求的花费未知，没有算进预算',
    monthTimeZone: (value1: string | number) => `按这台 Mac 的时间算月（${value1}）`,
    monthLocal: '按这台 Mac 的时间算月',
    monthlyReset: '每月 1 日 0 点重新计，用到 80% 时会话里提示。',
    serviceBudget: '用完后会尝试可用的备选，若没有就拒绝新请求。',
    agentBudget: '用完后这个 Agent 的新请求会被拒绝。',
    currentRequests: '进行中的请求照常结束。按花费的预算只计花费已知的请求。',
    removeBudget: '取消预算',
    budgetMetric: '按什么算',
    cost: '花费',
    monthlyLimit: '每月上限',
    invalidInteger: '填整数',
    notSet: '未设置',
    reading: '正在读取…',
    edit: '修改',
    configure: '设置',
  },
  {
    readFailed: "Couldn't read current settings. Try again later.",
    unknown: 'Outcome unknown',
    conflict: 'Changed elsewhere',
    loadCurrent: 'Load current settings',
    close: 'Close',
    stopWaiting: 'Stop waiting',
    retrySame: 'Retry same request',
    invalidNumber: 'Enter a number',
    unitPrice: 'Unit prices',
    clear: 'Clear',
    cancel: 'Cancel',
    save: 'Save',
    currency: 'Currency',
    perMillion: 'Per million tokens',
    input: 'Input',
    output: 'Output',
    cacheInput: 'Cached input',
    sameAsInput: 'Same as input',
    cacheWrite: 'Cache write',
    monthlyBudget: 'Monthly budget',
    uncounted: (count: number) => plural(count, { one: '{n} request excluded', other: '{n} requests excluded' }),
    uncountedTitle: "These requests have unknown costs and don't count toward the budget",
    monthTimeZone: (value1: string | number) => `Uses the Mac's time zone (${value1})`,
    monthLocal: "Uses the Mac's time zone",
    monthlyReset: 'Resets at midnight on the first day of each month. Sessions show a warning at 80%.',
    serviceBudget: 'When the budget runs out, new requests use an available fallback or are rejected.',
    agentBudget: "When the budget runs out, this Agent's new requests are rejected.",
    currentRequests: 'Requests in progress can finish. Spending budgets count requests with known costs.',
    removeBudget: 'Remove budget',
    budgetMetric: 'Budget basis',
    cost: 'Cost',
    monthlyLimit: 'Monthly limit',
    invalidInteger: 'Enter a whole number',
    notSet: 'Not set',
    reading: 'Reading…',
    edit: 'Edit',
    configure: 'Set budget',
  },
)

const CURRENCY_OPTIONS = COST_CURRENCIES.map(value => ({
  value,
  get label() {
    return CURRENCY_NAMES[value]
  },
}))

/**
 * Prices and budgets as the Host has them now, with this month's use. Read again whenever `revision` changes (the
 * snapshot's, so another device's change shows) and after this page's own writes.
 */
export function useModelSpend(enabled: boolean, revision: unknown, reads?: ModelSettingsReads) {
  const [spend, setSpend] = useState(reads?.spend)
  const [error, setError] = useState<() => string>()
  const reading = useRef<AbortController | undefined>(undefined)
  const reload = useCallback(async (): Promise<ModelSpend | undefined> => {
    if (!enabled) return undefined
    reading.current?.abort()
    const controller = new AbortController()
    reading.current = controller
    try {
      const result = await api<ModelSpend>('model-spend', { signal: controller.signal })
      if (controller.signal.aborted) return undefined
      reads?.keepSpend(result)
      setSpend(result)
      setError(undefined)
      return result
    } catch (cause) {
      if (controller.signal.aborted) return undefined
      if (readDenied(cause)) {
        reads?.keepSpend(undefined)
        setSpend(undefined)
      }
      setError(() => () => errorMessage(cause))
      return undefined
    }
  }, [enabled, reads])
  useEffect(() => {
    void reload()
    return () => reading.current?.abort()
  }, [reload, revision])
  return { spend, error: error?.() ?? '', reload }
}

interface SpendDialogControls {
  revision: number
  disabled?: boolean | undefined
  reload: () => Promise<ModelSpend | undefined>
  onClose: () => void
}

function useSpendForm(
  target: Parameters<typeof useSpendWrite>[0],
  { revision, disabled, reload, onClose }: SpendDialogControls,
  onRead: (spend: ModelSpend) => void,
) {
  const { pending, submit, retry, abandon } = useSpendWrite(target)
  const [base, setBase] = useState(revision)
  const [conflict, setConflict] = useState<() => string>()
  const [error, setError] = useState<() => string>()
  const [reading, setReading] = useState(false)
  const writing = pending?.sending === true
  const busy = writing || reading

  async function finish(result: Awaited<ReturnType<typeof submit>>) {
    if (result.kind === 'done') {
      void reload()
      onClose()
    } else if (result.kind === 'conflict') setConflict(() => () => result.text)
    else if (result.kind === 'refused') setError(() => () => result.text)
  }

  async function readCurrent() {
    setReading(true)
    const latest = await reload()
    setReading(false)
    if (!latest) {
      setError(() => () => COPY.readFailed)
      return
    }
    onRead(latest)
    setBase(latest.revision)
    setConflict(undefined)
    setError(undefined)
  }

  return {
    pending,
    conflict: conflict?.(),
    error: error?.(),
    setError,
    busy,
    reading,
    locked: disabled || busy || !!pending || !!conflict,
    send: (change: SpendChange) => {
      if (disabled || busy || pending || conflict) return
      setError(undefined)
      void submit(change, base).then(finish)
    },
    retry: () => {
      if (disabled || busy) return
      setError(undefined)
      void retry().then(finish)
    },
    readCurrent: () => {
      if (!busy) void readCurrent()
    },
    abandon: () => {
      abandon()
      void reload()
      onClose()
    },
  }
}

type SpendForm = ReturnType<typeof useSpendForm>

function SpendFeedback({ form }: { form: SpendForm }) {
  const warning = form.pending?.unknown
  return (
    <>
      {(warning || form.conflict) && (
        <InlineNotice
          tone="warn"
          title={warning ? COPY.unknown : COPY.conflict}
          action={
            <Button size="sm" disabled={form.busy} loading={form.reading} onClick={form.readCurrent}>
              {COPY.loadCurrent}
            </Button>
          }>
          {warning?.text ?? form.conflict}
        </InlineNotice>
      )}
      {form.error && <InlineNotice tone="error">{form.error}</InlineNotice>}
    </>
  )
}

function PendingSpendActions({ form, disabled, onClose }: { form: SpendForm; disabled?: boolean | undefined; onClose: () => void }) {
  return (
    <>
      <Button size="md" disabled={form.busy} onClick={onClose}>
        {COPY.close}
      </Button>
      <Button size="md" variant="ghost" disabled={form.busy} onClick={form.abandon}>
        {COPY.stopWaiting}
      </Button>
      {form.pending?.unknown?.retryable && (
        <Button size="md" variant="primary" disabled={disabled || form.busy} loading={form.pending.sending} onClick={form.retry}>
          {COPY.retrySame}
        </Button>
      )}
    </>
  )
}

/**
 * 「单价」 of one model: what a million tokens cost, as the person reads it off the service's price page. Only these
 * and what a service reports itself ever become a cost; nothing is filled in for them.
 */
export function PricesDialog({
  providerId,
  model,
  saved,
  ...controls
}: SpendDialogControls & { providerId: string; model: string; saved: ModelPrices | undefined }) {
  const [fields, setFields] = useState<PriceFields>(() => priceFields(saved))
  const target = { path: 'model-prices', providerId, model } as const
  const form = useSpendForm(target, controls, latest => {
    setFields(priceFields(latest.prices.find(item => item.providerId === providerId && item.model === model)))
  })
  const send = (prices: ModelPrices | null) => form.send({ ...target, prices })
  const read = readPrices(fields)
  const invalid = 'invalid' in read ? read.invalid : undefined
  // A field is wrong only once something is typed in it; an empty form is just not filled yet.
  const wrong = (name: Exclude<keyof PriceFields, 'currency'>) => (invalid === name && fields[name].trim() ? COPY.invalidNumber : undefined)
  const field = (name: Exclude<keyof PriceFields, 'currency'>, label: string, placeholder?: string) => (
    <TextField
      label={label}
      value={fields[name]}
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      maxLength={20}
      placeholder={placeholder}
      disabled={form.locked}
      error={wrong(name)}
      onChange={event => {
        setFields(current => ({ ...current, [name]: event.target.value }))
        form.setError(undefined)
      }}
    />
  )
  return (
    <Dialog
      open
      size="lg"
      title={COPY.unitPrice}
      subtitle={<code className="settings-mono">{model}</code>}
      onClose={() => {
        if (!form.busy) controls.onClose()
      }}
      footer={
        form.pending?.unknown ? (
          <PendingSpendActions form={form} disabled={controls.disabled} onClose={controls.onClose} />
        ) : (
          <>
            {saved && (
              <Button
                size="md"
                variant="ghost"
                disabled={form.locked}
                loading={form.pending?.sending && form.pending.clearing}
                onClick={() => {
                  send(null)
                }}>
                {COPY.clear}
              </Button>
            )}
            <Button size="md" disabled={form.busy} onClick={controls.onClose}>
              {COPY.cancel}
            </Button>
            <Button
              size="md"
              variant="primary"
              disabled={'invalid' in read || form.locked}
              loading={form.pending?.sending && !form.pending.clearing}
              onClick={() => {
                if ('prices' in read) send(read.prices)
              }}>
              {COPY.save}
            </Button>
          </>
        )
      }>
      <div className="settings-form">
        <SegmentedControl
          label={COPY.currency}
          value={fields.currency}
          options={CURRENCY_OPTIONS}
          disabled={form.locked}
          onValueChange={(currency: CostCurrency) => {
            setFields(current => ({ ...current, currency }))
          }}
        />
        <p className="settings-hint">{COPY.perMillion}</p>
        <div className="form-grid">
          {field('input', COPY.input)}
          {field('output', COPY.output)}
          {field('cacheRead', COPY.cacheInput, COPY.sameAsInput)}
          {field('cacheWrite', COPY.cacheWrite, COPY.sameAsInput)}
        </div>
        <SpendFeedback form={form} />
      </div>
    </Dialog>
  )
}

/** The budget's use this month: a meter, the numbers, and the state in words once it is at 80% (amber) or used up (red). */
export function BudgetProgressLine({ budget }: { budget: BudgetProgress }) {
  const words = budgetWords(budget.state)
  const text = budgetProgressText(budget)
  const limit = budgetLimit(budget, COPY.monthlyBudget, '')
  return (
    <span className="budget-progress">
      <LimitBar percent={limit.percent ?? 0} state={limit.state} label={COPY.monthlyBudget} />
      <span className="budget-progress-text">{text}</span>
      {words ? (
        <StatusWord tone={words.tone}>{words.text}</StatusWord>
      ) : (
        <span className="budget-progress-share">{budgetPercent(budget)}%</span>
      )}
      {/* A cost budget says how many requests it could not count, rather than looking fuller than it is. */}
      {budget.uncounted ? (
        <span className="budget-progress-share" title={COPY.uncountedTitle}>
          {COPY.uncounted(budget.uncounted)}
        </span>
      ) : null}
    </span>
  )
}

function BudgetDialog({
  scope,
  id,
  saved,
  timeZone,
  ...controls
}: SpendDialogControls & {
  scope: ModelBudget['scope']
  id: string
  saved: ModelBudget | undefined
  timeZone: string | undefined
}) {
  const [fields, setFields] = useState<BudgetFields>(() => budgetFields(saved))
  const target = { path: 'model-budgets', scope, id } as const
  const form = useSpendForm(target, controls, latest => {
    setFields(budgetFields(latest.budgets.find(item => item.scope === scope && item.id === id)))
  })
  const budget = readBudget(fields)
  const send = (budget: Omit<ModelBudget, 'scope' | 'id'> | null) => form.send({ ...target, budget })
  return (
    <Dialog
      open
      size="lg"
      title={COPY.monthlyBudget}
      note={
        <Hint label={timeZone ? COPY.monthTimeZone(timeZone) : COPY.monthLocal}>
          {COPY.monthlyReset}
          {scope === 'service' ? COPY.serviceBudget : COPY.agentBudget}
          {COPY.currentRequests}
        </Hint>
      }
      onClose={() => {
        if (!form.busy) controls.onClose()
      }}
      footer={
        form.pending?.unknown ? (
          <PendingSpendActions form={form} disabled={controls.disabled} onClose={controls.onClose} />
        ) : (
          <>
            {saved && (
              <Button
                size="md"
                variant="ghost"
                disabled={form.locked}
                loading={form.pending?.sending && form.pending.clearing}
                onClick={() => {
                  send(null)
                }}>
                {COPY.removeBudget}
              </Button>
            )}
            <Button size="md" disabled={form.busy} onClick={controls.onClose}>
              {COPY.close}
            </Button>
            <Button
              size="md"
              variant="primary"
              disabled={!budget || form.locked}
              loading={form.pending?.sending && !form.pending.clearing}
              onClick={() => {
                if (budget) send(budget)
              }}>
              {COPY.save}
            </Button>
          </>
        )
      }>
      <div className="settings-form">
        <SegmentedControl
          label={COPY.budgetMetric}
          value={fields.unit}
          options={[
            { value: 'tokens', label: 'tokens' },
            { value: 'cost', label: COPY.cost },
          ]}
          disabled={form.locked}
          onValueChange={(unit: ModelBudget['unit']) => {
            setFields(current => ({ ...current, unit }))
          }}
        />
        {fields.unit === 'cost' && (
          <SegmentedControl
            label={COPY.currency}
            value={fields.currency}
            options={CURRENCY_OPTIONS}
            disabled={form.locked}
            onValueChange={(currency: CostCurrency) => {
              setFields(current => ({ ...current, currency }))
            }}
          />
        )}
        <TextField
          label={COPY.monthlyLimit}
          value={fields.limit}
          inputMode={fields.unit === 'tokens' ? 'numeric' : 'decimal'}
          autoComplete="off"
          spellCheck={false}
          maxLength={20}
          disabled={form.locked}
          error={fields.limit.trim() && !budget ? (fields.unit === 'tokens' ? COPY.invalidInteger : COPY.invalidNumber) : undefined}
          onChange={event => {
            setFields(current => ({ ...current, limit: event.target.value }))
            form.setError(undefined)
          }}
        />
        <SpendFeedback form={form} />
      </div>
    </Dialog>
  )
}

/**
 * 「本月预算」 of a service or an Agent: what is set and how much of it this month used, and for a device with admin
 * the way to set, change or remove it. Other devices read it. Rendered wherever the caller places it: a settings row or
 * a line of an Agent's facts.
 */
export function BudgetControl({
  scope,
  id,
  spend,
  admin,
  disabled = false,
  onChanged,
}: {
  scope: ModelBudget['scope']
  id: string
  spend: ModelSpend | undefined
  admin: boolean
  disabled?: boolean
  onChanged: SpendDialogControls['reload']
}) {
  const [open, setOpen] = useState(false)
  if (open && !admin) setOpen(false)
  const budget = spend?.budgets.find(item => item.scope === scope && item.id === id)
  return (
    <span className="budget-control">
      {budget ? <BudgetProgressLine budget={budget} /> : <span className="budget-none">{spend ? COPY.notSet : COPY.reading}</span>}
      {admin && (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || !spend}
          onClick={() => {
            setOpen(true)
          }}>
          {budget ? COPY.edit : COPY.configure}
        </Button>
      )}
      {open && admin && spend && (
        <BudgetDialog
          scope={scope}
          id={id}
          saved={budget}
          revision={spend.revision}
          disabled={disabled}
          timeZone={spend.timeZone}
          reload={onChanged}
          onClose={() => {
            setOpen(false)
          }}
        />
      )}
    </span>
  )
}

/** The service page's 「本月预算」 row. */
export function BudgetRow(props: Parameters<typeof BudgetControl>[0]) {
  return <SettingsRow title={COPY.monthlyBudget} className="budget-row" trailing={<BudgetControl {...props} />} />
}
