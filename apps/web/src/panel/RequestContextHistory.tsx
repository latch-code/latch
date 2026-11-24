import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import type { ContextPanelStep, ContextPanelToolContribution } from '@latch/protocol'
import { BarChart, Button, IconButton, ShareBar } from '@latch/ui'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'
import { dateTime, formatDuration } from '../format.ts'

const COPY = defineCopy(
  {
    trend: '上下文演变',
    composition: '请求组成',
    textInput: '输入文本 · UTF-8',
    detail: '请求明细',
    instructions: '指令',
    skills: '技能',
    toolSchemas: '工具定义',
    user: '用户消息',
    assistant: 'Agent 消息',
    toolResults: '工具结果',
    guide: '指令与技能',
    conversation: '对话消息',
    images: '图片',
    creator: '含创作指引',
    category: '来源',
    items: '项数',
    bytes: 'UTF-8 字节',
    note: '组成按 UTF-8 字节计量，图片单独计数。tokens 由模型服务报告。',
    prev: '上一次请求',
    next: '下一次请求',
    latest: '回到最新请求',
    latestMark: '最新',
    viewTurn: (n: number) => `查看第 ${formatNumber(n)} 轮对话`,
    sequence: (n: number) => `第 ${formatNumber(n)} 次请求`,
    requests: (n: number) => `${formatNumber(n)} 次请求`,
    retained: (n: number) => `最近 ${formatNumber(n)} 次请求`,
    input: '输入 token',
    output: '输出 token',
    duration: '请求耗时',
    noReport: '未报告',
    biggest: '此时占得最多',
    change: '较上次',
    growth: '较上次增长最多',
    reduction: '较上次减少最多',
    grew: (name: string, size: string) => `${name}增加 ${size}`,
    shrank: (name: string, size: string) => `${name}减少 ${size}`,
    unchanged: '各来源文本大小与上次相同',
    first: '首次记录',
    reset: '重新开始上下文',
    net: (size: string) => `净变化 ${size}`,
    requestTools: '本次请求的工具结果',
    largest: '最大的工具结果',
    added: '本次新增结果',
    additional: '其余新增结果',
    new: '本次新增',
    replayed: '已在上次带入',
    unknown: '未知何时首次带入',
    unnamed: '工具结果',
    viewTool: (name: string) => `查看工具输出：${name}`,
    running: '进行中',
    completed: '已完成',
    failed: '请求失败',
    cancelled: '已取消',
    interrupted: '已中断',
    partial: (n: number) => `${formatNumber(n)} 个工具定义未计入文本大小。`,
    calls: (n: number) => `请求了 ${formatNumber(n)} 次工具调用`,
  },
  {
    trend: 'Context history',
    composition: 'Request composition',
    textInput: 'Input text · UTF-8',
    detail: 'Request details',
    instructions: 'Instructions',
    skills: 'Skills',
    toolSchemas: 'Tool definitions',
    user: 'User messages',
    assistant: 'Agent messages',
    toolResults: 'Tool results',
    guide: 'Instructions and skills',
    conversation: 'Chat messages',
    images: 'Images',
    creator: 'Creator instructions included',
    category: 'Source',
    items: 'Items',
    bytes: 'UTF-8 bytes',
    note: 'Composition uses UTF-8 bytes. Images are counted separately. The provider reports tokens.',
    prev: 'Previous request',
    next: 'Next request',
    latest: 'Return to latest request',
    latestMark: 'Latest',
    viewTurn: (n: number) => `View turn ${formatNumber(n)} in chat`,
    sequence: (n: number) => `Request ${formatNumber(n)}`,
    requests: (n: number) => plural(n, { one: '{n} request', other: '{n} requests' }),
    retained: (n: number) => plural(n, { one: 'Last request', other: 'Last {n} requests' }),
    input: 'Input tokens',
    output: 'Output tokens',
    duration: 'Request time',
    noReport: 'Not reported',
    biggest: 'Largest in this request',
    change: 'Vs previous',
    growth: 'Biggest growth vs previous',
    reduction: 'Biggest drop vs previous',
    grew: (name: string, size: string) => `${name} grew by ${size}`,
    shrank: (name: string, size: string) => `${name} fell by ${size}`,
    unchanged: 'Same text size for every source',
    first: 'First observation',
    reset: 'Fresh context',
    net: (size: string) => `Net change ${size}`,
    requestTools: 'Tool results in this request',
    largest: 'Largest tool results',
    added: 'New tool results',
    additional: 'Other new tool results',
    new: 'New in this request',
    replayed: 'Already in previous request',
    unknown: 'First inclusion unknown',
    unnamed: 'Tool result',
    viewTool: (name: string) => `View tool output: ${name}`,
    running: 'In progress',
    completed: 'Completed',
    failed: 'Request failed',
    cancelled: 'Cancelled',
    interrupted: 'Interrupted',
    partial: (n: number) =>
      plural(n, { one: '{n} tool definition excluded from text size.', other: '{n} tool definitions excluded from text size.' }),
    calls: (n: number) => plural(n, { one: 'Requested {n} tool call', other: 'Requested {n} tool calls' }),
  },
)

const sources = ['instructions', 'skills', 'toolSchemas', 'user', 'assistant', 'toolResults'] as const
const counts = {
  skills: 'skills',
  toolSchemas: 'tools',
  user: 'userMessages',
  assistant: 'assistantMessages',
  toolResults: 'toolResults',
} as const
const groups = ['guide', 'toolSchemas', 'conversation', 'toolResults'] as const

function groupedBytes({ bytes }: ContextPanelStep): number[] {
  return [bytes.instructions + bytes.skills, bytes.toolSchemas, bytes.user + bytes.assistant, bytes.toolResults]
}

function byteSize(n: number): string {
  if (n < 1_000) return `${formatNumber(n)} B`
  const divisor = n < 1_000_000 ? 1_000 : 1_000_000
  return `${formatNumber(n / divisor, { maximumFractionDigits: 1 })} ${divisor === 1_000 ? 'kB' : 'MB'}`
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

const exactBytes = (n: number) => `${formatNumber(n)} B`
const signedBytes = (n: number) => `${formatNumber(n, { signDisplay: 'exceptZero' })} B`

function RequestSummary({ step, previous, values }: { step: ContextPanelStep; previous?: ContextPanelStep | undefined; values: number[] }) {
  const largest = Math.max(...values)
  const completeComparison =
    !step.freshContext && previous && previous.sequence + 1 === step.sequence && !step.unmeasuredTools && !previous.unmeasuredTools
  const changes = completeComparison ? groupedBytes(previous).map((value, index) => values[index] - value) : undefined
  const gain = changes && Math.max(...changes)
  const loss = changes && Math.min(...changes)
  const driver = gain && gain > 0 ? gain : loss
  const group = changes && driver ? groups[changes.indexOf(driver)] : undefined
  return (
    <dl className="context-request-summary">
      {largest > 0 && (
        <div>
          <dt>{COPY.biggest}</dt>
          <dd>
            {COPY[groups[values.indexOf(largest)]]} · {exactBytes(largest)}
          </dd>
        </div>
      )}
      {changes && (
        <div>
          {group && driver ? (
            <>
              <dt>{driver > 0 ? COPY.growth : COPY.reduction}</dt>
              <dd>{driver > 0 ? COPY.grew(COPY[group], exactBytes(driver)) : COPY.shrank(COPY[group], exactBytes(-driver))}</dd>
            </>
          ) : (
            <>
              <dt>{COPY.change}</dt>
              <dd>{COPY.unchanged}</dd>
            </>
          )}
          <dd className="context-net-change">{COPY.net(signedBytes(sum(changes)))}</dd>
        </div>
      )}
    </dl>
  )
}

function ToolResultRows({
  rows,
  revealTool,
}: {
  rows: readonly ContextPanelToolContribution[]
  revealTool?: ((ref: string) => void) | undefined
}) {
  return (
    <ul className="context-tool-result-rows">
      {rows.map(({ bytes, inclusion, name = COPY.unnamed, toolRef }, index) => {
        const content = (
          <>
            <bdi>{name}</bdi>
            <span>
              {exactBytes(bytes)} · {COPY[inclusion]}
            </span>
          </>
        )
        return (
          <li key={toolRef ?? index}>
            {toolRef && revealTool ? (
              <button
                type="button"
                className="context-tool-result-link"
                aria-label={COPY.viewTool(name)}
                onClick={() => revealTool(toolRef)}>
                {content}
              </button>
            ) : (
              <div className="context-tool-result">{content}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function RequestToolResults({
  contributions,
  revealTool,
}: {
  contributions: ContextPanelStep['toolContributions']
  revealTool?: ((ref: string) => void) | undefined
}) {
  if (!contributions) return null
  const { largest } = contributions
  const refs = new Set(largest.flatMap(row => (row.toolRef ? [row.toolRef] : [])))
  const added = contributions.added.filter(row => !row.toolRef || !refs.has(row.toolRef))
  if (!largest.length && !added.length) return null
  return (
    <section className="context-request-tools">
      <h3>{COPY.requestTools}</h3>
      {largest.length > 0 && (
        <div>
          <h4>{COPY.largest}</h4>
          <ToolResultRows rows={largest} revealTool={revealTool} />
        </div>
      )}
      {added.length > 0 && (
        <div>
          <h4>{added.length === contributions.added.length ? COPY.added : COPY.additional}</h4>
          <ToolResultRows rows={added} revealTool={revealTool} />
        </div>
      )}
    </section>
  )
}

function RequestDetails({ step }: { step: ContextPanelStep }) {
  return (
    <details className="context-request-details">
      <summary>{COPY.detail}</summary>
      <table>
        <thead>
          <tr>
            <th scope="col">{COPY.category}</th>
            <th scope="col">{COPY.items}</th>
            <th scope="col">{COPY.bytes}</th>
          </tr>
        </thead>
        <tbody>
          {sources.map(source => (
            <tr key={source}>
              <th scope="row">{COPY[source]}</th>
              <td>{source === 'instructions' ? '—' : formatNumber(step[counts[source]])}</td>
              <td>{formatNumber(step.bytes[source])}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">{COPY.images}</th>
            <td>{formatNumber(step.images)}</td>
            <td>—</td>
          </tr>
        </tbody>
      </table>
      <p>
        {COPY.note}
        {step.creator && ` · ${COPY.creator}`}
      </p>
    </details>
  )
}

/** A recorded sequence is stable as new replies arrive, even when older observations leave the bounded history. */
export function RequestContextHistory({
  steps,
  revealTurn,
  revealTool,
}: {
  steps: ContextPanelStep[]
  revealTurn?: ((ref: string) => void) | undefined
  revealTool?: ((ref: string) => void) | undefined
}) {
  const [pinned, setPinned] = useState<number>()
  const last = steps.length - 1
  const matched = pinned === undefined ? -1 : steps.findIndex(step => step.sequence === pinned)
  const selectedIndex = matched < 0 ? last : matched
  const step = steps[selectedIndex]
  const { turn } = step
  const select = (sequence?: number) => setPinned(sequence === steps[last].sequence ? undefined : sequence)
  const series = groups.map(key => COPY[key])
  const columns = steps.map(item => ({
    key: String(item.sequence),
    label: String(item.sequence),
    title: COPY.sequence(item.sequence),
    values: groupedBytes(item),
  }))
  const values = columns[selectedIndex].values
  const status = [
    ...(step.status === 'completed' || step.status === 'running' ? [] : [COPY[step.status]]),
    ...(step.toolCalls ? [COPY.calls(step.toolCalls)] : []),
  ].join(' · ')
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...event.currentTarget.querySelectorAll<SVGElement>('g[role="button"]')]
    const focused = buttons.findIndex(button => button === event.target)
    if (focused < 0) return
    const target = { Home: 0, End: last, ArrowLeft: Math.max(0, focused - 1), ArrowRight: Math.min(last, focused + 1) }[event.key]
    if (target === undefined) return
    event.preventDefault()
    select(steps[target].sequence)
    buttons[target]?.focus()
  }
  return (
    <>
      <section className="context-history">
        <header className="context-section-heading">
          <h3>{COPY.trend}</h3>
          <span>{steps[0].sequence > 1 ? COPY.retained(steps.length) : COPY.requests(steps.length)}</span>
        </header>
        <div className="context-history-figure">
          <strong>{exactBytes(sum(values))}</strong>
          <span>{COPY.textInput}</span>
        </div>
        {(step.freshContext || step.sequence === 1) && (
          <p className="context-history-marker">{step.freshContext ? COPY.reset : COPY.first}</p>
        )}
        <div onKeyDown={move}>
          <BarChart
            label={COPY.trend}
            columns={columns}
            series={series}
            selected={String(step.sequence)}
            onSelect={key => select(key === undefined ? undefined : Number(key))}
            format={byteSize}
            height={128}
          />
        </div>
        <div className="context-step-nav">
          <div className="context-step-selector">
            <IconButton
              size="sm"
              label={COPY.prev}
              icon={ChevronLeft}
              disabled={selectedIndex === 0}
              onClick={() => select(steps[selectedIndex - 1].sequence)}
            />
            <span>{COPY.sequence(step.sequence)}</span>
            <IconButton
              size="sm"
              label={COPY.next}
              icon={ChevronRight}
              disabled={selectedIndex === last}
              onClick={() => select(steps[selectedIndex + 1].sequence)}
            />
          </div>
          {selectedIndex < last ? (
            <Button variant="ghost" onClick={() => select()}>
              {COPY.latest}
            </Button>
          ) : (
            <span>{COPY.latestMark}</span>
          )}
        </div>
      </section>
      <section aria-label={COPY.composition} className="context-composition">
        <header className="context-section-heading">
          <h3>{COPY.composition}</h3>
          <time dateTime={step.at}>{dateTime(step.at)}</time>
        </header>
        <RequestSummary step={step} previous={steps[selectedIndex - 1]} values={values} />
        <ShareBar
          label={COPY.composition}
          parts={groups.map((key, index) => ({ key, label: COPY[key], name: COPY[key], value: values[index] }))}
          format={byteSize}
        />
        {step.unmeasuredTools ? <p className="context-partial">{COPY.partial(step.unmeasuredTools)}</p> : null}
        <dl className="context-metrics">
          <div>
            <dt>{COPY.input}</dt>
            <dd>{step.inputTokens === undefined ? COPY.noReport : formatNumber(step.inputTokens)}</dd>
          </div>
          <div>
            <dt>{COPY.output}</dt>
            <dd>{step.outputTokens === undefined ? COPY.noReport : formatNumber(step.outputTokens)}</dd>
          </div>
          <div>
            <dt>{COPY.duration}</dt>
            <dd>
              {step.durationMs === undefined
                ? step.status === 'running'
                  ? COPY.running
                  : COPY.noReport
                : (formatDuration(step.durationMs) ?? `${formatNumber(step.durationMs)} ms`)}
            </dd>
          </div>
        </dl>
        {status && <p className="context-request-status">{status}</p>}
        <div className="context-request-actions">
          <RequestDetails step={step} />
          {turn && revealTurn && (
            <Button variant="ghost" onClick={() => revealTurn(turn.ref)}>
              {COPY.viewTurn(turn.number)}
            </Button>
          )}
        </div>
      </section>
      <RequestToolResults contributions={step.toolContributions} revealTool={revealTool} />
    </>
  )
}
