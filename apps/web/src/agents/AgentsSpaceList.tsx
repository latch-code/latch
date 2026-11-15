import type { CustomAgentSummary, TaskSummary } from '@latch/protocol'
import { ICON_STROKE, Icon, StatusGlyph, AlertGlyph, ArchiveGlyph, BlockedGlyph, PlusGlyph, RunningGlyph, WaitingGlyph } from '@latch/ui'
import { useLastConfirmed } from '../components/SessionStatus.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { startBlock } from '../composerChoice.ts'
import { relativeTime } from '../format.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'
import type { AvatarState } from './avatarFace.ts'
import { ownerName, topicOwner } from './chat.ts'
import { generalChoice, readsAgents } from './model.ts'
import { LockedAgents } from './parts.tsx'
import { queueOrder, rosterRows, type RosterRow, type RosterState } from './roster.ts'

/** The roster as the shell's snapshot gives it: your Agents, 通用 where this device reads Agents, and deleted ones with topics. */
export function shellRoster(shell: Pick<ShellState, 'snapshot' | 'catalog'>): RosterRow[] {
  const general = readsAgents(shell.snapshot)
  const blocked = general ? startBlock(shell.snapshot, generalChoice(shell.catalog ?? undefined)) : null
  return rosterRows(shell.snapshot, { general, generalBlocked: blocked?.message })
}

/** The Agent in view: the open topic's, or the one whose new topic is open. */
export function currentAgent(shell: Pick<ShellState, 'route' | 'snapshot' | 'selectedId'>): string | undefined {
  const { route, snapshot, selectedId } = shell
  if (route.entry === 'agents') return route.myAgent && route.myAgent.id !== 'new' ? route.myAgent.id : undefined
  if (route.entry !== 'sessions' || route.overview || route.allSessions) return undefined
  return topicOwner(snapshot.tasks.find(task => task.id === selectedId))
}

/** A face's state from a row's: an Agent that cannot start rests; with the connection down nothing live is drawn. */
export function faceState(row: Pick<RosterRow, 'state' | 'unavailable'>, frozen: boolean): AvatarState {
  if (frozen && (row.state === 'waiting' || row.state === 'running')) return 'idle'
  if (row.state === 'idle' && row.unavailable) return 'resting'
  return row.state
}

const STATE_LABEL: Record<Exclude<RosterState, 'idle'>, string> = { waiting: '等你点头', running: '在工作', failed: '失败' }

/**
 * The icon at a row's end: the amber flag while it waits for you, the running arc while it works, the alert when its
 * latest run failed, a quiet mark when it cannot start, nothing at rest. Frozen (the Mac is not reachable), the last
 * state stays, muted and still. The words are the row's accessible name and the header's, never drawn here.
 */
export function RosterMark({
  state,
  frozen,
  unavailable,
  words,
}: {
  state: RosterState
  frozen: boolean
  unavailable?: string | undefined
  /** What a screen reader and the tooltip say: the person's word where there is one. */
  words?: string | undefined
}) {
  if (state === 'idle') {
    if (!unavailable) return null
    return (
      <span className="agent-mark" data-tone="neutral" role="img" aria-label={`不可用：${unavailable}`} title={`不可用：${unavailable}`}>
        <Icon icon={BlockedGlyph} size={14} />
      </span>
    )
  }
  const label = frozen ? `上次状态：${words ?? STATE_LABEL[state]}` : (words ?? STATE_LABEL[state])
  return (
    <span className="agent-mark" data-tone={frozen ? 'neutral' : state} role="img" aria-label={label} title={label}>
      <StatusGlyph running={state === 'running' && !frozen} state={frozen ? `frozen:${state}` : state} size={14}>
        <Icon icon={state === 'waiting' ? WaitingGlyph : state === 'failed' ? AlertGlyph : RunningGlyph} size={14} />
      </StatusGlyph>
    </span>
  )
}

function openRow(shell: ShellState, row: RosterRow) {
  if (row.gone || row.confirming) {
    const topic = row.topics[0]
    if (topic) shell.choose(topic.id, () => shell.setRoute({ entry: 'sessions' }))
    return
  }
  shell.openMyAgent({ id: row.id })
}

function Roster({ shell, rows, frozen }: { shell: ShellState; rows: RosterRow[]; frozen: boolean }) {
  const current = currentAgent(shell)
  return (
    <ul className="agent-roster" aria-label="我的 Agent">
      {rows.map(row => (
        <li key={row.id}>
          <button
            type="button"
            className="space-agent"
            data-agent-id={row.id}
            data-gone={row.gone || row.confirming ? '' : undefined}
            data-unavailable={row.unavailable && row.state === 'idle' ? '' : undefined}
            aria-current={row.id === current ? 'page' : undefined}
            onClick={() => openRow(shell, row)}>
            <AgentAvatar avatar={row.avatar} size={22} state={faceState(row, frozen)} />
            <span className="space-agent-name">
              <VisibleText text={row.name} />
            </span>
            <RosterMark state={row.state} frozen={frozen} unavailable={row.unavailable} words={row.word?.words} />
          </button>
        </li>
      ))}
    </ul>
  )
}

/** A person's second line in the queue: 等你点头 in amber, what it is doing in blue, else a quiet word or when it was last heard from. */
function PersonLine({ row, frozen, now }: { row: RosterRow; frozen: boolean; now: number }) {
  if ((row.state === 'waiting' || row.state === 'running') && row.word) {
    return (
      <span className="agent-person-state" data-tone={frozen ? 'neutral' : row.state}>
        <StatusGlyph running={row.state === 'running' && !frozen} state={frozen ? `frozen:${row.state}` : row.state}>
          <Icon icon={row.state === 'waiting' ? WaitingGlyph : RunningGlyph} size={12} />
        </StatusGlyph>
        <span>{frozen ? `上次状态：${row.word.words}` : row.word.words}</span>
      </span>
    )
  }
  if (row.state === 'failed')
    return (
      <span className="agent-person-state" data-tone="failed">
        <Icon icon={AlertGlyph} size={12} />
        <span>失败</span>
      </span>
    )
  if (row.gone) return <span className="agent-person-state">已删除</span>
  if (row.unavailable)
    return (
      <span className="agent-person-state" title={row.unavailable}>
        <Icon icon={BlockedGlyph} size={12} />
        <span>不可用</span>
      </span>
    )
  if (!row.updatedAt) return null
  return (
    <time className="agent-person-state" dateTime={row.updatedAt}>
      {relativeTime(row.updatedAt, new Date(now))}
    </time>
  )
}

/**
 * The 顶栏 layout's queue of people: who waits for you first, then who works, then whoever was last heard from. Each row
 * is a 32px face, the name, and on the second line the state in a person's words.
 */
function Queue({ shell, rows, frozen }: { shell: ShellState; rows: RosterRow[]; frozen: boolean }) {
  const current = currentAgent(shell)
  return (
    <ul className="agent-queue" aria-label="我的 Agent">
      {queueOrder(rows).map(row => (
        <li key={row.id}>
          <button
            type="button"
            className="agent-person"
            data-agent-id={row.id}
            data-gone={row.gone ? '' : undefined}
            aria-current={row.id === current ? 'page' : undefined}
            onClick={() => {
              openRow(shell, row)
            }}>
            <AgentAvatar avatar={row.avatar} size={32} state={faceState(row, frozen)} />
            <span className="agent-person-text">
              <span className="agent-person-name">
                <VisibleText text={row.name} />
              </span>
              <PersonLine row={row} frozen={frozen} now={shell.now} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * 我的 Agent's people, wherever the shell draws them (the sidebar, 我的 Agent's own pane, a phone's root page): the 侧栏
 * layout's roster or the 顶栏 layout's queue. `rail` is the 顶栏
 * layout's own column, which has no nav rows above it and so leads with 新建 Agent. Drawn from the snapshot's summaries,
 * so it is the same wherever it stands.
 */
export function AgentsSpaceList({ shell, rail = false }: { shell: ShellState; rail?: boolean }) {
  const { snapshot, connection, route } = shell
  const frozen = useLastConfirmed(connection, snapshot) !== null
  const locked = !readsAgents(snapshot)
  const queue = shell.preferences.workbenchLayout === 'triage'
  const rows = locked ? [] : shellRoster(shell)
  const own = rows.filter(row => !row.gone && !row.confirming && row.avatar !== 'general')
  const canRun = shell.access.scopes.has('run') && !locked
  const offline = connection === 'offline'
  const archived = snapshot.tasks.filter(task => task.archived && topicOwner(task)).length
  return (
    <nav className="space-list" aria-label="我的 Agent" data-people={queue ? 'queue' : 'roster'}>
      {rail && canRun && (
        <button
          type="button"
          className="agent-queue-new"
          aria-current={route.entry === 'agents' && route.myAgent?.id === 'new' ? 'page' : undefined}
          aria-disabled={offline || undefined}
          title={offline ? 'Mac 不在线' : undefined}
          onClick={() => {
            if (!offline) shell.openMyAgent({ id: 'new' })
          }}>
          <PlusGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
          <span>新建 Agent</span>
        </button>
      )}
      <section className="space-group" aria-label="Agent">
        {!queue && (
          <h2 className="space-head">
            <span>我的 Agent</span>
          </h2>
        )}
        {locked ? (
          <LockedAgents />
        ) : (
          <>
            {queue ? <Queue shell={shell} rows={rows} frozen={frozen} /> : <Roster shell={shell} rows={rows} frozen={frozen} />}
            {snapshot.customAgents === undefined ? (
              <p className="space-quiet" role="status">
                正在确认上一项修改
              </p>
            ) : (
              own.length === 0 && <p className="space-quiet">还没有自己的 Agent</p>
            )}
          </>
        )}
      </section>
      {!locked && archived > 0 && (
        <button
          type="button"
          className="archived-row"
          aria-label={`已归档的话题（${archived}）`}
          onClick={() => {
            shell.openAgentTopics(true)
          }}>
          <span className="sidebar-row-icon">
            <ArchiveGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          </span>
          <span>已归档</span>
          <span className="archived-count">{archived}</span>
        </button>
      )}
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
