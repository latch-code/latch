import { useState } from 'react'
import type { HarnessInfo } from '@latch/protocol'
import { Button, ChevronRightGlyph, Count, Icon, StatusWord } from '@latch/ui'
import { MessageContent } from '../MessageContent.tsx'
import { SUBAGENT_STATUS } from '../components/SubagentRow.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { KindGlyph } from '../conversation/KindGlyph.tsx'
import { defineCopy, formatNumber } from '../core/i18n.ts'
import { CODEX_TEAM_REQUEST, memberWords } from '../teams/copy.ts'
import { MEMBER_TONE } from '../teams/model.ts'
import { MemberTile } from '../teams/TeamGraph.tsx'
import { agentState, type ObservedAgent, type OverviewAgent } from './overviewAgents.ts'

const COPY = defineCopy(
  {
    members: '团队成员',
    children: '子 Agent',
    parent: (name: string) => `由 ${name} 派出`,
    lastSeen: (status: string) => `上次：${status}`,
    more: (n: number) => `显示其余 ${formatNumber(n)} 个`,
    less: '收起列表',
    request: '分工请求',
    result: '成员结果',
    report: '最新回报',
    stopping: '正在停止…',
    unreported: '未报告状态',
    active: (count: number) => `${formatNumber(count)} 个运行中`,
    waiting: (count: number) => `${formatNumber(count)} 个等你处理`,
    record: '查看工作记录',
    approval: '查看此成员的审批',
  },
  {
    members: 'Team members',
    children: 'Subagents',
    parent: (name: string) => `Started by ${name}`,
    lastSeen: (status: string) => `Last seen: ${status}`,
    more: (n: number) => `Show ${formatNumber(n)} more`,
    less: 'Show fewer',
    request: 'Team request',
    result: 'Member result',
    report: 'Latest update',
    stopping: 'Stopping…',
    unreported: 'No status reported',
    active: (count: number) => `${formatNumber(count)} running`,
    waiting: (count: number) => `${formatNumber(count)} need attention`,
    record: 'View activity',
    approval: 'Review this member’s approval',
  },
)

interface AgentActions {
  openSession: (id: string) => void
  reveal: (id: string) => void
  review: (id: string) => void
}

function AgentDetails({ row, reveal, review }: { row: ObservedAgent } & Pick<AgentActions, 'reveal' | 'review'>) {
  const { agent, request, parent, approval } = row
  const report = agent.team?.result ?? agent.steps.findLast(step => step.role === 'assistant' && step.text.trim())?.text
  const task = request?.teamRequest ? request.text.replace(CODEX_TEAM_REQUEST, '').trim() : undefined
  return (
    <div className="overview-agent-detail">
      {parent && (
        <p>
          <VisibleText text={COPY.parent(parent)} />
        </p>
      )}
      {agent.description && (
        <p>
          <VisibleText text={agent.description} />
        </p>
      )}
      {task && (
        <details>
          <summary>{COPY.request}</summary>
          <p>
            <VisibleText text={task} />
          </p>
        </details>
      )}
      {agent.team?.failure && (
        <p className="overview-agent-error">
          <VisibleText text={agent.team.failure} />
        </p>
      )}
      {report && (
        <div className="overview-agent-report">
          <strong>{agent.status === 'done' ? COPY.result : COPY.report}</strong>
          <MessageContent text={report} />
        </div>
      )}
      <div className="overview-agent-actions">
        {approval && (
          <Button size="xs" variant="outline" onClick={() => review(approval.id)}>
            {COPY.approval}
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={() => reveal(row.id)}>
          {COPY.record}
        </Button>
      </div>
    </div>
  )
}

function AgentRow({
  row,
  harnesses,
  connected,
  actions,
}: {
  row: OverviewAgent
  harnesses: readonly HarnessInfo[]
  connected: boolean
  actions: AgentActions
}) {
  const [open, setOpen] = useState(false)
  const sessionId = row.kind === 'session' ? row.member.sessionId : undefined
  const name = row.kind === 'session' ? row.member.name || row.member.title : row.agent.title
  const subtitle =
    row.kind === 'session'
      ? row.member.refusal || (row.member.title !== name ? row.member.title : row.member.said)
      : row.agent.description || (row.parent ? COPY.parent(row.parent) : undefined)
  const state = agentState(row)
  const status =
    row.kind === 'session'
      ? { tone: MEMBER_TONE[row.member.state], words: memberWords(row.member.state) }
      : state === 'stopping'
        ? { tone: 'neutral' as const, words: COPY.stopping }
        : row.approval || row.agent.status
          ? SUBAGENT_STATUS[row.approval ? 'waiting' : row.agent.status!]
          : { tone: 'neutral' as const, words: COPY.unreported }
  const stale = !connected && (status.tone === 'running' || status.tone === 'waiting' || state === 'stopping')
  const body = (
    <>
      {row.kind === 'session' ? <MemberTile harnessId={row.member.harnessId} harnesses={harnesses} /> : <KindGlyph kind="agent" />}
      <span className="overview-agent-name">
        <VisibleText text={name} />
      </span>
      <StatusWord tone={stale ? 'neutral' : status.tone}>{stale ? COPY.lastSeen(status.words) : status.words}</StatusWord>
      {(row.kind === 'subagent' || sessionId) && <Icon className="overview-agent-chevron" icon={ChevronRightGlyph} size={12} />}
      {subtitle && (
        <span className="overview-agent-task">
          <VisibleText text={subtitle} />
        </span>
      )}
    </>
  )
  return (
    <li className="overview-agent">
      {row.kind === 'session' && !sessionId ? (
        <div className="overview-agent-line">{body}</div>
      ) : (
        <button
          type="button"
          className="overview-agent-line"
          aria-expanded={row.kind === 'subagent' ? open : undefined}
          onClick={() => (sessionId ? actions.openSession(sessionId) : setOpen(!open))}>
          {body}
        </button>
      )}
      {row.kind === 'subagent' && open && <AgentDetails row={row} reveal={actions.reveal} review={actions.review} />}
    </li>
  )
}

const PREVIEW_ROWS = 4

export function OverviewAgentSection({
  team,
  rows,
  harnesses,
  connected,
  actions,
}: {
  team?: boolean
  rows: readonly OverviewAgent[]
  harnesses: readonly HarnessInfo[]
  connected: boolean
  actions: AgentActions
}) {
  const [open, setOpen] = useState(true)
  const [showAll, setShowAll] = useState(false)
  if (!rows.length) return null
  const waiting = rows.filter(row => agentState(row) === 'waiting').length
  const active = rows.filter(row => ['starting', 'running'].includes(agentState(row) ?? '')).length
  const activity = waiting ? COPY.waiting(waiting) : active ? COPY.active(active) : undefined
  const title = team ? COPY.members : COPY.children
  return (
    <section className="session-overview-section overview-agents" aria-label={title}>
      <h3>
        <button type="button" className="overview-agents-heading" aria-expanded={open} onClick={() => setOpen(!open)}>
          {title}
          <Count value={rows.length} />
          <span className="overview-agents-activity">{connected && activity}</span>
          <Icon icon={ChevronRightGlyph} size={12} />
        </button>
      </h3>
      {open && (
        <>
          <ul>
            {(showAll ? rows : rows.slice(0, PREVIEW_ROWS)).map(row => (
              <AgentRow key={row.id} row={row} connected={connected} harnesses={harnesses} actions={actions} />
            ))}
          </ul>
          {rows.length > PREVIEW_ROWS && (
            <Button variant="ghost" size="xs" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
              {showAll ? COPY.less : COPY.more(rows.length - PREVIEW_ROWS)}
            </Button>
          )}
        </>
      )}
    </section>
  )
}
