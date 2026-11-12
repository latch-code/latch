import type { ReactNode } from 'react'

import { GENERAL_AGENT_ID, type CustomAgentSummary, type TaskSummary } from '@latch/protocol'
import { ICON_STROKE, StatusWord, ArchiveGlyph, ChevronLeftGlyph, PlusGlyph } from '@latch/ui'
import { SessionStatus, useLastConfirmed } from '../components/SessionStatus.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { relativeTime } from '../format.ts'
import { delegationRows, rowStatus, RECENT_DELEGATIONS } from '../sessions.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'
import { agentActivity, GENERAL_NAME, readsAgents } from './model.ts'
import { ownerName, topicOwner } from './chat.ts'
import { ActivityWord, LockedAgents } from './parts.tsx'

/**
 * The word beside an Agent in the sidebar: 等你处理, 运行中 or 失败, else 不可用 while it cannot start. With the connection
 * down nothing live is said, as Code's rows say nothing live then.
 */
function AgentWord({ shell, agent, frozen }: { shell: ShellState; agent: CustomAgentSummary; frozen: boolean }) {
  const state = agentActivity(shell.snapshot, agent)
  if (frozen && (state === 'running' || state === 'waiting')) return null
  if (state === 'resting')
    return (
      <StatusWord tone="neutral" className="agent-activity" title={agent.unavailableReason}>
        不可用
      </StatusWord>
    )
  return <ActivityWord state={state} />
}

/**
 * 我的 Agent's list in the sidebar: 通用 (built in), your Agents with their faces and what they are doing (a row opens its
 * current topic), 新建 Agent, then 最近对话, the topics of all of them, newest first. The Agent in view and the open topic
 * are selected. Drawn from the snapshot's summaries, so it is the same wherever it stands.
 */
export function AgentsSpaceList({ shell }: { shell: ShellState }) {
  const { snapshot, route, selectedId, connection, now } = shell
  const frozen = useLastConfirmed(connection, snapshot)
  const locked = !readsAgents(snapshot)
  const agents = snapshot.customAgents
  const canRun = shell.access.scopes.has('run')
  const offline = connection === 'offline'
  const open = route.entry === 'sessions' ? snapshot.tasks.find(task => task.id === selectedId) : undefined
  const currentAgent = route.entry === 'agents' ? route.myAgent?.id : route.entry === 'sessions' ? topicOwner(open) : undefined
  const home = route.entry === 'agents' && route.myAgent === undefined
  const agentRow = (id: string, name: string, face: ReactNode, end: ReactNode) => (
    <li key={id}>
      <button
        type="button"
        className="space-agent"
        aria-current={currentAgent === id ? 'page' : undefined}
        onClick={() => {
          shell.openMyAgent({ id })
        }}>
        {face}
        <span className="space-agent-name">{name}</span>
        {end}
      </button>
    </li>
  )
  return (
    <nav className="space-list" aria-label="我的 Agent">
      <section className="space-group" aria-label="Agent">
        <h2 className="space-head">
          <button
            type="button"
            aria-current={home ? 'page' : undefined}
            onClick={() => {
              shell.openMyAgent()
            }}>
            我的 Agent
          </button>
        </h2>
        {locked ? (
          <LockedAgents />
        ) : (
          <ul>
            {agentRow(
              GENERAL_AGENT_ID,
              GENERAL_NAME,
              <AgentAvatar avatar="general" size={24} />,
              <span className="agent-builtin">内置</span>,
            )}
            {agents === undefined ? (
              <li className="space-quiet" role="status">
                正在确认上一项修改
              </li>
            ) : (
              agents.map(agent =>
                agentRow(
                  agent.id,
                  agent.name,
                  <AgentAvatar avatar={agent.avatar} size={24} state={agentActivity(snapshot, agent)} />,
                  <AgentWord shell={shell} agent={agent} frozen={frozen !== null} />,
                ),
              )
            )}
            {canRun && agents !== undefined && (
              <li>
                <button
                  type="button"
                  className="space-agent space-new"
                  aria-current={route.entry === 'agents' && route.myAgent?.id === 'new' ? 'page' : undefined}
                  aria-disabled={offline || undefined}
                  title={offline ? 'Mac 不在线' : undefined}
                  onClick={() => {
                    if (!offline) shell.openMyAgent({ id: 'new' })
                  }}>
                  <span className="space-new-glyph" aria-hidden="true">
                    <PlusGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} />
                  </span>
                  <span className="space-agent-name">新建 Agent</span>
                </button>
              </li>
            )}
          </ul>
        )}
      </section>
      {!locked && <Delegations shell={shell} frozen={frozen} />}
    </nav>
  )
}

/** A conversation's Agent by name: 通用, or one of yours; one deleted since keeps its sessions, under 「已删除的 Agent」. */
export function delegationAgent(
  agents: readonly CustomAgentSummary[] | undefined,
  task: Pick<TaskSummary, 'agent' | 'generalChat'>,
): string {
  return ownerName(agents, topicOwner(task) ?? '')
}

/**
 * 最近对话, then a quiet 已归档 row, as Code's list has one: every delegation is reachable from exactly one of them. What
 * waits on you leads 最近委托 and is never cut by 全部. Under 已归档 the way back leads the archived ones. The sidebar and
 * a phone's 我的 Agent tab both draw it; the shell keeps which of them shows, so the keys step through the same rows.
 */
export function Delegations({ shell, frozen }: { shell: ShellState; frozen: string | null }) {
  const { snapshot, route, selectedId, now, agentsFilter, setAgentsFilter, agentsExpanded, setAgentsExpanded } = shell
  const archived = agentsFilter === 'archived'
  const { rows, total, archived: archivedCount } = delegationRows(snapshot.tasks, { filter: agentsFilter, expanded: agentsExpanded })
  if (!archived && total === 0 && archivedCount === 0) return null
  const list = (
    <ul>
      {rows.map(task => (
        <Delegation
          key={task.id}
          task={task}
          agent={delegationAgent(snapshot.customAgents, task)}
          selected={route.entry === 'sessions' && task.id === selectedId}
          stopping={shell.stopping.has(task.id)}
          frozen={frozen}
          now={now}
          onOpen={() => {
            shell.choose(task.id)
          }}
        />
      ))}
    </ul>
  )
  if (archived)
    return (
      <section className="space-group" aria-label="已归档">
        <button
          type="button"
          className="archived-back"
          onClick={() => {
            setAgentsFilter('all')
          }}>
          <ChevronLeftGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          <span>已归档</span>
          <span className="archived-count">{archivedCount}</span>
        </button>
        {rows.length === 0 ? <p className="space-quiet">没有已归档的对话</p> : list}
      </section>
    )
  return (
    <>
      {total > 0 && (
        <section className="space-group" aria-label="最近对话">
          <h2 className="space-head">
            <span>最近对话</span>
          </h2>
          {list}
          {total > RECENT_DELEGATIONS && (rows.length < total || agentsExpanded) && (
            <button
              type="button"
              className="space-more"
              aria-expanded={agentsExpanded}
              onClick={() => {
                setAgentsExpanded(!agentsExpanded)
              }}>
              {agentsExpanded ? '收起' : `全部 ${total}`}
            </button>
          )}
        </section>
      )}
      {archivedCount > 0 && (
        <button
          type="button"
          className="archived-row"
          aria-label={`已归档的对话（${archivedCount}）`}
          onClick={() => {
            setAgentsFilter('archived')
          }}>
          <span className="sidebar-row-icon">
            <ArchiveGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          </span>
          <span>已归档</span>
          <span className="archived-count">{archivedCount}</span>
        </button>
      )}
    </>
  )
}

/** One delegation: its title, its Agent, and the time or what it is doing, in the words of Code's rows. */
function Delegation({
  task,
  agent,
  selected,
  stopping,
  frozen,
  now,
  onOpen,
}: {
  task: TaskSummary
  agent: string
  selected: boolean
  stopping: boolean
  frozen: string | null
  now: number
  onOpen: () => void
}) {
  const status = rowStatus(task, { stopping, frozen: frozen !== null })
  const strong = status.kind === 'waiting' || status.kind === 'silent' || status.kind === 'failed'
  return (
    <li>
      <button
        type="button"
        className={`space-delegation ${strong ? 'is-strong' : ''}`}
        data-task-id={task.id}
        aria-current={selected ? 'page' : undefined}
        onClick={onOpen}>
        <span className="space-delegation-title">{task.title || '未命名会话'}</span>
        <span className="space-delegation-agent">
          <VisibleText text={agent} />
        </span>
        <SessionStatus
          className="space-delegation-status"
          status={status}
          live={task.live}
          inWaitingShelf={false}
          time={relativeTime(task.updatedAt, new Date(now))}
          dateTime={task.updatedAt}
        />
      </button>
    </li>
  )
}
