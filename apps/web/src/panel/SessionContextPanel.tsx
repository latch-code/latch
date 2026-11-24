import type { SessionContext } from '@latch/protocol'
import { Loading } from '@latch/ui'
import { defineCopy, formatNumber, plural, useLocale } from '../core/i18n.ts'
import { dateTime } from '../format.ts'
import { RequestContextHistory } from './RequestContextHistory.tsx'
import { ContextToolActivity } from './ContextToolActivity.tsx'
import { ContextWindowHistory } from './ContextWindowHistory.tsx'

const COPY = defineCopy(
  {
    loading: '正在读取会话上下文…',
    latest: '最近一次模型请求',
    messagesCount: (n: number) => `${formatNumber(n)} 条对话消息`,
    toolsCount: (n: number) => `${formatNumber(n)} 个可用工具`,
    skillsCount: (n: number) => `${formatNumber(n)} 项技能`,
    submitted: '已提交给模型服务',
    breakdown: '请求明细',
    inputTokens: '请求输入',
    userMessages: '用户消息',
    assistantMessages: 'Agent 消息',
    toolResults: '工具结果',
    tools: '可用工具',
    skills: '技能',
    images: '图片',
    creator: '含创作指引',
    record: '会话记录',
    fresh: '最近一次重新开始上下文',
  },
  {
    loading: 'Loading session context…',
    latest: 'Latest model request',
    messagesCount: (n: number) => plural(n, { one: '{n} chat message', other: '{n} chat messages' }),
    toolsCount: (n: number) => plural(n, { one: '{n} available tool', other: '{n} available tools' }),
    skillsCount: (n: number) => plural(n, { one: '{n} skill', other: '{n} skills' }),
    submitted: 'Sent to the model service',
    breakdown: 'Request details',
    inputTokens: 'Input tokens',
    userMessages: 'User messages',
    assistantMessages: 'Agent messages',
    toolResults: 'Tool results',
    tools: 'Available tools',
    skills: 'Skills',
    images: 'Images',
    creator: 'Creator instructions included',
    record: 'Session history',
    fresh: 'Last fresh context',
  },
)
const counts = ['userMessages', 'assistantMessages', 'toolResults', 'tools', 'skills', 'images'] as const
const tokens = (value: number) => `${formatNumber(value)} ${value === 1 ? 'token' : 'tokens'}`

function ReportTime({ label, at }: { label: string; at: string }) {
  return (
    <p className="session-context-at">
      {label} · <time dateTime={at}>{dateTime(at)}</time>
    </p>
  )
}

/** Older sessions kept counts for the last request without a history or text measurements. */
function LatestRequest({ request }: { request: NonNullable<SessionContext['request']> }) {
  return (
    <section>
      <h3>{COPY.latest}</h3>
      {request.inputTokens !== undefined && (
        <div className="session-context-input">
          <strong>{tokens(request.inputTokens)}</strong> <span>{COPY.inputTokens}</span>
        </div>
      )}
      <p>
        {[
          COPY.messagesCount(request.userMessages + request.assistantMessages),
          COPY.toolsCount(request.tools),
          ...(request.skills ? [COPY.skillsCount(request.skills)] : []),
        ].join(' · ')}
      </p>
      <ReportTime label={COPY.submitted} at={request.at} />
      <details className="context-request-details">
        <summary>{COPY.breakdown}</summary>
        <dl className="context-counts">
          {counts.map(key => (
            <div key={key}>
              <dt>{COPY[key]}</dt>
              <dd>{formatNumber(request[key])}</dd>
            </div>
          ))}
        </dl>
        {request.creator && <p>{COPY.creator}</p>}
      </details>
    </section>
  )
}

export function SessionContextPanel({
  context,
  revealTurn,
  revealTool,
}: {
  context?: SessionContext
  revealTurn?: (ref: string) => void
  revealTool?: (ref: string) => void
}) {
  useLocale()
  if (!context) return <Loading label={COPY.loading} />
  const { steps, request, freshAt, window, windows, tools, events } = context
  const showWindows =
    context.kind === 'harness'
    || (!steps.length && !request)
    || window
    || windows.length > 0
    || events?.some(event => event.kind === 'compaction')
  const fresh = steps.length === 0 && !windows.length ? freshAt : undefined
  return (
    <div className="session-context">
      {steps.length > 0 ? (
        <RequestContextHistory steps={steps} revealTurn={revealTurn} revealTool={revealTool} />
      ) : (
        request && <LatestRequest request={request} />
      )}
      {showWindows && <ContextWindowHistory latest={window} windows={windows} events={events} revealTurn={revealTurn} />}
      {fresh && (
        <section>
          <h3>{COPY.record}</h3>
          <ReportTime label={COPY.fresh} at={fresh} />
        </section>
      )}
      <ContextToolActivity tools={tools} />
    </div>
  )
}
