import type { ContextPanelToolCount, SessionContext } from '@latch/protocol'
import { defineCopy, formatNumber, plural, useLocale } from '../core/i18n.ts'
import { formatDuration } from '../format.ts'

const COPY = defineCopy(
  {
    title: '会话工具调用',
    unknown: '未命名工具',
    empty: '会话中还没有工具调用记录。',
    calls: (n: number) => `共 ${formatNumber(n)} 次`,
    failed: (n: number) => `${formatNumber(n)} 次失败`,
    longest: (time: string) => `单次最长实测 ${time}`,
    more: (n: number) => `其余 ${formatNumber(n)} 种工具`,
  },
  {
    title: 'Tool calls in this chat',
    unknown: 'Unnamed tool',
    empty: 'No tool calls recorded in this chat yet.',
    calls: (n: number) => plural(n, { one: '{n} call', other: '{n} calls' }),
    failed: (n: number) => plural(n, { one: '{n} failure', other: '{n} failures' }),
    longest: (time: string) => `Longest measured call ${time}`,
    more: (n: number) => plural(n, { one: '{n} more tool', other: '{n} more tools' }),
  },
)

function ToolRows({ groups, total }: { groups: ContextPanelToolCount[]; total: number }) {
  return (
    <ul className="context-tool-rows">
      {groups.map(group => {
        const duration = formatDuration(group.longestMs)
        return (
          <li key={group.name}>
            <bdi title={group.name || COPY.unknown}>{group.name || COPY.unknown}</bdi>
            <span className="context-tool-track" aria-hidden="true">
              <i style={{ width: `${(100 * (group.calls - group.failed)) / total}%` }} />
              {group.failed > 0 && <i className="context-tool-failure" style={{ width: `${(100 * group.failed) / total}%` }} />}
            </span>
            <span>{formatNumber(group.calls)}</span>
            {(group.failed > 0 || duration) && (
              <small>
                {group.failed > 0 && <span className="context-tool-failed-count">{COPY.failed(group.failed)}</span>}
                {group.failed > 0 && duration && ' · '}
                {duration && COPY.longest(duration)}
              </small>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function ContextToolActivity({ tools: { groups, total, failures } }: { tools: SessionContext['tools'] }) {
  useLocale()
  return (
    <section className="context-tool-activity">
      <header>
        <h3>{COPY.title}</h3>
        {total > 0 && (
          <span>
            {COPY.calls(total)}
            {failures > 0 && ` · ${COPY.failed(failures)}`}
          </span>
        )}
      </header>
      {total ? <ToolRows groups={groups.slice(0, 3)} total={total} /> : <p>{COPY.empty}</p>}
      {groups.length > 3 && (
        <details>
          <summary>{COPY.more(groups.length - 3)}</summary>
          <ToolRows groups={groups.slice(3)} total={total} />
        </details>
      )}
    </section>
  )
}
