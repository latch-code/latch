import { useState, type ReactNode } from 'react'

import { GENERAL_AGENT_ID, type AutomationSummary, type TaskSummary } from '@latch/protocol'
import { Button, Count, EmptyState, Icon, OverviewGlyph, PlusGlyph, ScheduleGlyph, Skeleton, StatusWord, WaitingGlyph } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { DEVICE_OFFLINE } from '../core/hostState.ts'
import { ConnectionBanners } from '../shell/ConnectionBanners.tsx'
import { WorkbenchDecision } from '../shell/WorkbenchDecision.tsx'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { AgentAvatar, AgentsGlyph } from './AgentAvatar.tsx'
import { shellRoster } from './AgentsSpaceList.tsx'
import { readsAgents, RUN_WORDS } from './model.ts'
import { LockedAgents } from './parts.tsx'
import { addressable, agentsOverview, OVERVIEW_ROWS, rowFor, type RosterRow } from './roster.ts'
import { scheduleOverview, whenWords } from './scheduleModel.ts'

/** A topic's row is signed by its helper: the face and the name, never a project, Harness or model. */
const personOf = (rows: readonly RosterRow[], task: TaskSummary) => {
  const row = rowFor(rows, task)
  return { name: row?.name ?? 'Agent', avatar: row?.avatar ?? ('general' as const) }
}

/** 「还有 N 件」 under a group that holds more than it shows. */
function More({ total, open, onToggle }: { total: number; open: boolean; onToggle: () => void }) {
  if (total <= OVERVIEW_ROWS) return null
  return (
    <Button variant="ghost" className="work-overview-more" aria-expanded={open} onClick={onToggle}>
      {open ? '收起' : `还有 ${total - OVERVIEW_ROWS} 件`}
    </Button>
  )
}

function ScheduleRow({
  automation,
  agent,
  at,
  now,
  action,
  status,
}: {
  automation: AutomationSummary
  agent: RosterRow | undefined
  at: string
  now: number
  action?: () => void
  status?: ReactNode
}) {
  const content = (
    <>
      <AgentAvatar avatar={agent?.avatar ?? 'general'} size={22} />
      <span className="agents-home-schedule-text">
        <span className="work-overview-row-title">
          <VisibleText text={automation.name} />
        </span>
        <span className="work-overview-row-context">
          {agent && (
            <span>
              <VisibleText text={agent.name} />
            </span>
          )}
          <time dateTime={at}>{whenWords(at, now)}</time>
        </span>
      </span>
      {status}
    </>
  )
  return action ? (
    <Button variant="ghost" className="agents-home-schedule-row" onClick={action}>
      {content}
    </Button>
  ) : (
    <div className="agents-home-schedule-row">{content}</div>
  )
}

/** The same snapshot decides what the overview shows and where the first Agent can be created. */
export function agentsHomeData({ snapshot, stopping }: Pick<ShellState, 'snapshot' | 'stopping'>) {
  const { attention } = agentsOverview(snapshot.tasks, stopping)
  const { results, upcoming } = scheduleOverview(snapshot.automations, attention)
  const empty =
    attention.length || results.length || upcoming.length
      ? null
      : snapshot.customAgents === undefined
        ? 'loading'
        : snapshot.customAgents.length === 0
          ? 'no-agents'
          : 'no-activity'
  return { attention, results, upcoming, empty }
}

/** The wide overview leads with decisions, followed by settled schedule runs and upcoming times from the Host. */
export function AgentsHome({
  shell,
  data: { attention, results, upcoming, empty },
  emptyInOverview,
}: {
  shell: ShellState
  data: ReturnType<typeof agentsHomeData>
  emptyInOverview: boolean
}) {
  const { snapshot, connection, now } = shell
  const offline = connection === 'offline'
  const locked = !readsAgents(snapshot)
  const canRun = shell.access.scopes.has('run')
  const rows = locked ? [] : shellRoster(shell)
  const [opened, setOpened] = useState<string>()
  const [expanded, setExpanded] = useState(false)
  if (locked)
    return (
      <div className="workbench-home agents-home">
        <LockedAgents />
      </div>
    )
  const activeDecision = attention.some(task => task.id === opened) ? opened : attention[0]?.id
  const agentOf = (automation: AutomationSummary) => rows.find(row => row.id === (automation.customAgentId ?? GENERAL_AGENT_ID))
  return (
    <div className="workbench-home agents-home">
      <div className="agents-home-content">
        <ConnectionBanners shell={shell} />
        {attention.length > 0 && (
          <section className="work-overview work-overview-group agents-home-waiting" data-group="attention" aria-label="等你处理">
            <header className="work-overview-group-heading">
              <Icon icon={WaitingGlyph} size={16} />
              <h3>等你处理</h3>
              <Count value={attention.length} />
            </header>
            <ul className="work-overview-list">
              {(expanded ? attention : attention.slice(0, OVERVIEW_ROWS)).map(task => (
                <li key={task.id}>
                  <WorkbenchDecision
                    task={task}
                    shell={shell}
                    person={personOf(rows, task)}
                    emphasis={task.id === activeDecision}
                    expanded={task.id === activeDecision}
                    onExpand={() => setOpened(task.id)}
                  />
                </li>
              ))}
            </ul>
            <More total={attention.length} open={expanded} onToggle={() => setExpanded(value => !value)} />
          </section>
        )}
        {results.length > 0 && (
          <section aria-label="最近定时结果">
            <header className="work-overview-group-heading">
              <Icon icon={OverviewGlyph} size={16} />
              <h3>最近定时结果</h3>
            </header>
            <ul className="work-overview-list">
              {results.slice(0, OVERVIEW_ROWS).map(({ automation, run }) => {
                const session = snapshot.tasks.find(task => task.id === run.sessionId && task.automationId === automation.id)
                const tone =
                  run.state === 'failed' ? 'failed' : run.state === 'unknown' ? 'warn' : run.state === 'completed' ? 'done' : 'neutral'
                return (
                  <li key={automation.id}>
                    <ScheduleRow
                      automation={automation}
                      agent={session ? (rowFor(rows, session) ?? agentOf(automation)) : agentOf(automation)}
                      at={run.at}
                      now={now}
                      {...(session ? { action: () => shell.choose(session.id, () => shell.setRoute({ entry: 'sessions' })) } : {})}
                      status={<StatusWord tone={tone}>{RUN_WORDS[run.state]}</StatusWord>}
                    />
                  </li>
                )
              })}
            </ul>
          </section>
        )}
        {upcoming.length > 0 && (
          <section aria-label="下次运行">
            <header className="work-overview-group-heading">
              <Icon icon={ScheduleGlyph} size={16} />
              <h3>下次运行</h3>
            </header>
            <ul className="work-overview-list">
              {upcoming.slice(0, OVERVIEW_ROWS).map(({ automation, at }) => {
                const agent = agentOf(automation)
                return (
                  <li key={automation.id}>
                    <ScheduleRow
                      automation={automation}
                      agent={agent}
                      at={at}
                      now={now}
                      {...(agent && addressable(agent) ? { action: () => shell.openMyAgent({ id: agent.id, tab: 'schedules' }) } : {})}
                    />
                  </li>
                )
              })}
            </ul>
          </section>
        )}
        {empty !== null
          && (empty === 'loading' ? (
            <ul className="work-overview-list agents-home-loading" aria-busy="true" aria-label="正在读取 Agent">
              {[0, 1, 2].map(row => (
                <li key={row}>
                  <Skeleton width={36} height={36} />
                  <Skeleton width="40%" height={16} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              className="agents-home-empty"
              title={
                <>
                  <Icon icon={empty === 'no-agents' ? AgentsGlyph : WaitingGlyph} size={24} />
                  <span>{empty === 'no-agents' ? '还没有自己的 Agent' : '没有待处理事项'}</span>
                </>
              }
              action={
                emptyInOverview
                && canRun && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={PlusGlyph}
                    data-space-primary=""
                    disabled={offline}
                    tooltip={offline ? DEVICE_OFFLINE : undefined}
                    onClick={() => shell.openMyAgent({ id: 'new' })}>
                    新建 Agent
                  </Button>
                )
              }
            />
          ))}
      </div>
    </div>
  )
}

/**
 * A phone's root page leads with what waits for you: the first card open, the rest as rows that open their topic, and past
 * the first few 「还有 N 件」 as on the wide 总览. Nothing while nothing waits.
 */
export function WaitingCards({ shell }: { shell: ShellState }) {
  const rows = shellRoster(shell)
  const { attention } = agentsOverview(shell.snapshot.tasks, shell.stopping)
  const [all, setAll] = useState(false)
  if (attention.length === 0) return null
  return (
    <section className="work-overview agents-phone-waiting" aria-label="等你处理">
      <ul className="work-overview-list">
        {(all ? attention : attention.slice(0, OVERVIEW_ROWS)).map((task, index) => (
          <li key={task.id}>
            <WorkbenchDecision
              task={task}
              shell={shell}
              person={personOf(rows, task)}
              emphasis={index === 0}
              expanded={index === 0}
              onExpand={() => {
                shell.choose(task.id)
                shell.setRoute({ entry: 'sessions' })
              }}
            />
          </li>
        ))}
      </ul>
      <More
        total={attention.length}
        open={all}
        onToggle={() => {
          setAll(value => !value)
        }}
      />
    </section>
  )
}
