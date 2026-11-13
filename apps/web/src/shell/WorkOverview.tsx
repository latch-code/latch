import { useState } from 'react'
import { escapeSecurityText, type AppSnapshot, type TaskSummary } from '@latch/protocol'
import {
  Button,
  Count,
  EmptyState,
  FilterPills,
  FolderGlyph,
  HistoryGlyph,
  Icon,
  InboxGlyph,
  NewSessionGlyph,
  RefreshGlyph,
  SearchGlyph,
  StatusWord,
} from '@latch/ui'
import type { ConnectionStatus } from '../core/useHarness.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { relativeTime } from '../format.ts'
import { projectOf } from '../sessions.ts'
import { workGroups, workStatus, type WorkGroupId } from './workOverview.ts'

const GROUP_ICONS = { attention: InboxGlyph, running: RefreshGlyph, recent: HistoryGlyph }

/** Only live status text ticks; a remote device measures it against the Host's clock. */
function WorkState({ task, connected, stopping, unread }: { task: TaskSummary; connected: boolean; stopping?: boolean; unread?: boolean }) {
  useTicker(connected && (task.status === 'running' || task.status === 'waiting-approval') ? 'second' : false)
  const status = workStatus(task, { connected, now: hostNow(), stopping, unread })
  return (
    <StatusWord className="work-overview-row-status" tone={status.tone}>
      {status.words}
    </StatusWord>
  )
}

/** Both layouts and the session queue read the same summaries and open the same conversation. */
export function WorkOverview({
  snapshot,
  layout,
  connection,
  now,
  onSelect,
  onNew,
  onSearch,
  compact = false,
  selectedId,
  isUnread,
  cancelling,
}: {
  snapshot: AppSnapshot
  layout: 'overview' | 'triage'
  connection: ConnectionStatus
  now: number
  onSelect: (id: string) => void
  onNew: () => void
  onSearch: () => void
  compact?: boolean
  selectedId?: string | null
  isUnread?: (task: TaskSummary) => boolean
  cancelling?: ReadonlySet<string>
}) {
  const groups = workGroups(snapshot.tasks, cancelling)
  const [lane, setLane] = useState<WorkGroupId>('attention')
  const connected = connection === 'connected'
  return (
    <section
      className="work-overview"
      data-layout={layout}
      data-compact={compact ? '' : undefined}
      aria-label={compact ? '会话队列' : layout === 'triage' ? '分拣台' : '工作总览'}>
      <header className="work-overview-heading">
        <h2>{compact ? '会话' : layout === 'triage' ? '分拣台' : '总览'}</h2>
        <div className="work-overview-actions">
          <Button variant="ghost" icon={SearchGlyph} onClick={onSearch}>
            搜索
          </Button>
          <Button variant="ghost" icon={NewSessionGlyph} onClick={onNew}>
            新会话
          </Button>
        </div>
      </header>
      {!connected && <p className="work-overview-connection">{connection === 'connecting' ? '正在连接' : '显示上次同步的会话'}</p>}
      <FilterPills
        className="work-overview-lanes"
        label="分拣会话"
        value={lane}
        options={groups.map(group => ({ value: group.id, label: `${group.label} ${group.tasks.length}` }))}
        onValueChange={setLane}
      />
      <div className="work-overview-groups">
        {groups.map(group => (
          <section
            key={group.id}
            className="work-overview-group"
            data-group={group.id}
            data-active={lane === group.id ? '' : undefined}
            aria-label={group.label}>
            <header className="work-overview-group-heading">
              <Icon icon={GROUP_ICONS[group.id]} size={16} />
              <h3>{group.label}</h3>
              <Count value={group.tasks.length} />
            </header>
            {group.tasks.length === 0 ? (
              <EmptyState className="work-overview-empty" title={group.empty} />
            ) : (
              <ul className="work-overview-list">
                {group.tasks.map(task => {
                  const status = workStatus(task, {
                    connected,
                    now: hostNow(),
                    stopping: cancelling?.has(task.id),
                    unread: isUnread?.(task),
                  })
                  const project = projectOf(task, snapshot.catalog?.workspaces ?? [])
                  const title = escapeSecurityText(task.title || '未命名会话')
                  const projectName = project ? escapeSecurityText(project.name) : '无项目'
                  const branch = task.branch && escapeSecurityText(task.branch)
                  return (
                    <li key={task.id}>
                      <Button
                        variant="ghost"
                        className="work-overview-row"
                        data-work-session={task.id}
                        aria-current={selectedId === task.id ? 'page' : undefined}
                        aria-label={`${title}，${projectName}，${status.words}`}
                        onClick={() => onSelect(task.id)}>
                        <span className="work-overview-row-head">
                          <span className="work-overview-row-title">{title}</span>
                          <time dateTime={task.updatedAt}>{relativeTime(task.updatedAt, new Date(now))}</time>
                        </span>
                        <span className="work-overview-row-context">
                          <Icon icon={FolderGlyph} size={12} />
                          <span>{projectName}</span>
                          {branch && <span className="work-overview-branch">{branch}</span>}
                        </span>
                        <WorkState task={task} connected={connected} stopping={cancelling?.has(task.id)} unread={isUnread?.(task)} />
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        ))}
      </div>
    </section>
  )
}
