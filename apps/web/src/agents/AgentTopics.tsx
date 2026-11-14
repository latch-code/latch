import type { TaskSummary } from '@latch/protocol'
import { ArchiveGlyph, Button, ChevronLeftGlyph, EmptyState, IconButton, MoreGlyph, StatusWord } from '@latch/ui'
import { useLastConfirmed } from '../components/SessionStatus.tsx'
import { Menu } from '../components/overlays.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { relativeTime } from '../format.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'
import { RosterMark, shellRoster } from './AgentsSpaceList.tsx'
import { agentTopics, topicWords } from './chat.ts'
import { readsAgents } from './model.ts'
import { LockedAgents } from './parts.tsx'
import { topicState, type RosterRow } from './roster.ts'

const TONE = { waiting: 'waiting', running: 'running', failed: 'failed', idle: 'neutral' } as const

/** One topic: its state mark, the title, its state in the helper's words, when it last changed, and its own menu. */
function TopicRow({ shell, task, frozen, asking }: { shell: ShellState; task: TaskSummary; frozen: boolean; asking: ReadonlySet<string> }) {
  const state = topicState(task, asking)
  const words = topicWords(task, frozen)
  const title = task.title || '未命名会话'
  return (
    <div className="workbench-session-entry">
      <button
        type="button"
        className="workbench-session-row agent-topic-row"
        data-task-id={task.id}
        aria-current={shell.selectedId === task.id ? 'page' : undefined}
        onClick={() => {
          if (task.id !== shell.selectedId) shell.choose(task.id)
          shell.setRoute({ entry: 'sessions' })
        }}>
        <span className="agent-topic-mark">
          <RosterMark state={state} frozen={frozen} />
        </span>
        <span className="workbench-session-title">
          <VisibleText text={title} />
        </span>
        {words ? <StatusWord tone={frozen ? 'neutral' : TONE[state]}>{words}</StatusWord> : <span />}
        <time dateTime={task.updatedAt}>{relativeTime(task.updatedAt, new Date(shell.now))}</time>
      </button>
      <Menu
        label={`话题操作：${title}`}
        placement="bottom-end"
        sections={shell.sessionMenu(task)}
        trigger={props => <IconButton {...props} size="sm" label={`更多操作：${title}`} icon={MoreGlyph} />}
      />
    </div>
  )
}

/**
 * 全部话题: every topic of 我的 Agent grouped under its Agent (the queue's rows hold only people), newest first, with the
 * archived ones behind 已归档. A deleted Agent's topics stay, under 「已删除的 Agent」.
 */
export function AgentTopics({ shell, onBack }: { shell: ShellState; onBack: () => void }) {
  const { snapshot, phone, connection, agentsFilter, setAgentsFilter } = shell
  const frozen = useLastConfirmed(connection, snapshot) !== null
  const archived = agentsFilter === 'archived'
  if (!readsAgents(snapshot))
    return (
      <section className="workbench-sessions agent-topics" aria-label="全部话题">
        <LockedAgents />
      </section>
    )
  const asking = new Set(snapshot.approvals.map(approval => approval.sessionId))
  const groups: Array<{ row: RosterRow; topics: TaskSummary[] }> = shellRoster(shell)
    .map(row => ({ row, topics: archived ? agentTopics(snapshot.tasks, row.id).archived : row.topics }))
    .filter(group => group.topics.length > 0)
  // An Agent deleted after its last open topic was archived has no roster row: its archived topics are still listed.
  const listed = new Set(groups.flatMap(group => group.topics.map(task => task.id)))
  const orphans = archived ? snapshot.tasks.filter(task => task.archived && (task.agent || task.generalChat) && !listed.has(task.id)) : []
  return (
    <section className="workbench-sessions agent-topics" aria-label="全部话题">
      <header className="workbench-sessions-head">
        {phone && <IconButton label="返回" icon={ChevronLeftGlyph} onClick={onBack} />}
        <h1>全部话题</h1>
        <div className="workbench-sessions-filters">
          <Button
            variant="ghost"
            icon={ArchiveGlyph}
            aria-pressed={archived}
            onClick={() => {
              setAgentsFilter(archived ? 'all' : 'archived')
            }}>
            已归档
          </Button>
        </div>
      </header>
      {groups.length === 0 && orphans.length === 0 && <EmptyState title={archived ? '没有已归档的话题' : '还没有话题'} />}
      {groups.map(({ row, topics }) => (
        <section key={row.id} className="workbench-session-group" aria-label={row.name}>
          <header className="workbench-session-group-head">
            <AgentAvatar avatar={row.avatar} size={22} />
            <h2>
              <VisibleText text={row.name} />
            </h2>
            <span className="workbench-session-count">{topics.length}</span>
          </header>
          {topics.map(task => (
            <TopicRow key={task.id} shell={shell} task={task} frozen={frozen} asking={asking} />
          ))}
        </section>
      ))}
      {orphans.length > 0 && (
        <section className="workbench-session-group" aria-label="已删除的 Agent">
          <header className="workbench-session-group-head">
            <AgentAvatar avatar="general" size={22} />
            <h2>已删除的 Agent</h2>
            <span className="workbench-session-count">{orphans.length}</span>
          </header>
          {orphans.map(task => (
            <TopicRow key={task.id} shell={shell} task={task} frozen={frozen} asking={asking} />
          ))}
        </section>
      )}
    </section>
  )
}
