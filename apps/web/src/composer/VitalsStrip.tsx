import { Fragment, type ReactNode } from 'react'
import { Database, Gauge } from 'lucide-react'
import { ICON_STROKE, Popover, Tooltip } from '@latch/ui'
import type { HarnessInfo, TaskDetail, TaskSummary } from '@latch/protocol'
import { exactTokens, formatTokens } from '../format.ts'
import { openUsage } from '../usage/surface.ts'
import { hasVitals, sessionVitals, type SessionVitals } from './vitals.ts'

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
  harnessId,
  by,
  phone = false,
}: {
  vitals: SessionVitals
  /** The Harness whose limits the token item opens. */
  harnessId: string | undefined
  /** Who reported the Harness's numbers, for the breakdown. */
  by: string
  phone?: boolean
}) {
  const { turns, speed, tokens, context } = vitals
  const work = (turns || speed !== undefined) && (
    <Tooltip
      content={
        <TipLines
          lines={[turns && `${turns.turns} 轮 · ${turns.steps} 次工具调用`, speed !== undefined && `本轮输出 ${speed} tok/s · ${by} 报告`]}
        />
      }>
      <span className="vitals-item" tabIndex={0} data-item="work">
        <Gauge size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        {turns && (
          <span>
            {turns.turns} 轮{turns.steps > 0 ? ` ${turns.steps} 步` : ''}
          </span>
        )}
        {speed !== undefined && (
          <>
            {turns && (
              <span className="vitals-dot" aria-hidden="true">
                ·
              </span>
            )}
            <span>{speed} tok/s</span>
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
            `输入 ${exactTokens(tokens.usage.inputTokens)}`,
            tokens.usage.cacheReadTokens !== undefined && `其中缓存读取 ${exactTokens(tokens.usage.cacheReadTokens)}`,
            tokens.usage.cacheWriteTokens !== undefined && `其中缓存写入 ${exactTokens(tokens.usage.cacheWriteTokens)}`,
            `输出 ${exactTokens(tokens.usage.outputTokens)}`,
            tokens.usage.reasoningTokens !== undefined && `其中推理 ${exactTokens(tokens.usage.reasoningTokens)}`,
            tokens.by === 'gateway' ? 'Latch 计量' : `${by} 报告`,
          ]}
        />
      }>
      <button
        type="button"
        className="vitals-item"
        data-item="tokens"
        aria-haspopup="dialog"
        onClick={() => {
          openUsage(harnessId && tokens.by === 'harness' ? { view: 'limits', harnessId } : { view: 'usage' })
        }}>
        <Database size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        <span>{formatTokens(tokens.total)} tok</span>
        {tokens.cached !== undefined && (
          <>
            <span className="vitals-dot" aria-hidden="true">
              ·
            </span>
            <span>缓存命中 {tokens.cached}%</span>
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
              ? `上下文 ${exactTokens(context.used)}`
              : `上下文 ${exactTokens(context.used)} / ${exactTokens(context.size)}`,
            `${by} 报告`,
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
          <span>上下文 {formatTokens(context.used)}</span>
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
    <div className="vitals-strip" role="group" aria-label="会话用量">
      {folded && turns && (
        <Popover
          label="本会话"
          size="sm"
          side="top"
          trigger={props => (
            <button {...props} type="button" className="vitals-item" data-item="more">
              <Gauge size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
              <span>{turns.turns} 轮</span>
            </button>
          )}>
          <TipLines lines={[`${turns.turns} 轮 · ${turns.steps} 次工具调用`, speed !== undefined && `本轮输出 ${speed} tok/s`]} />
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
  return <VitalsStrip vitals={vitals} harnessId={summary.harnessId} by={harness?.capabilities.display.label ?? 'Harness'} phone={phone} />
}
