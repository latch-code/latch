import { useEffect, useState } from 'react'
import type { HostCatalog, UsageSummary } from '@latch/protocol'
import { Button, InlineNotice, Loading, SegmentedControl } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { NoteLine, SettingsGroup } from './common.tsx'
import { readDenied, type ModelSettingsReads } from './modelSettingsReads.ts'

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })
const exact = new Intl.NumberFormat('zh-CN')

/** Tokens short enough to scan in a column; the exact count, with what it includes, is the cell's tooltip. */
export function shownTokens(tokens: number | undefined): string {
  return tokens === undefined ? '未报告' : compact.format(tokens).replace(/K$/u, 'k')
}

/** The period's input and output together, over the rows the table shows. */
export const usageTotal = (rows: UsageSummary['rows']) => rows.reduce((sum, { usage }) => sum + usage.inputTokens + usage.outputTokens, 0)

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

/** The tokens each model used, as this Mac recorded them: never priced, and an Agent's own report is named as one. */
export function UsageSettings({ catalog, reads }: { catalog: HostCatalog; reads: ModelSettingsReads }) {
  const [days, setDays] = useState(reads.days)
  const [settled, settle] = useState<{ days: 7 | 30; turn: number; error: string }>()
  const [turn, setTurn] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void api<UsageSummary>('usage', { method: 'POST', body: { days }, signal: controller.signal }).then(
      result => {
        if (controller.signal.aborted) return
        if (result.days !== days) {
          settle({ days, turn, error: '收到的用量数据与所选期间不符。' })
          return
        }
        reads.legacyUsage.set(days, result)
        settle({ days, turn, error: '' })
      },
      cause => {
        if (controller.signal.aborted) return
        if (readDenied(cause)) reads.legacyUsage.clear()
        settle({ days, turn, error: errorMessage(cause) })
      },
    )
    return () => {
      controller.abort()
    }
  }, [days, reads, turn])
  const value = reads.legacyUsage.get(days)
  const current = settled?.days === days && settled.turn === turn ? settled : undefined
  const error = current?.error
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
            const selected = next === '30' ? 30 : 7
            reads.keepLegacyUsageChoice(selected)
            setDays(selected)
          }}
        />
      }
      note={
        value && value.rows.length > 0 ? <NoteLine brief={{ label: '不是账单', detail: '只汇总这台 Mac 记录到的 tokens。' }} /> : undefined
      }>
      {!current && !value && <Loading label="正在读取用量…" />}
      {error && (
        <InlineNotice
          tone="error"
          action={
            <Button size="sm" onClick={() => setTurn(count => count + 1)}>
              重试
            </Button>
          }>
          {error}
          {value && ' 当前显示上次读取结果。'}
        </InlineNotice>
      )}
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
                          ? (catalog.harnesses.find(item => item.id === row.harnessId)?.capabilities.display.label ?? row.harnessId)
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
