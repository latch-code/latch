import { Fragment, type ReactNode } from 'react'
import { Database, Gauge } from 'lucide-react'
import { ICON_STROKE, Popover, Tooltip } from '@latch/ui'
import type { HarnessInfo, TaskDetail, TaskSummary } from '@latch/protocol'
import { exactTokens, formatTokens } from '../format.ts'
import { openUsage } from '../usage/surface.ts'
import { hasVitals, sessionVitals, type SessionVitals } from './vitals.ts'
import { harnessName } from '../core/harnessName.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    work: (turns: number, calls: number) => `${formatNumber(turns)} 轮 · ${formatNumber(calls)} 次工具调用`,
    speedReported: (speed: number, source: string) => `本轮输出 ${formatNumber(speed)} tok/s · ${source} 报告`,
    turns: (count: number) => `${formatNumber(count)} 轮`,
    steps: (count: number) => ` ${formatNumber(count)} 步`,
    input: (value1: string) => `输入 ${value1}`,
    cacheRead: (value1: string) => `其中缓存读取 ${value1}`,
    cacheWrite: (value1: string) => `其中缓存写入 ${value1}`,
    output: (value1: string) => `输出 ${value1}`,
    reasoning: (value1: string) => `其中推理 ${value1}`,
    metered: 'Latch 计量',
    reported: (value1: string) => `${value1} 报告`,
    cacheHit: '缓存命中 ',
    context: (value1: string) => `上下文 ${value1}`,
    contextRange: (value1: string, value2: string) => `上下文 ${value1} / ${value2}`,
    contextPrefix: '上下文 ',
    usage: '会话用量',
    thisSession: '本会话',
    speed: (speed: number) => `本轮输出 ${formatNumber(speed)} tok/s`,
  },
  {
    work: (turns: number, calls: number) =>
      `${plural(turns, { one: '{n} turn', other: '{n} turns' })} · ${plural(calls, { one: '{n} tool call', other: '{n} tool calls' })}`,
    speedReported: (speed: number, source: string) => `${formatNumber(speed)} tok/s this turn · Reported by ${source}`,
    turns: (count: number) => plural(count, { one: '{n} turn', other: '{n} turns' }),
    steps: (count: number) => ` ${plural(count, { one: '{n} step', other: '{n} steps' })}`,
    input: (value1: string) => `Input ${value1}`,
    cacheRead: (value1: string) => `Cache input ${value1}`,
    cacheWrite: (value1: string) => `Cache write ${value1}`,
    output: (value1: string) => `Output ${value1}`,
    reasoning: (value1: string) => `Reasoning ${value1}`,
    metered: 'Measured by Latch',
    reported: (value1: string) => `Reported by ${value1}`,
    cacheHit: 'Cache hit ',
    context: (value1: string) => `Context ${value1}`,
    contextRange: (value1: string, value2: string) => `Context ${value1} / ${value2}`,
    contextPrefix: 'Context ',
    usage: 'Session usage',
    thisSession: 'This session',
    speed: (speed: number) => `${formatNumber(speed)} tok/s this turn`,
  },
)

/** The context ring: a quiet track and the used share, amber near the limit. */
function ContextRing({ percent, near }: { percent: number; near: boolean }) {
  const r = 5
  const length = 2 * Math.PI * r
  return (
    <svg className="vitals-ring" data-near={near ? '' : undefined} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r={r} className="vitals-ring-track" />
      <circle
        cx="6"
        cy="6"
        r={r}
        className="vitals-ring-used"
        strokeDasharray={`${(Math.min(Math.max(percent, 0), 100) / 100) * length} ${length}`}
        transform="rotate(-90 6 6)"
      />
    </svg>
  )
}

function TipLines({ lines }: { lines: Array<string | false | undefined> }) {
  return (
    <span className="vitals-tip">
      {lines.filter(Boolean).map(line => (
        <span key={line as string}>{line}</span>
      ))}
    </span>
  )
}

interface Item {
  key: 'work' | 'tokens' | 'context'
  node: ReactNode
}

/**
 * The line under an open session's input: turns and steps with the running reply's speed, the session's tokens with
 * their cached share, and how full the context is. Each item only when it was reported; the height is kept while
 * nothing is, so the input above never moves. On a phone the tokens and the context stay and the rest opens on tap.
 */
function VitalsStrip({
  vitals,
  by,
  phone = false,
}: {
  vitals: SessionVitals
  /** Who reported the Harness's numbers, for the breakdown. */
  by: string
  phone?: boolean
}) {
  const { turns, speed, tokens, context } = vitals
  const work = (turns || speed !== undefined) && (
    <Tooltip
      content={<TipLines lines={[turns && COPY.work(turns.turns, turns.steps), speed !== undefined && COPY.speedReported(speed, by)]} />}>
      <span className="vitals-item" tabIndex={0} data-item="work">
        <Gauge size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        {turns && (
          <span>
            {COPY.turns(turns.turns)}
            {turns.steps > 0 ? COPY.steps(turns.steps) : ''}
          </span>
        )}
        {speed !== undefined && (
          <>
            {turns && (
              <span className="vitals-dot" aria-hidden="true">
                ·
              </span>
            )}
            <span>{formatNumber(speed)} tok/s</span>
          </>
        )}
      </span>
    </Tooltip>
  )
  const tokenItem = tokens && (
    <Tooltip
      content={
        <TipLines
          lines={[
            COPY.input(exactTokens(tokens.usage.inputTokens)),
            tokens.usage.cacheReadTokens !== undefined && COPY.cacheRead(exactTokens(tokens.usage.cacheReadTokens)),
            tokens.usage.cacheWriteTokens !== undefined && COPY.cacheWrite(exactTokens(tokens.usage.cacheWriteTokens)),
            COPY.output(exactTokens(tokens.usage.outputTokens)),
            tokens.usage.reasoningTokens !== undefined && COPY.reasoning(exactTokens(tokens.usage.reasoningTokens)),
            tokens.by === 'gateway' ? COPY.metered : COPY.reported(by),
          ]}
        />
      }>
      <button
        type="button"
        className="vitals-item"
        data-item="tokens"
        aria-haspopup="dialog"
        // What was used, never the plan's limits: those are the quota mark's own.
        onClick={() => {
          openUsage({ view: 'usage' })
        }}>
        <Database size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        <span>{formatTokens(tokens.total)} tok</span>
        {tokens.cached !== undefined && (
          <>
            <span className="vitals-dot" aria-hidden="true">
              ·
            </span>
            <span>
              {COPY.cacheHit}
              {tokens.cached}%
            </span>
          </>
        )}
      </button>
    </Tooltip>
  )
  const contextItem = context && (
    <Tooltip
      content={
        <TipLines
          lines={[
            context.size === undefined
              ? COPY.context(exactTokens(context.used))
              : COPY.contextRange(exactTokens(context.used), exactTokens(context.size)),
            COPY.reported(by),
          ]}
        />
      }>
      <span className="vitals-item" tabIndex={0} data-item="context" data-near={context.near ? '' : undefined}>
        {context.percent !== undefined ? (
          <>
            <ContextRing percent={context.percent} near={context.near} />
            <span>{context.percent}%</span>
          </>
        ) : (
          <span>
            {COPY.contextPrefix}
            {formatTokens(context.used)}
          </span>
        )}
      </span>
    </Tooltip>
  )
  const items: Item[] = [
    ...(work ? [{ key: 'work' as const, node: work }] : []),
    ...(tokenItem ? [{ key: 'tokens' as const, node: tokenItem }] : []),
    ...(contextItem ? [{ key: 'context' as const, node: contextItem }] : []),
  ]
  // On a phone the work item folds behind a tap; the tokens and the context stay on the line.
  const folded = phone && work ? work : undefined
  const shown = folded ? items.filter(item => item.key !== 'work') : items
  return (
    <div className="vitals-strip" role="group" aria-label={COPY.usage}>
      {folded && turns && (
        <Popover
          label={COPY.thisSession}
          size="sm"
          side="top"
          trigger={props => (
            <button {...props} type="button" className="vitals-item" data-item="more">
              <Gauge size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
              <span>{COPY.turns(turns.turns)}</span>
            </button>
          )}>
          <TipLines lines={[COPY.work(turns.turns, turns.steps), speed !== undefined && COPY.speed(speed)]} />
        </Popover>
      )}
      {shown.map(item => (
        <Fragment key={item.key}>{item.node}</Fragment>
      ))}
    </div>
  )
}

/**
 * The line for one open session, read from its summary and detail on each change. The line keeps its height while
 * nothing is reported yet.
 */
export function SessionVitalsLine({
  summary,
  detail,
  harness,
  phone,
}: {
  summary: Pick<TaskSummary, 'id' | 'usage' | 'status' | 'harnessId'>
  detail: Pick<TaskDetail, 'summary' | 'messages' | 'usageReport'> | null | undefined
  harness: Pick<HarnessInfo, 'capabilities'> | undefined
  phone: boolean
}) {
  const vitals = sessionVitals(summary, detail)
  if (!hasVitals(vitals)) return <div className="vitals-strip" aria-hidden="true" />
  return <VitalsStrip vitals={vitals} by={harness ? harnessName(harness) : 'Harness'} phone={phone} />
}
