import { memo, type ReactNode } from 'react'
import { GENERAL_AGENT_ID, escapeSecurityText, type TaskSummary, type WorkbenchDeliveryEntry } from '@latch/protocol'
import { FolderGlyph, IconButton, Icon, MoreGlyph, RunningEdge, ScheduleGlyph, StatusWord, type StatusTone } from '@latch/ui'
import { FolderGit2 } from 'lucide-react'
import { AgentAvatar } from '../agents/AgentAvatar.tsx'
import { MarkTile } from '../components/BrandTile.tsx'
import { Menu, rowOf, type MenuSection } from '../components/overlays.tsx'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { relativeTime } from '../format.ts'
import { projectOf, workStatus } from '../sessions.ts'
import { sessionSource } from '../sessionSource.ts'
import { deliveryCheckSummary } from '../shell/useWorkbenchEvidence.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { PRIORITY_LABELS, priorityOf, reasonWords, whoOf, WHO_CODE } from './model.ts'

const SOURCE_WORDS = { handoff: '交接自', fork: '分叉自', schedule: '定时' } as const

/** What the card's third line says, and in which tone: the Host's reason in 等你处理, the delivery facts in 可交付. */
export function cardState(
  task: TaskSummary,
  {
    connected,
    now,
    stopping,
    delivery,
    sharedFolder,
  }: { connected: boolean; now: number; stopping: boolean; delivery?: WorkbenchDeliveryEntry | undefined; sharedFolder: boolean },
): { tone: StatusTone; words: string } {
  const group = task.board?.group
  if (group === 'attention') {
    const reason = task.board?.reason
    if (!connected) return { tone: 'neutral', words: `上次状态：${reasonWords(task)}` }
    // A failed run is said in red whichever of its facts brought it here first.
    if (reason === 'failed' || (reason === 'unknown' && workStatus(task, { connected, now, stopping }).tone === 'failed'))
      return { tone: 'failed', words: workStatus(task, { connected, now, stopping }).words }
    if (reason === 'unknown') return { tone: 'warn', words: reasonWords(task) }
    // Silence counts its minutes from the run's last sign of life, as everywhere else.
    if (reason === 'silent') return { tone: 'waiting', words: workStatus(task, { connected, now, stopping }).words }
    return { tone: 'waiting', words: reasonWords(task) }
  }
  const status = workStatus(task, { connected, now, stopping })
  // A failed run the person has opened stays red here; only 等你处理 lets it go.
  if (status.tone === 'failed' || status.tone === 'running' || !connected) return { tone: status.tone, words: status.words }
  if (group === 'deliver') {
    const pr = delivery?.pr?.pr
    const checks = delivery ? deliveryCheckSummary(delivery) : undefined
    if (pr) return { tone: 'neutral', words: `PR #${pr.number}${checks ? ` · ${checks.text}` : ''}` }
    const state = delivery?.state
    const where = sharedFolder ? '这个目录有 ' : ''
    if (state?.files) return { tone: 'neutral', words: `${where}${state.files} 个文件未提交` }
    if (state?.ahead) return { tone: 'neutral', words: `${where}${state.ahead} 个提交未推送` }
    return { tone: 'neutral', words: '可交付' }
  }
  return { tone: status.tone === 'warn' ? 'warn' : 'neutral', words: status.words }
}

/** 高 a filled dot, 低 a hollow one; 中 draws nothing. */
export function PriorityMark({ task }: { task: TaskSummary }) {
  const priority = priorityOf(task)
  if (priority === 'mid') return null
  return <span className="work-board-priority" data-priority={priority} role="img" aria-label={`优先级${PRIORITY_LABELS[priority]}`} />
}

export function TagChips({ tags }: { tags: readonly string[] | undefined }) {
  if (!tags?.length) return null
  return (
    <span className="work-board-tags-row">
      {tags.map(tag => (
        <span key={tag} className="work-board-tag">
          {escapeSecurityText(tag)}
        </span>
      ))}
    </span>
  )
}

/** Who works on it: nothing for Code, the Agent's face for one of 我的 Agent. */
export function WhoMark({ task, shell }: { task: TaskSummary; shell: ShellState }) {
  const who = whoOf(task)
  if (who === WHO_CODE) return null
  const agent = who === GENERAL_AGENT_ID ? undefined : shell.snapshot.customAgents?.find(item => item.id === who)
  if (who !== GENERAL_AGENT_ID && !agent) return null
  return (
    <span className="work-board-who">
      <AgentAvatar avatar={agent ? agent.avatar : 'general'} size={16} still />
      <span>{escapeSecurityText(agent?.name ?? '通用')}</span>
    </span>
  )
}

export interface CardProps {
  task: TaskSummary
  shell: ShellState
  marked: boolean
  delivery?: WorkbenchDeliveryEntry | undefined
  sharedFolder: boolean
  menu: MenuSection[]
  onOpen: (id: string) => void
  /** In place of the card's body: the request the first approval card answers on the board. */
  decision?: ReactNode
}

/**
 * One session on the board: priority and title with its time; Harness, project and branch (and the Agent, for 我的
 * Agent); what it needs or how far it is; tags; where it came from. The card opens the session; its ⋯, a right click or
 * the menu key open the session's board menu.
 */
export const WorkBoardCard = memo(function WorkBoardCard({
  task,
  shell,
  marked,
  delivery,
  sharedFolder,
  menu,
  onOpen,
  decision,
}: CardProps) {
  const connected = shell.connection === 'connected'
  const live = task.status === 'running' || task.status === 'waiting-approval'
  useTicker(connected && live ? 'second' : 'minute')
  const now = hostNow()
  const stopping = shell.stopping.has(task.id) || task.live?.activity === 'cancelling'
  const state = cardState(task, { connected, now, stopping, delivery, sharedFolder })
  const harness = shell.catalog?.harnesses.find(item => item.id === task.harnessId)
  const project = projectOf(task, shell.catalog?.workspaces ?? [])
  const title = escapeSecurityText(task.title || '未命名会话')
  const branch = task.worktree ? escapeSecurityText(task.branch ?? task.worktree.branch) : task.branch && escapeSecurityText(task.branch)
  const found = sessionSource(shell.snapshot, task)
  // A source this device cannot list is not named on the card.
  const source = found && (found.kind === 'schedule' || found.listed) ? found : undefined
  const running = connected && state.tone === 'running' && !stopping
  return (
    <article
      className="work-board-card"
      data-work-session={task.id}
      data-marked={marked ? '' : undefined}
      data-tone={state.tone}
      data-decision={decision ? '' : undefined}>
      {decision ?? (
        <button
          type="button"
          className="work-board-card-main"
          aria-current={marked ? 'true' : undefined}
          onClick={() => {
            onOpen(task.id)
          }}>
          <span className="work-board-card-head">
            <PriorityMark task={task} />
            <span className="work-board-card-title">{title}</span>
            <time dateTime={task.updatedAt}>{relativeTime(task.updatedAt, new Date(now))}</time>
          </span>
          <span className="work-board-card-place">
            <MarkTile mark={harness?.capabilities.display.mark ?? task.harnessId} size={14} label={harness?.capabilities.display.label} />
            <WhoMark task={task} shell={shell} />
            {whoOf(task) === WHO_CODE && (
              <span className="work-board-card-project">
                <Icon icon={FolderGlyph} size={12} />
                <span>{escapeSecurityText(project?.name ?? '无项目')}</span>
              </span>
            )}
            {branch && (
              <span className="work-board-card-branch">
                {task.worktree && <FolderGit2 size={12} aria-label="工作树" />}
                <span>{branch}</span>
              </span>
            )}
          </span>
          <StatusWord className="work-board-card-state" tone={state.tone}>
            {state.words}
          </StatusWord>
          {task.tags?.length ? <TagChips tags={task.tags} /> : null}
          {source && (
            <span className="work-board-card-source">
              {source.kind === 'schedule' && <Icon icon={ScheduleGlyph} size={12} />}
              <span>{`${SOURCE_WORDS[source.kind]} ${escapeSecurityText(source.title ?? '未命名会话')}`}</span>
            </span>
          )}
          {running && <RunningEdge />}
        </button>
      )}
      <span className="work-board-card-actions">
        <Menu
          label={`看板操作：${title}`}
          placement="bottom-end"
          context={rowOf('.work-board-card')}
          sections={menu}
          trigger={props => (
            <IconButton
              {...props}
              className="work-board-card-more"
              size="xs"
              label={`更多操作：${title}`}
              tooltip="更多操作"
              icon={MoreGlyph}
            />
          )}
        />
      </span>
    </article>
  )
})
