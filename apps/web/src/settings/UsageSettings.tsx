import { useEffect, useState } from 'react'
import type { HostCatalog, UsageSummary } from '@latch/protocol'
import { InlineNotice, Loading, SegmentedControl } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { SettingsGroup } from './common.tsx'

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })
const exact = new Intl.NumberFormat('zh-CN')

/** Tokens short enough to scan in a column; the exact count, with what it includes, is the cell's tooltip. */
export function shownTokens(tokens: number | undefined): string {
  return tokens === undefined ? '未报告' : compact.format(tokens).replace(/K$/u, 'k')
}

/** The period's input and output together, over the rows the table shows. */
export const usageTotal = (rows: UsageSummary['rows']) => rows.reduce((sum, { usage }) => sum + usage.inputTokens + usage.outputTokens, 0)

/** The tokens each model used, as this Mac recorded them: never priced, and an Agent's own report is named as one. */
export function UsageSettings({ catalog }: { catalog: HostCatalog }) {
  const [days, setDays] = useState<7 | 30>(7),
    [value, setValue] = useState<UsageSummary>(),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setValue(undefined)
    setError('')
    void api<UsageSummary>('usage', { method: 'POST', body: { days }, signal: controller.signal }).then(
      result => {
        if (!controller.signal.aborted) {
          setValue(result)
          setLoading(false)
        }
      },
      cause => {
        if (!controller.signal.aborted) {
          setError(errorMessage(cause))
          setLoading(false)
        }
      },
    )
    return () => {
      controller.abort()
    }
  }, [days])
  const detail = (usage: UsageSummary['rows'][number]) =>
    (
      [
        ['输入（含缓存）', usage.usage.inputTokens, undefined],
        ['输出（含推理）', usage.usage.outputTokens, undefined],
        ['缓存读取', usage.usage.cacheReadTokens, usage.partial.cacheReadTokens],
        ['缓存写入', usage.usage.cacheWriteTokens, usage.partial.cacheWriteTokens],
        ['推理', usage.usage.reasoningTokens, usage.partial.reasoningTokens],
      ] as const
    )
      .filter(([, tokens]) => tokens !== undefined)
      .map(([name, tokens, partial]) => `${name} ${exact.format(tokens!)}${partial ? '（部分记录）' : ''}`)
      .join('\n')
  return (
    <SettingsGroup
      title="用量"
      bare
      meta={
        <SegmentedControl
          label="统计期间"
          value={String(days)}
          options={[
            { value: '7', label: '7 天' },
            { value: '30', label: '30 天' },
          ]}
          onValueChange={next => {
            setDays(next === '30' ? 30 : 7)
          }}
        />
      }
      caption={value && value.rows.length > 0 ? '只汇总这台 Mac 记录到的 tokens，不是账单。' : undefined}
      captionIcon={null}>
      {loading && <Loading label="正在读取用量…" />}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {value && value.rows.length === 0 && <p className="settings-empty">这个期间还没有用量记录。</p>}
      {value && value.rows.length > 0 && (
        <p className="usage-total">
          <strong>{shownTokens(usageTotal(value.rows))}</strong> tokens · 最近 {value.days} 天
        </p>
      )}
      {value && value.rows.length > 0 && (
        <div className="usage-table">
          <table>
            <thead>
              <tr>
                <th>模型</th>
                <th>输入</th>
                <th>输出</th>
              </tr>
            </thead>
            <tbody>
              {value.rows.map((row, index) => (
                <tr key={index} title={detail(row)}>
                  <th scope="row">
                    {row.model ?? '未记录模型名'}
                    <small>
                      {catalog.providers.find(item => item.id === row.providerId)?.name
                        ?? (row.source === 'agent'
                          ? (catalog.harnesses.find(item => item.id === row.harnessId)?.name ?? row.harnessId)
                          : '未记录模型服务')}
                      {row.source === 'agent' ? ' · Harness 报告' : ''}
                    </small>
                  </th>
                  <td>{shownTokens(row.usage.inputTokens)}</td>
                  <td>{shownTokens(row.usage.outputTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {value?.unattributedMessages ? (
        <p className="settings-empty">另有 {value.unattributedMessages} 条记录缺少有效时间或用量，没有计入。</p>
      ) : null}
      {value?.truncated && <InlineNotice>部分会话暂时读不到，这里只算已读到的记录。</InlineNotice>}
    </SettingsGroup>
  )
}
