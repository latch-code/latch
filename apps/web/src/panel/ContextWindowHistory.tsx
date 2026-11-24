import { useState } from 'react'
import { Button, chartColour, LineChart, type LinePoint } from '@latch/ui'
import type { ContextPanelEvent, ContextWindowBreakdown, ContextWindowCategory, ContextWindowSource, SessionContext } from '@latch/protocol'
import { defineCopy, formatNumber, plural, useLocale } from '../core/i18n.ts'
import { dateTime, formatDuration, formatTokens } from '../format.ts'

const COPY = defineCopy(
  {
    title: '上下文窗口',
    history: '逐轮窗口占用',
    used: '已用',
    usedTokens: '已用 tokens',
    capacity: '窗口容量',
    missing: '未报告',
    noWindow: 'Harness 尚未报告窗口占用。',
    turn: (n: number) => `第 ${formatNumber(n)} 轮`,
    viewTurn: (n: number) => `查看第 ${formatNumber(n)} 轮对话`,
    delta: (value: string) => `较上一轮净变化 ${value}`,
    reports: (n: number) => `${formatNumber(n)} 份报告`,
    older: '更早的轮次',
    latest: '回到最新报告',
    reset: '重新开始上下文',
    source: 'Harness 报告',
    claude: 'Claude SDK 测量',
    configured: '容量来自模型设置',
    breakdown: '窗口组成',
    usedCategories: '已用上下文',
    classified: (value: string) => `已分类 ${value}`,
    usedTotal: (value: string) => `已用 ${value}`,
    capacityParts: '窗口容量分配',
    capacityTotal: (value: string) => `容量 ${value}`,
    usedOther: '其他已用上下文',
    free: '空闲空间',
    buffer: '压缩预留',
    deferred: '延迟加载',
    deferredNote: '未计入窗口占用',
    messageBreakdown: '其中，消息包含',
    messageTotal: (value: string) => `消息共 ${value}`,
    unitemized: '未细分',
    providerUsage: '最近一次模型服务用量',
    providerSource: '同一次请求，由 Claude SDK 转报',
    input: '输入 tokens',
    output: '输出 tokens',
    compaction: '上下文压缩',
    compacted: '已压缩',
    in_progress: '进行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    unknown: '结果未报告',
    auto: '自动',
    manual: '手动',
    before: '压缩前',
    after: '压缩后',
    duration: '耗时',
  },
  {
    title: 'Context window',
    history: 'Window usage by turn',
    used: 'Used',
    usedTokens: 'Tokens in use',
    capacity: 'Window capacity',
    missing: 'Not reported',
    noWindow: 'The Harness has not reported window usage.',
    turn: (n: number) => `Turn ${formatNumber(n)}`,
    viewTurn: (n: number) => `View turn ${formatNumber(n)} in chat`,
    delta: (value: string) => `Net change from previous turn ${value}`,
    reports: (n: number) => plural(n, { one: '{n} report', other: '{n} reports' }),
    older: 'Earlier turns',
    latest: 'Return to latest report',
    reset: 'Fresh context',
    source: 'Reported by Harness',
    claude: 'Measured by Claude SDK',
    configured: 'Capacity from model settings',
    breakdown: 'Window breakdown',
    usedCategories: 'Context in use',
    classified: (value: string) => `Classified ${value}`,
    usedTotal: (value: string) => `Used ${value}`,
    capacityParts: 'Window capacity allocation',
    capacityTotal: (value: string) => `Capacity ${value}`,
    usedOther: 'Other context in use',
    free: 'Free space',
    buffer: 'Compaction buffer',
    deferred: 'Deferred',
    deferredNote: 'Excluded from window usage',
    messageBreakdown: 'Within messages',
    messageTotal: (value: string) => `Messages total ${value}`,
    unitemized: 'Not itemized',
    providerUsage: 'Latest provider usage',
    providerSource: 'Same request, as reported by the Claude SDK',
    input: 'Input tokens',
    output: 'Output tokens',
    compaction: 'Context compaction',
    compacted: 'Compacted',
    in_progress: 'In progress',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    unknown: 'Outcome not reported',
    auto: 'Automatic',
    manual: 'Manual',
    before: 'Before compaction',
    after: 'After compaction',
    duration: 'Duration',
  },
)

const CATEGORIES = defineCopy(
  {
    system_prompt: '系统提示词',
    system_tools: '内置工具',
    mcp_tools: 'MCP 工具',
    mcp_instructions: 'MCP 指令',
    mcp_tools_deferred: 'MCP 工具（延迟加载）',
    system_tools_deferred: '内置工具（延迟加载）',
    custom_agents: '自定义 Agent',
    memory_files: '记忆文件',
    skills: '技能',
    messages: '消息',
    autocompact_buffer: '自动压缩预留',
    compact_buffer: '压缩预留',
    free_space: '空闲空间',
  },
  {
    system_prompt: 'System prompt',
    system_tools: 'Built-in tools',
    mcp_tools: 'MCP tools',
    mcp_instructions: 'MCP instructions',
    mcp_tools_deferred: 'MCP tools (deferred)',
    system_tools_deferred: 'Built-in tools (deferred)',
    custom_agents: 'Custom agents',
    memory_files: 'Memory files',
    skills: 'Skills',
    messages: 'Messages',
    autocompact_buffer: 'Automatic compaction buffer',
    compact_buffer: 'Compaction buffer',
    free_space: 'Free space',
  },
)

const MESSAGE_PARTS = defineCopy(
  {
    toolCalls: '工具调用',
    toolResults: '工具结果',
    attachments: '附件',
    assistantMessages: 'Agent 消息',
    userMessages: '用户消息',
    redirectedContext: '重定向上下文',
    unattributed: '未归类',
  },
  {
    toolCalls: 'Tool calls',
    toolResults: 'Tool results',
    attachments: 'Attachments',
    assistantMessages: 'Agent messages',
    userMessages: 'User messages',
    redirectedContext: 'Redirected context',
    unattributed: 'Unattributed',
  },
)

type Window = NonNullable<SessionContext['window']>
type TurnWindow = SessionContext['windows'][number]
type Compaction = Extract<ContextPanelEvent, { kind: 'compaction' }>

const tokenCount = (count: number) => `${formatNumber(count)} ${count === 1 ? 'token' : 'tokens'}`
const signedTokens = (count: number) =>
  `${formatNumber(count, { signDisplay: 'exceptZero' })} ${Math.abs(count) === 1 ? 'token' : 'tokens'}`
const sourceLabel = (source: ContextWindowSource | undefined) => (source === 'claude-sdk' ? COPY.claude : COPY.source)

function windowReading(used: number, size: number | undefined) {
  return size !== undefined && size > 0 ? `${formatNumber(used)} / ${tokenCount(size)}` : tokenCount(used)
}

function Counts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="context-counts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function WindowUsage({ window }: { window: Window }) {
  const { used, size } = window
  if (used === undefined || size === undefined || size <= 0) {
    return (
      <Counts
        rows={[
          [COPY.used, used === undefined ? COPY.missing : tokenCount(used)],
          [COPY.capacity, size === undefined ? COPY.missing : tokenCount(size)],
        ]}
      />
    )
  }
  const share = used / size
  const distanceFromFull = Math.abs(share - 1) * 100
  const percent = formatNumber(
    share,
    distanceFromFull > 0 && distanceFromFull < 0.1
      ? { style: 'percent', maximumFractionDigits: Math.max(2, Math.ceil(-Math.log10(distanceFromFull))) }
      : { style: 'percent', maximumSignificantDigits: 4 },
  )
  const value = windowReading(used, size)
  return (
    <div className="context-window-figure">
      <div className="context-window-figures">
        <strong>{percent}</strong>
        <span>{value}</span>
      </div>
      <span
        className="context-window-meter"
        role="meter"
        aria-label={COPY.title}
        aria-valuemin={0}
        aria-valuemax={size}
        aria-valuenow={Math.min(used, size)}
        aria-valuetext={`${value} · ${percent}`}>
        <span style={{ width: `${Math.min(share, 1) * 100}%` }} />
      </span>
    </div>
  )
}

type WindowPart = { label: string; tokens: number; series?: number }

const usedCategoryOrder = [
  'system_prompt',
  'system_tools',
  'mcp_tools',
  'messages',
  'mcp_instructions',
  'custom_agents',
  'memory_files',
  'skills',
  'used',
]
const partColor = ({ series }: WindowPart) => chartColour(series ?? -1)
const sumParts = (parts: readonly WindowPart[]) => parts.reduce((total, part) => total + part.tokens, 0)

function categoryParts(categories: ContextWindowCategory[]): WindowPart[] {
  const totals = new Map<string, { label: string; tokens: number; series: number }>()
  for (const { kind, id, tokens } of categories) {
    const key = id ?? kind
    const label = id ? CATEGORIES[id] : COPY[kind === 'used' ? 'usedOther' : kind]
    totals.set(key, { label, tokens: (totals.get(key)?.tokens ?? 0) + tokens, series: usedCategoryOrder.indexOf(key) })
  }
  return [...totals.values()].toSorted((a, b) => a.series - b.series)
}

function partPercent(ratio: number): string {
  const options = { style: 'percent', maximumFractionDigits: 1 } as const
  if (ratio > 0 && ratio < 0.001) return `<${formatNumber(0.001, options)}`
  if (ratio > 0.999 && ratio < 1) return `>${formatNumber(0.999, options)}`
  return formatNumber(ratio, options)
}

function WindowParts({ parts, denominator, className }: { parts: WindowPart[]; denominator: number | undefined; className?: string }) {
  return (
    <div className={`context-window-parts ${className ?? ''}`}>
      {denominator && denominator > 0 ? (
        <div className="ui-share">
          <div className="context-window-parts-bar" aria-hidden="true">
            {parts
              .filter(part => part.tokens > 0)
              .map(part => (
                <span key={part.label} style={{ width: `${(part.tokens / denominator) * 100}%`, background: partColor(part) }} />
              ))}
          </div>
          <ul className="ui-share-parts">
            {parts.map(part => (
              <li key={part.label}>
                <i className="ui-chart-swatch" aria-hidden="true" style={{ background: partColor(part) }} />
                <span className="ui-share-name">{part.label}</span>
                <span className="ui-share-value">{tokenCount(part.tokens)}</span>
                <span className="ui-share-percent">{partPercent(part.tokens / denominator)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <Counts rows={parts.map(part => [part.label, tokenCount(part.tokens)])} />
      )}
    </div>
  )
}

function WindowBreakdown({ window, breakdown }: { window: Window; breakdown: ContextWindowBreakdown }) {
  const { used, size } = window
  const categories = breakdown.categories
  const usedParts = categoryParts(categories.filter(category => category.kind === 'used'))
  const classified = sumParts(usedParts)
  const usedDenominator = used !== undefined && classified <= used ? used : undefined
  const usedCaption = [
    ...(used === undefined ? [] : [COPY.usedTotal(tokenCount(used))]),
    ...(classified === used ? [] : [COPY.classified(tokenCount(classified))]),
  ].join(' · ')

  const messageCategory = categories.filter(category => category.kind === 'used' && category.id === 'messages')
  const messageTotal = messageCategory.length > 0 ? messageCategory.reduce((total, category) => total + category.tokens, 0) : undefined
  const fields = [
    'toolCalls',
    'toolResults',
    'attachments',
    'assistantMessages',
    'userMessages',
    'redirectedContext',
    'unattributed',
  ] as const
  const messageParts: WindowPart[] = fields.flatMap((field, series) => {
    const tokens = breakdown.messageBreakdown?.[field]
    return tokens === undefined ? [] : [{ label: MESSAGE_PARTS[field], tokens, series }]
  })
  const hasMessageParts = messageParts.length > 0
  const itemized = sumParts(messageParts)
  const messageDenominator = messageTotal !== undefined && itemized <= messageTotal ? messageTotal : undefined
  if (messageDenominator !== undefined && itemized < messageDenominator) {
    messageParts.push({ label: COPY.unitemized, tokens: messageDenominator - itemized })
  }

  const freeParts = categoryParts(categories.filter(category => category.kind === 'free'))
  const bufferParts = categoryParts(categories.filter(category => category.kind === 'buffer'))
  const free = sumParts(freeParts)
  const buffer = sumParts(bufferParts)
  const capacityComplete =
    used !== undefined && size !== undefined && size > 0 && freeParts.length > 0 && bufferParts.length > 0 && used + free + buffer === size
  const capacityParts = capacityComplete
    ? [
        { label: COPY.used, tokens: used, series: 0 },
        { label: COPY.free, tokens: free },
        { label: COPY.buffer, tokens: buffer, series: 1 },
      ]
    : [...freeParts, ...bufferParts]
  const deferredParts = categoryParts(categories.filter(category => category.kind === 'deferred'))
  const provider = breakdown.providerUsage

  return (
    <section className="context-window-breakdown">
      <h3>{COPY.breakdown}</h3>
      {usedParts.length > 0 && (
        <div>
          <h4>{COPY.usedCategories}</h4>
          <p>{usedCaption}</p>
          <WindowParts className="context-window-used-parts" parts={usedParts} denominator={usedDenominator} />
        </div>
      )}
      {hasMessageParts && (
        <details className="context-window-messages">
          <summary>{COPY.messageBreakdown}</summary>
          {messageTotal !== undefined && <p>{COPY.messageTotal(tokenCount(messageTotal))}</p>}
          <WindowParts className="context-window-message-parts" parts={messageParts} denominator={messageDenominator} />
        </details>
      )}
      {capacityParts.length > 0 && (
        <div>
          <h4>{COPY.capacityParts}</h4>
          {size !== undefined && <p>{COPY.capacityTotal(tokenCount(size))}</p>}
          <WindowParts className="context-window-capacity-parts" parts={capacityParts} denominator={capacityComplete ? size : undefined} />
        </div>
      )}
      {deferredParts.length > 0 && (
        <div>
          <h4>{COPY.deferred}</h4>
          <p>{COPY.deferredNote}</p>
          <WindowParts parts={deferredParts} denominator={undefined} />
        </div>
      )}
      {provider && (
        <div>
          <h4>{COPY.providerUsage}</h4>
          <p>{COPY.providerSource}</p>
          <dl className="context-window-provider-counts">
            <div>
              <dt>{COPY.input}</dt>
              <dd>{formatNumber(provider.inputTokens)}</dd>
            </div>
            <div>
              <dt>{COPY.output}</dt>
              <dd>{formatNumber(provider.outputTokens)}</dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  )
}

function WindowChoices({
  rows,
  chosen,
  resets,
  completedCompactions,
  select,
}: {
  rows: TurnWindow[]
  chosen: TurnWindow | undefined
  resets: ReadonlySet<number>
  completedCompactions: ReadonlySet<string>
  select: (row: TurnWindow) => void
}) {
  return (
    <ol className="context-window-choices">
      {rows.map(row => {
        const { turn, window, delta } = row
        const title = (
          <span className="context-window-turn">
            {COPY.turn(turn.number)}
            {completedCompactions.has(turn.ref) && <span className="context-window-compaction-badge">{COPY.compacted}</span>}
          </span>
        )
        return (
          <li key={turn.ref}>
            {resets.has(turn.number) && <div className="context-window-reset">{COPY.reset}</div>}
            {window ? (
              <button type="button" className="context-window-choice" aria-pressed={row === chosen} onClick={() => select(row)}>
                {title}
                <span>{windowReading(window.used, window.size)}</span>
                {delta !== undefined && <small>{COPY.delta(signedTokens(delta))}</small>}
              </button>
            ) : (
              <div className="context-window-missing">
                {title}
                <span>{COPY.missing}</span>
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function CompactionHistory({ events, revealTurn }: { events: Compaction[]; revealTurn?: ((ref: string) => void) | undefined }) {
  return (
    <section className="context-compactions">
      <h3>{COPY.compaction}</h3>
      <ul>
        {events.toReversed().map(({ at, turn, source, status, trigger, beforeTokens, afterTokens, durationMs }, index) => {
          const readings: Array<[string, string]> = []
          if (beforeTokens !== undefined) readings.push([COPY.before, tokenCount(beforeTokens)])
          if (afterTokens !== undefined) readings.push([COPY.after, tokenCount(afterTokens)])
          if (durationMs !== undefined) readings.push([COPY.duration, formatDuration(durationMs) ?? `${formatNumber(durationMs)} ms`])
          return (
            <li key={`${at}-${index}`}>
              <div className="context-section-heading">
                <strong>{COPY[status]}</strong>
                <time dateTime={at}>{dateTime(at)}</time>
              </div>
              <p>{[sourceLabel(source), ...(trigger ? [COPY[trigger]] : []), ...(turn ? [COPY.turn(turn.number)] : [])].join(' · ')}</p>
              {readings.length > 0 && <Counts rows={readings} />}
              {turn && revealTurn && (
                <Button variant="ghost" onClick={() => revealTurn(turn.ref)}>
                  {COPY.viewTurn(turn.number)}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function ContextWindowHistory({
  latest,
  windows,
  events = [],
  revealTurn,
}: {
  latest?: Window | undefined
  windows: SessionContext['windows']
  events?: SessionContext['events']
  revealTurn?: ((ref: string) => void) | undefined
}) {
  useLocale()
  const [pinned, setPinned] = useState<string>()
  const reports = windows.filter(row => row.window)
  const latestSample = reports.at(-1)
  const pinnedSample = reports.find(row => row.turn.ref === pinned)
  const latestReading = latestSample?.window
  const sameLatest =
    latestReading
    && latest
    && latestReading.at === latest.at
    && latestReading.used === latest.used
    && latestReading.size === latest.size
    && latestReading.source === latest.source
    && latestReading.epoch === latest.epoch
  const chosen = pinnedSample ?? (!latest || sameLatest ? latestSample : undefined)
  const report = pinnedSample?.window ?? latest ?? latestReading
  const focusedTurn = chosen?.turn
  // Each composition follows its own observation, including when viewing an older turn.
  const breakdown = report?.source === 'claude-sdk' ? (chosen?.window?.breakdown ?? report.breakdown) : undefined
  const resets = new Set(events.flatMap(event => (event.kind === 'reset' && event.turn ? [event.turn.number] : [])))
  const compactions = events.filter(event => event.kind === 'compaction')
  const completedCompactions = new Set(compactions.flatMap(event => (event.status === 'completed' && event.turn ? [event.turn.ref] : [])))
  const points = windows.flatMap((row, index): LinePoint[] => {
    const { turn, window, delta } = row
    const point: LinePoint = {
      key: turn.ref,
      label: formatNumber(turn.number),
      title: COPY.turn(turn.number),
      value: window?.used,
    }
    return window && windows[index - 1]?.window && delta === undefined ? [{ key: `gap-${turn.ref}`, label: '' }, point] : [point]
  })
  const firstRecent = reports.length > 3 ? Math.max(0, windows.indexOf(reports.at(-3)!)) : 0
  const choose = (row: TurnWindow) => setPinned(row === latestSample && (!latest || sameLatest) ? undefined : row.turn.ref)
  return (
    <>
      <section className="context-window-overview">
        <header className="context-section-heading">
          <h3>{COPY.title}</h3>
          {focusedTurn && <span>{COPY.turn(focusedTurn.number)}</span>}
        </header>
        {report ? (
          <>
            <WindowUsage window={report} />
            <p className="session-context-at">
              {sourceLabel(report.source)} · <time dateTime={report.at}>{dateTime(report.at)}</time>
              {report.configuredSize && ` · ${COPY.configured}`}
            </p>
          </>
        ) : (
          <p>{COPY.noWindow}</p>
        )}
      </section>
      {reports.length > 0 && (
        <section className="context-window-history">
          <header className="context-section-heading">
            <h3>{COPY.history}</h3>
            <span>{COPY.reports(reports.length)}</span>
          </header>
          {reports.length >= 3 && (
            <>
              <p className="context-window-plot-unit" aria-hidden="true">
                {COPY.usedTokens}
              </p>
              <LineChart points={points} label={COPY.usedTokens} format={formatTokens} height={100} />
            </>
          )}
          {firstRecent > 0 && (
            <details>
              <summary>{COPY.older}</summary>
              <WindowChoices
                rows={windows.slice(0, firstRecent)}
                chosen={chosen}
                select={choose}
                resets={resets}
                completedCompactions={completedCompactions}
              />
            </details>
          )}
          <WindowChoices
            rows={windows.slice(firstRecent)}
            chosen={chosen}
            select={choose}
            resets={resets}
            completedCompactions={completedCompactions}
          />
          {((focusedTurn && revealTurn) || pinnedSample) && (
            <div className="context-window-actions">
              {focusedTurn && revealTurn && (
                <Button variant="ghost" onClick={() => revealTurn(focusedTurn.ref)}>
                  {COPY.viewTurn(focusedTurn.number)}
                </Button>
              )}
              {pinnedSample && (
                <Button variant="ghost" onClick={() => setPinned(undefined)}>
                  {COPY.latest}
                </Button>
              )}
            </div>
          )}
        </section>
      )}
      {report && breakdown && <WindowBreakdown window={report} breakdown={breakdown} />}
      {compactions.length > 0 && <CompactionHistory events={compactions} revealTurn={revealTurn} />}
    </>
  )
}
