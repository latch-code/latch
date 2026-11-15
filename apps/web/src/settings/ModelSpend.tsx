import { useCallback, useEffect, useRef, useState } from 'react'
import {
  COST_CURRENCIES,
  type BudgetProgress,
  type CostCurrency,
  type ModelBudget,
  type ModelPrices,
  type ModelSpend,
} from '@latch/protocol'
import { Button, Dialog, Hint, InlineNotice, Meter, SegmentedControl, StatusWord, TextField } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { SettingsRow } from './common.tsx'
import { useSpendWrite, type SpendChange } from './modelSpendWrites.tsx'
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

const CURRENCY_OPTIONS = COST_CURRENCIES.map(value => ({ value, label: CURRENCY_NAMES[value] }))

/**
 * Prices and budgets as the Host has them now, with this month's use. Read again whenever `revision` changes (the
 * snapshot's, so another device's change shows) and after this page's own writes.
 */
export function useModelSpend(enabled: boolean, revision: unknown) {
  const [spend, setSpend] = useState<ModelSpend>()
  const [error, setError] = useState('')
  const reading = useRef<AbortController | undefined>(undefined)
  const reload = useCallback(async () => {
    if (!enabled) return
    reading.current?.abort()
    const controller = new AbortController()
    reading.current = controller
    try {
      const result = await api<ModelSpend>('model-spend', { signal: controller.signal })
      if (controller.signal.aborted) return
      setSpend(result)
      setError('')
      return result
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause))
    }
  }, [enabled])
  useEffect(() => {
    void reload()
    return () => reading.current?.abort()
  }, [reload, revision])
  return { spend, error, reload }
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
  const [conflict, setConflict] = useState('')
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const writing = pending?.sending === true
  const busy = writing || reading

  async function finish(result: Awaited<ReturnType<typeof submit>>) {
    if (result.kind === 'done') {
      void reload()
      onClose()
    } else if (result.kind === 'conflict') setConflict(result.text)
    else if (result.kind === 'refused') setError(result.text)
  }

  async function readCurrent() {
    setReading(true)
    const latest = await reload()
    setReading(false)
    if (!latest) {
      setError('暂时读不到当前设置，请稍后重试。')
      return
    }
    onRead(latest)
    setBase(latest.revision)
    setConflict('')
    setError('')
  }

  return {
    pending,
    conflict,
    error,
    setError,
    busy,
    reading,
    locked: disabled || busy || !!pending || !!conflict,
    send: (change: SpendChange) => {
      if (disabled || busy || pending || conflict) return
      setError('')
      void submit(change, base).then(finish)
    },
    retry: () => {
      if (disabled || busy) return
      setError('')
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
          title={warning ? '结果未知' : '已在别处修改'}
          action={
            <Button size="sm" disabled={form.busy} loading={form.reading} onClick={form.readCurrent}>
              载入当前设置
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
        关闭
      </Button>
      <Button size="md" variant="ghost" disabled={form.busy} onClick={form.abandon}>
        放弃等待
      </Button>
      {form.pending?.unknown?.retryable && (
        <Button size="md" variant="primary" disabled={disabled || form.busy} loading={form.pending.sending} onClick={form.retry}>
          重试同一请求
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
  const wrong = (name: Exclude<keyof PriceFields, 'currency'>) => (invalid === name && fields[name].trim() ? '填数字' : undefined)
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
        form.setError('')
      }}
    />
  )
  return (
    <Dialog
      open
      size="form"
      title="单价"
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
                清除
              </Button>
            )}
            <Button size="md" disabled={form.busy} onClick={controls.onClose}>
              取消
            </Button>
            <Button
              size="md"
              variant="primary"
              disabled={'invalid' in read || form.locked}
              loading={form.pending?.sending && !form.pending.clearing}
              onClick={() => {
                if ('prices' in read) send(read.prices)
              }}>
              保存
            </Button>
          </>
        )
      }>
      <div className="settings-form">
        <SegmentedControl
          label="币种"
          value={fields.currency}
          options={CURRENCY_OPTIONS}
          disabled={form.locked}
          onValueChange={(currency: CostCurrency) => {
            setFields(current => ({ ...current, currency }))
          }}
        />
        <p className="settings-hint">每百万 tokens</p>
        <div className="form-grid">
          {field('input', '输入')}
          {field('output', '输出')}
          {field('cacheRead', '缓存输入', '同输入')}
          {field('cacheWrite', '缓存写入', '同输入')}
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
  return (
    <span className="budget-progress">
      <Meter value={budget.used} max={budget.limit} label="本月预算" valueText={text} />
      <span className="budget-progress-text">{text}</span>
      {words ? (
        <StatusWord tone={words.tone}>{words.text}</StatusWord>
      ) : (
        <span className="budget-progress-share">{budgetPercent(budget)}%</span>
      )}
      {/* A cost budget says how many requests it could not count, rather than looking fuller than it is. */}
      {budget.uncounted ? (
        <span className="budget-progress-share" title="这些请求的花费未知，没有算进预算">
          未计入 {budget.uncounted} 次
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
      size="form"
      title="本月预算"
      note={
        <Hint label={timeZone ? `按这台 Mac 的时间算月（${timeZone}）` : '按这台 Mac 的时间算月'}>
          每月 1 日 0 点重新计，用到 80% 时会话里提示。
          {scope === 'service' ? '用完后会尝试可用的备选，若没有就拒绝新请求。' : '用完后这个 Agent 的新请求会被拒绝。'}
          进行中的请求照常结束。按花费的预算只计花费已知的请求。
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
                取消预算
              </Button>
            )}
            <Button size="md" disabled={form.busy} onClick={controls.onClose}>
              关闭
            </Button>
            <Button
              size="md"
              variant="primary"
              disabled={!budget || form.locked}
              loading={form.pending?.sending && !form.pending.clearing}
              onClick={() => {
                if (budget) send(budget)
              }}>
              保存
            </Button>
          </>
        )
      }>
      <div className="settings-form">
        <SegmentedControl
          label="按什么算"
          value={fields.unit}
          options={[
            { value: 'tokens', label: 'tokens' },
            { value: 'cost', label: '花费' },
          ]}
          disabled={form.locked}
          onValueChange={(unit: ModelBudget['unit']) => {
            setFields(current => ({ ...current, unit }))
          }}
        />
        {fields.unit === 'cost' && (
          <SegmentedControl
            label="币种"
            value={fields.currency}
            options={CURRENCY_OPTIONS}
            disabled={form.locked}
            onValueChange={(currency: CostCurrency) => {
              setFields(current => ({ ...current, currency }))
            }}
          />
        )}
        <TextField
          label="每月上限"
          value={fields.limit}
          inputMode={fields.unit === 'tokens' ? 'numeric' : 'decimal'}
          autoComplete="off"
          spellCheck={false}
          maxLength={20}
          disabled={form.locked}
          error={fields.limit.trim() && !budget ? (fields.unit === 'tokens' ? '填整数' : '填数字') : undefined}
          onChange={event => {
            setFields(current => ({ ...current, limit: event.target.value }))
            form.setError('')
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
      {budget ? <BudgetProgressLine budget={budget} /> : <span className="budget-none">{spend ? '未设置' : '正在读取…'}</span>}
      {admin && (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || !spend}
          onClick={() => {
            setOpen(true)
          }}>
          {budget ? '修改' : '设置'}
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
  return <SettingsRow title="本月预算" className="budget-row" trailing={<BudgetControl {...props} />} />
}
