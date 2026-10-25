import { useEffect, useState } from 'react'
import type { HostCatalog, UsageSummary } from '@latch/protocol'
import { InlineNotice, SegmentedControl } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { SettingsGroup } from './common.tsx'
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
    return () => controller.abort()
  }, [days])
  const number = (tokens: number | undefined) => (tokens === undefined ? '未报告' : tokens.toLocaleString('zh-CN'))
  return (
    <SettingsGroup title="模型用量" caption="只汇总执行端实际记录的 tokens，不推算价格。Agent 报告的数据不是账单。">
      <SegmentedControl
        label="统计期间"
        value={String(days)}
        options={[
          { value: '7', label: '最近 7 天' },
          { value: '30', label: '最近 30 天' },
        ]}
        onValueChange={value => setDays(value === '30' ? 30 : 7)}
      />
      {loading && <p role="status">正在读取用量…</p>}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {value && !value.rows.length && <p>这个期间还没有可汇总的用量记录。</p>}
      {value && value.rows.length > 0 && (
        <div className="usage-table">
          <table>
            <thead>
              <tr>
                <th>模型 / 来源</th>
                <th>输入（含缓存）</th>
                <th>输出（含推理）</th>
                <th>缓存读取</th>
                <th>缓存写入</th>
                <th>推理</th>
              </tr>
            </thead>
            <tbody>
              {value.rows.map((row, index) => (
                <tr key={index}>
                  <th scope="row">
                    {row.model ?? '未记录模型名'}
                    <small>
                      {catalog.providers.find(item => item.id === row.providerId)?.name
                        ?? (row.source === 'agent'
                          ? (catalog.harnesses.find(item => item.id === row.harnessId)?.name ?? row.harnessId)
                          : '未记录模型服务')}
                      {row.source === 'agent' ? ' · Agent 报告' : ''}
                    </small>
                  </th>
                  <td>{number(row.usage.inputTokens)}</td>
                  <td>{number(row.usage.outputTokens)}</td>
                  {(['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const).map(part => (
                    <td key={part}>
                      {number(row.usage[part])}
                      {row.usage[part] !== undefined && row.partial[part] && <small>部分记录</small>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {value?.unattributedMessages ? <p>另有 {value.unattributedMessages} 条记录缺少有效时间或用量，未计入该期间。</p> : null}
      {value?.truncated && <InlineNotice>部分会话暂时未能读取，当前显示已读取的记录。</InlineNotice>}
    </SettingsGroup>
  )
}
