import { useState, type ReactNode } from 'react'

import { GENERAL_AGENT_ID, type AutomationSummary, type CustomAgentSummary, type TaskSummary } from '@latch/protocol'
import {
  Button,
  ICON_STROKE,
  Icon,
  StatusGlyph,
  AlertGlyph,
  ArchiveGlyph,
  BlockedGlyph,
  IconButton,
  MoreGlyph,
  SettingsGlyph,
  TrashGlyph,
  RunningGlyph,
  WaitingGlyph,
} from '@latch/ui'
import { useLastConfirmed } from '../components/SessionStatus.tsx'
import { Menu, rowOf } from '../components/overlays.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { startBlock } from '../composerChoice.ts'
import { defineCopy, formatNumber } from '../core/i18n.ts'
import { relativeTime } from '../format.ts'
import { AgentDeleteDialog } from './AgentDeleteDialog.tsx'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { WriteNotice } from './AgentForm.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'
import type { AvatarState } from './avatarFace.ts'
import { ownerName, topicOwner } from './chat.ts'
import { generalChoice, readsAgents } from './model.ts'
import { LockedAgents } from './parts.tsx'
import { rosterRows, waitingTopic, type RosterRow, type RosterState } from './roster.ts'
import { whenWords } from './scheduleModel.ts'
import { AGENT_SPACE_COPY } from './spaceCopy.ts'

const COPY = defineCopy(
  {
    state: { waiting: '等你点头', running: '在工作', failed: '失败' },
    unavailable: (message: string) => `不可用：${message}`,
    previous: (state: string) => `上次状态：${state}`,
    untitled: '未命名会话',
    noChats: '还没聊过',
    act: '去处理',
    next: (time: string) => `下次 ${time}`,
    actions: (name: string) => `${name} 的操作`,
    settings: '设置',
    deleteAgent: '删除 Agent',
    moreActions: (name: string) => `更多操作：${name}`,
    archivedCount: (count: number) => `已归档的话题（${formatNumber(count)}）`,
    archived: '已归档',
  },
  {
    state: { waiting: 'Waiting for you', running: 'Working', failed: 'Failed' },
    unavailable: (message: string) => `Unavailable. ${message}`,
    previous: (state: string) => `Last status: ${state}`,
    untitled: 'Untitled session',
    noChats: 'No chats yet',
    act: 'Review',
    next: (time: string) => `Next run ${time}`,
    actions: (name: string) => `Actions for ${name}`,
    settings: 'Settings',
    deleteAgent: 'Delete Agent',
    moreActions: (name: string) => `More actions for ${name}`,
    archivedCount: (count: number) => `Archived topics (${formatNumber(count)})`,
    archived: 'Archived',
  },
)

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
  if (route.entry !== 'sessions' || route.start) return undefined
  return topicOwner(snapshot.tasks.find(task => task.id === selectedId))
}

/** A face's state from a row's: an Agent that cannot start rests; with the connection down nothing live is drawn. */
export function faceState(row: Pick<RosterRow, 'state' | 'unavailable'>, frozen: boolean): AvatarState {
  if (frozen && (row.state === 'waiting' || row.state === 'running')) return 'idle'
  if (row.state === 'idle' && row.unavailable) return 'resting'
  return row.state
}

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
      <span
        className="agent-mark"
        data-tone="neutral"
        role="img"
        aria-label={COPY.unavailable(unavailable)}
        title={COPY.unavailable(unavailable)}>
        <Icon icon={BlockedGlyph} size={14} />
      </span>
    )
  }
  const word = words ?? COPY.state[state]
  const label = frozen ? COPY.previous(word) : word
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

type AgentRowMenu = (row: RosterRow) => ReactNode

/**
 * The second line of a helper on a page of its own: what it is doing while it works or waits, else what it last worked
 * on, else its role. Only the Host's summaries; nothing is guessed.
 */
export function helperLine(row: Pick<RosterRow, 'state' | 'word' | 'unavailable' | 'topics' | 'duty'>, frozen: boolean): string {
  if (row.state !== 'idle') {
    const words = row.word?.words ?? COPY.state[row.state]
    return frozen ? COPY.previous(words) : words
  }
  if (row.unavailable) return AGENT_SPACE_COPY.cannotStart
  const topic = row.topics[0]
  if (topic) return topic.title || COPY.untitled
  return row.duty || COPY.noChats
}

/** The next time one of this helper's schedules that is on will run, when any will. */
function nextRun(automations: readonly AutomationSummary[] | undefined, owner: string): string | undefined {
  return (automations ?? [])
    .filter(item => item.enabled && item.nextRunAt && (owner === GENERAL_AGENT_ID ? !item.customAgentId : item.customAgentId === owner))
    .map(item => item.nextRunAt!)
    .toSorted()[0]
}

/** The row itself opens the Agent's chat. A waiting run has its own destination. */
function RowAction({ shell, row, frozen }: { shell: ShellState; row: RosterRow; frozen: boolean }) {
  if (row.gone || row.confirming || frozen || row.state !== 'waiting') return null
  const waiting = waitingTopic(row, shell.stopping)
  if (!waiting) return null
  return (
    <Button
      size="sm"
      variant="secondary"
      className="agent-row-action"
      onClick={() => {
        shell.choose(waiting.id, () => shell.setRoute({ entry: 'sessions' }))
      }}>
      {COPY.act}
    </Button>
  )
}

function Roster({
  shell,
  rows,
  frozen,
  menu,
  resume,
  page = false,
}: {
  shell: ShellState
  rows: RosterRow[]
  frozen: boolean
  menu: AgentRowMenu
  resume?: TaskSummary | undefined
  /** A phone's root: larger faces, recent activity and the next scheduled run. */
  page?: boolean
}) {
  const current = page ? undefined : currentAgent(shell)
  const last = resume ? rows.find(row => row.id === topicOwner(resume)) : undefined
  const ordered = last ? [last, ...rows.filter(row => row !== last)] : rows
  return (
    <ul className="agent-roster" aria-label={AGENT_SPACE_COPY.myAgents} data-page={page ? '' : undefined}>
      {ordered.map(row => {
        const continuing = row === last ? resume : undefined
        const next = page ? nextRun(shell.snapshot.automations, row.id) : undefined
        return (
          <li key={row.id} className="agent-row">
            <button
              type="button"
              className="space-agent"
              data-agent-id={row.id}
              data-gone={row.gone || row.confirming ? '' : undefined}
              data-unavailable={row.unavailable && row.state === 'idle' ? '' : undefined}
              data-state={page && !frozen ? row.state : undefined}
              aria-current={row.id === current ? 'page' : undefined}
              onClick={() => {
                if (continuing && shell.delegation.pending?.customAgentId !== row.id) shell.choose(continuing.id)
                else openRow(shell, row)
              }}>
              <AgentAvatar avatar={row.avatar} size={page ? 36 : 22} state={faceState(row, frozen)} />
              {page ? (
                <span className="space-agent-text">
                  <span className="space-agent-name">
                    <VisibleText text={row.name} />
                  </span>
                  <span className="space-agent-meta">
                    <span className="space-agent-line">
                      <VisibleText text={continuing?.title || helperLine(row, frozen)} />
                    </span>
                    {next && (
                      <time className="space-agent-next" dateTime={next}>
                        {COPY.next(whenWords(next, shell.now))}
                      </time>
                    )}
                  </span>
                </span>
              ) : (
                <span className="space-agent-name">
                  <VisibleText text={row.name} />
                </span>
              )}
              {continuing && <span className="agents-home-link">{AGENT_SPACE_COPY.continueChat}</span>}
              {row.workComputer && <span className="agent-work-computer-label">{AGENT_SPACE_COPY.workComputer}</span>}
              {page && row.updatedAt && (
                <time className="space-agent-time" dateTime={row.updatedAt}>
                  {relativeTime(row.updatedAt, new Date(shell.now))}
                </time>
              )}
              <RosterMark state={row.state} frozen={frozen} unavailable={row.unavailable} words={row.word?.words} />
            </button>
            {page && <RowAction shell={shell} row={row} frozen={frozen} />}
            {menu(row)}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * 我的 Agent's people, wherever the shell draws them (the sidebar, 我的 Agent's own pane, a phone's root page): the
 * roster. Drawn from the snapshot's summaries, so it is the same wherever it stands.
 */
export function AgentsSpaceList({ shell, page = false, resume }: { shell: ShellState; page?: boolean; resume?: TaskSummary | undefined }) {
  const { snapshot, connection } = shell
  const frozen = useLastConfirmed(connection, snapshot) !== null
  const locked = !readsAgents(snapshot)
  const rows = locked ? [] : shellRoster(shell)
  const canRun = shell.access.scopes.has('run') && !locked
  const offline = connection === 'offline'
  const archived = snapshot.tasks.filter(task => task.archived && topicOwner(task)).length
  const [removal, setRemoving] = useState<Pick<RosterRow, 'id' | 'name'> | null>(null)
  const writes = shell.agentRemovals
  const canDelete = canRun && shell.access.scopes.has('view')
  const removing = removal && snapshot.customAgents?.every(agent => agent.id !== removal.id) !== true ? removal : null
  const menu: AgentRowMenu = row => {
    if (row.gone || row.confirming) return null
    return (
      <Menu
        label={COPY.actions(row.name)}
        placement="bottom-end"
        context={rowOf('.agent-row')}
        sections={[
          {
            id: 'agent',
            items: [
              {
                id: 'settings',
                label: COPY.settings,
                leading: <Icon icon={SettingsGlyph} size={14} />,
                onSelect: () => shell.openMyAgent({ id: row.id, tab: 'settings' }),
              },
              ...(row.id !== GENERAL_AGENT_ID && canDelete
                ? [
                    {
                      id: 'delete',
                      label: COPY.deleteAgent,
                      danger: true,
                      leading: <Icon icon={TrashGlyph} size={14} />,
                      disabled: offline || writes.held || writes.saving,
                      onSelect: () => {
                        writes.clear()
                        setRemoving(row)
                      },
                    },
                  ]
                : []),
            ],
          },
        ]}
        trigger={props => (
          <IconButton {...props} className="agent-row-more" icon={MoreGlyph} label={COPY.moreActions(row.name)} size="xs" />
        )}
      />
    )
  }
  return (
    <nav className="space-list" aria-label={AGENT_SPACE_COPY.myAgents} data-people="roster" data-page={page ? '' : undefined}>
      <section className="space-group" aria-label="Agent">
        {!page && (
          <h2 className="space-head">
            <span>{AGENT_SPACE_COPY.myAgents}</span>
          </h2>
        )}
        {locked ? (
          <LockedAgents />
        ) : (
          <>
            <Roster shell={shell} rows={rows} frozen={frozen} menu={menu} page={page} resume={resume} />
            {snapshot.customAgents === undefined && (
              <p className="space-quiet" role="status">
                {AGENT_SPACE_COPY.confirming}
              </p>
            )}
          </>
        )}
      </section>
      {!locked && archived > 0 && (
        <button
          type="button"
          className="archived-row"
          aria-label={COPY.archivedCount(archived)}
          onClick={() => {
            shell.openAgentTopics(true)
          }}>
          <span className="sidebar-row-icon">
            <ArchiveGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          </span>
          <span>{COPY.archived}</span>
          <span className="archived-count">{formatNumber(archived)}</span>
        </button>
      )}
      {canDelete && writes.held && !removing && (
        <WriteNotice state={writes.state} onRetry={() => void writes.retry()} onAbandon={writes.clear} />
      )}
      {canDelete && removing && (
        <AgentDeleteDialog
          agent={removing}
          writes={writes}
          onClose={() => setRemoving(null)}
          onDeleted={notice => {
            if (notice) shell.setToast({ text: notice, tone: 'error' })
          }}
        />
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
