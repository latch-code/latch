import { useState, type ReactNode } from 'react'

import { GENERAL_AGENT_ID, type CustomAgentSummary, type TaskSummary } from '@latch/protocol'
import {
  Button,
  ICON_STROKE,
  Icon,
  StatusGlyph,
  AlertGlyph,
  ArchiveGlyph,
  BlockedGlyph,
  ConfirmDialog,
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
import { MessageError } from '../core/api.ts'
import { relativeTime } from '../format.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { WriteNotice } from './AgentForm.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'
import type { AvatarState } from './avatarFace.ts'
import { ownerName, topicOwner } from './chat.ts'
import { generalChoice, readsAgents } from './model.ts'
import type { AutomationSummary } from '@latch/protocol'
import { LockedAgents } from './parts.tsx'
import { rosterRows, waitingTopic, type RosterRow, type RosterState } from './roster.ts'
import { whenWords } from './scheduleModel.ts'

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

type AgentRowMenu = (row: RosterRow) => ReactNode

/**
 * The second line of a helper on a page of its own: what it is doing while it works or waits, else what it last worked
 * on, else its role. Only the Host's summaries; nothing is guessed.
 */
export function helperLine(row: Pick<RosterRow, 'state' | 'word' | 'unavailable' | 'topics' | 'duty'>, frozen: boolean): string {
  if (row.state !== 'idle') {
    const words = row.word?.words ?? STATE_LABEL[row.state]
    return frozen ? `上次状态：${words}` : words
  }
  if (row.unavailable) return '现在不能开始'
  const topic = row.topics[0]
  if (topic) return topic.title || '未命名会话'
  return row.duty || '还没聊过'
}

/** The next time one of this helper's schedules that is on will run, when any will. */
export function nextRun(automations: readonly AutomationSummary[] | undefined, owner: string): string | undefined {
  return (automations ?? [])
    .filter(item => item.enabled && item.nextRunAt && (owner === GENERAL_AGENT_ID ? !item.customAgentId : item.customAgentId === owner))
    .map(item => item.nextRunAt!)
    .toSorted()[0]
}

/**
 * A helper row's one action on a page of its own: what waits for the person opens the topic that waits; otherwise its
 * chat. The row itself opens the chat too; this says what the click is for.
 */
function RowAction({ shell, row, frozen }: { shell: ShellState; row: RosterRow; frozen: boolean }) {
  if (row.gone || row.confirming) return null
  const waiting = !frozen && row.state === 'waiting' ? waitingTopic(row, shell.stopping) : undefined
  return (
    <Button
      size="sm"
      variant={waiting ? 'secondary' : 'ghost'}
      className="agent-row-action"
      onClick={() => {
        if (waiting) shell.choose(waiting.id, () => shell.setRoute({ entry: 'sessions' }))
        else openRow(shell, row)
      }}>
      {waiting ? '去处理' : '聊天'}
    </Button>
  )
}

function Roster({
  shell,
  rows,
  frozen,
  menu,
  page = false,
  label,
}: {
  shell: ShellState
  rows: RosterRow[]
  frozen: boolean
  menu: AgentRowMenu
  label: string
  /** A page of its own (the 总览, a phone's root): larger faces, what each is doing or last did, and when. */
  page?: boolean
}) {
  const current = page ? undefined : currentAgent(shell)
  return (
    <ul className="agent-roster" aria-label={label} data-page={page ? '' : undefined}>
      {rows.map(row => (
        <li key={row.id} className="agent-row">
          <button
            type="button"
            className="space-agent"
            // The roster's rows are the Agents' handles; a second list beside it (the 总览's) names its own apart.
            {...(label === '我的 Agent' ? { 'data-agent-id': row.id } : { 'data-helper-id': row.id })}
            data-gone={row.gone || row.confirming ? '' : undefined}
            data-unavailable={row.unavailable && row.state === 'idle' ? '' : undefined}
            data-state={page ? row.state : undefined}
            aria-current={row.id === current ? 'page' : undefined}
            onClick={() => openRow(shell, row)}>
            <AgentAvatar avatar={row.avatar} size={page ? 36 : 22} state={faceState(row, frozen)} />
            {page ? (
              <span className="space-agent-text">
                <span className="space-agent-name">
                  <VisibleText text={row.name} />
                </span>
                <span className="space-agent-line">
                  <VisibleText text={helperLine(row, frozen)} />
                </span>
                {nextRun(shell.snapshot.automations, row.id) && (
                  <span className="space-agent-next">下次 {whenWords(nextRun(shell.snapshot.automations, row.id)!, shell.now)}</span>
                )}
              </span>
            ) : (
              <span className="space-agent-name">
                <VisibleText text={row.name} />
              </span>
            )}
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
      ))}
    </ul>
  )
}

/**
 * 我的 Agent's people, wherever the shell draws them (the sidebar, 我的 Agent's own pane, a phone's root page): the
 * roster. Drawn from the snapshot's summaries, so it is the same wherever it stands.
 */
export function AgentsSpaceList({
  shell,
  page = false,
  label = '我的 Agent',
}: {
  shell: ShellState
  page?: boolean
  /** The list's name; the 总览 beside the sidebar's roster names its own apart. */
  label?: string
}) {
  const { snapshot, connection } = shell
  const frozen = useLastConfirmed(connection, snapshot) !== null
  const locked = !readsAgents(snapshot)
  const rows = locked ? [] : shellRoster(shell)
  const own = rows.filter(row => !row.gone && !row.confirming && row.avatar !== 'general')
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
        label={`${row.name} 的操作`}
        placement="bottom-end"
        context={rowOf('.agent-row')}
        sections={[
          {
            id: 'agent',
            items: [
              {
                id: 'settings',
                label: '设置',
                leading: <Icon icon={SettingsGlyph} size={14} />,
                onSelect: () => shell.openMyAgent({ id: row.id, tab: 'settings' }),
              },
              ...(row.id !== GENERAL_AGENT_ID && canDelete
                ? [
                    {
                      id: 'delete',
                      label: '删除 Agent',
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
        trigger={props => <IconButton {...props} className="agent-row-more" icon={MoreGlyph} label={`更多操作：${row.name}`} size="xs" />}
      />
    )
  }
  return (
    <nav className="space-list" aria-label={label} data-people="roster" data-page={page ? '' : undefined}>
      <section className="space-group" aria-label="Agent">
        {!page && (
          <h2 className="space-head">
            <span>我的 Agent</span>
          </h2>
        )}
        {locked ? (
          <LockedAgents />
        ) : (
          <>
            <Roster shell={shell} rows={rows} frozen={frozen} menu={menu} page={page} label={label} />
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
      {canDelete && writes.held && !removing && (
        <WriteNotice state={writes.state} onRetry={() => void writes.retry()} onAbandon={writes.clear} />
      )}
      {canDelete && removing && (
        <ConfirmDialog
          title={`删除「${removing.name}」？`}
          message="它的记忆会删除，聊天记录和文件夹会保留。"
          danger
          confirmLabel={writes.held ? '重试同一请求' : '删除'}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            const done = writes.held
              ? await writes.retry()
              : await writes.run(`agent:${removing.id}`, `custom-agents/${encodeURIComponent(removing.id)}`, 'DELETE', {})
            if (done === undefined) throw new MessageError('没有收到删除确认，请重试或返回列表查看。')
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
