import { useRef, useState } from 'react'
import { escapeSecurityText, type AppSnapshot, type TaskSummary } from '@latch/protocol'
import {
  Button,
  Count,
  EmptyState,
  FilterPills,
  FolderGlyph,
  Icon,
  WaitingGlyph,
  PullRequestGlyph,
  NewSessionGlyph,
  RefreshGlyph,
  SearchGlyph,
  StatusWord,
  LaptopGlyph,
  StatusGlyph,
  TerminalGlyph,
  DiffGlyph,
} from '@latch/ui'
import type { ConnectionStatus } from '../core/useHarness.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { relativeTime } from '../format.ts'
import { activityWords, projectOf, rowStatus, spaceOf } from '../sessions.ts'
import { SessionRowGlyph } from '../components/SessionStatus.tsx'
import { runClock, runElapsed } from '../conversation.ts'
import { computerName } from '../core/securityCopy.ts'
import { HistoryImportEntry } from '../history/HistoryImport.tsx'
import { workGroups, workStatus, type WorkGroupId } from './workOverview.ts'
import { WorkbenchDecision } from './WorkbenchDecision.tsx'
import {
  deliveryChecks,
  deliverySessions,
  useWorkbenchSession,
  type DeliveryRead,
  type WorkbenchDeliveryEntry,
} from './useWorkbenchEvidence.ts'
import type { ShellState } from './useShellLayout.tsx'

const GROUP_ICONS = { attention: WaitingGlyph, running: RefreshGlyph, delivery: PullRequestGlyph }

function WorkRunning({ task, shell, onSelect }: { task: TaskSummary; shell: ShellState; onSelect: (id: string) => void }) {
  const connected = shell.connection === 'connected'
  const read = useWorkbenchSession(
    task,
    `${shell.snapshot.device.id}:${shell.snapshot.device.dataScope}:${shell.snapshot.device.scopes.join(',')}`,
    connected && shell.access.scopes.has('view'),
    1500,
  )
  useTicker(connected ? 'second' : false)
  const lastNow = useRef(hostNow())
  if (connected) lastNow.current = hostNow()
  const live = read.detail?.summary.live ?? task.live
  const elapsed = live ? runElapsed(live, lastNow.current) : undefined
  const project = projectOf(task, shell.catalog?.workspaces ?? [])
  const stopping = shell.stopping.has(task.id) || live?.activity === 'cancelling'
  return (
    <article className="work-running" ref={read.element}>
      <Button variant="ghost" className="work-overview-row" data-work-session={task.id} onClick={() => onSelect(task.id)}>
        <span className="work-overview-row-head">
          <StatusGlyph running={connected} state={stopping ? 'stopping' : 'running'}>
            <Icon icon={RefreshGlyph} size={14} />
          </StatusGlyph>
          <span className="work-overview-row-title">{escapeSecurityText(task.title || '未命名会话')}</span>
          {elapsed !== undefined && <span className="work-running-time">{runClock(elapsed)}</span>}
        </span>
        {live && (
          <span className="work-running-action">
            <Icon icon={live.activity === 'command' ? TerminalGlyph : RefreshGlyph} size={12} />
            <span>
              {!connected ? '上次状态：' : ''}
              {stopping ? '正在停止' : escapeSecurityText(live.commandName ?? activityWords(live))}
            </span>
          </span>
        )}
        <span className="work-overview-row-context">
          <Icon icon={FolderGlyph} size={12} />
          <span>{escapeSecurityText(project?.name ?? '无项目')}</span>
          <Icon icon={LaptopGlyph} size={12} />
          <span>{computerName(shell.snapshot.hostName)}</span>
        </span>
      </Button>
    </article>
  )
}

function DeliveryRow({
  task,
  entry,
  snapshot,
  onOpen,
}: {
  task: TaskSummary
  entry: WorkbenchDeliveryEntry
  snapshot: AppSnapshot
  onOpen: () => void
}) {
  const pr = entry.pr?.pr
  const state = entry.state
  const checks = deliveryChecks(entry)
  const changing =
    task.cwd
    && snapshot.tasks.some(
      item => item.id !== task.id && item.cwd === task.cwd && (item.status === 'running' || item.status === 'waiting-approval'),
    )
  const project = projectOf(task, snapshot.catalog?.workspaces ?? [])
  return (
    <div className="work-delivery" data-work-session={task.id}>
      <Button variant="ghost" className="work-delivery-title" icon={PullRequestGlyph} onClick={onOpen}>
        {pr && <span>#{pr.number}</span>}
        {escapeSecurityText(pr?.title ?? (task.title || '未命名会话'))}
      </Button>
      <div className="work-delivery-state">
        <span>
          {checks ?? (state?.files ? `目录未提交 ${state.files} 个文件` : state?.ahead ? `${state.ahead} 个提交未推送` : '查看交付状态')}
        </span>
        <Button size="xs" onClick={onOpen}>
          {pr ? '查看 PR' : state?.files ? '查看改动' : '继续交付'}
        </Button>
      </div>
      {checks && state && (state.files > 0 || state.ahead > 0) && (
        <p className="work-delivery-changes">{state.files > 0 ? `目录未提交 ${state.files} 个文件` : `${state.ahead} 个提交未推送`}</p>
      )}
      <div className="work-delivery-project">
        <Icon icon={FolderGlyph} size={12} />
        {escapeSecurityText(project?.name ?? '无项目')}
        {state?.branch && <span>{escapeSecurityText(state.branch)}</span>}
      </div>
      {entry.error && <p className="work-delivery-error">{entry.error.message}</p>}
      {changing && <p className="work-delivery-live">其他会话正在改动这个目录</p>}
    </div>
  )
}

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

function QueueTime({ task, connected, now }: { task: TaskSummary; connected: boolean; now: number }) {
  const live = task.status === 'running' ? task.live : undefined
  useTicker(connected && live ? 'second' : false)
  const confirmed = useRef(hostNow())
  if (connected) confirmed.current = hostNow()
  const elapsed = live ? runElapsed(live, confirmed.current) : undefined
  return <time dateTime={task.updatedAt}>{elapsed === undefined ? relativeTime(task.updatedAt, new Date(now)) : runClock(elapsed)}</time>
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
  evidence,
  shell,
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
  evidence?: DeliveryRead
  shell?: ShellState
}) {
  const delivered = deliverySessions(snapshot.tasks, evidence?.entries ?? new Map())
  const groups = workGroups(snapshot.tasks, cancelling, delivered)
  const [lane, setLane] = useState<WorkGroupId>('attention')
  const [opened, setOpened] = useState<string>()
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<WorkGroupId>>(new Set())
  const activeDecision = groups[0]!.tasks.some(task => task.id === opened) ? opened : groups[0]!.tasks[0]?.id
  const connected = connection === 'connected'
  const deliveryNotice =
    snapshot.device.dataScope !== 'all'
      ? '这台设备不能读取项目改动'
      : snapshot.catalog?.features?.gitDelivery !== true
        ? '这台电脑未提供交付状态'
        : (evidence?.error ?? (!evidence?.ready ? (evidence?.loading ? '正在读取交付状态…' : '尚未读取交付状态') : undefined))
  const deliveryPartial = [...(evidence?.entries.values() ?? [])].some(entry => entry.error || entry.prError)
  const unobserved = snapshot.tasks.filter(task => !task.archived && spaceOf(task) === 'code' && !evidence?.entries.has(task.id)).length
  const counted = (id: WorkGroupId) => id !== 'delivery' || (!deliveryNotice && !deliveryPartial && unobserved === 0)
  if (!compact && !snapshot.tasks.some(task => !task.archived && spaceOf(task) === 'code'))
    return (
      <section className="workbench-empty" aria-label="工作总览">
        <h2>还没有会话</h2>
        {shell && (
          <div className="workbench-empty-actions">
            <HistoryImportEntry snapshot={snapshot} workspaceId={shell.choice.workspaceId} phone={shell.phone} onOpen={onSelect} />
            {shell.owner && (
              <Button variant="ghost" icon={FolderGlyph} onClick={shell.createProjectAndStart}>
                添加项目
              </Button>
            )}
          </div>
        )}
      </section>
    )
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
        options={groups.map(group => ({
          value: group.id,
          label: counted(group.id) ? `${group.label} ${group.tasks.length}` : group.label,
        }))}
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
              {counted(group.id) && <Count value={group.tasks.length} />}
            </header>
            {group.tasks.length === 0 ? (
              <EmptyState
                className="work-overview-empty"
                action={
                  group.id === 'delivery' && !compact && deliveryPartial && connected && evidence ? (
                    <Button variant="ghost" size="xs" onClick={evidence.refresh}>
                      重试
                    </Button>
                  ) : undefined
                }
                title={
                  group.id === 'delivery'
                    ? (deliveryNotice
                      ?? (deliveryPartial ? '部分目录暂时无法读取' : unobserved ? '已查看的会话没有待交付改动' : group.empty))
                    : group.empty
                }
              />
            ) : (
              <ul className="work-overview-list">
                {(compact || expandedGroups.has(group.id) ? group.tasks : group.tasks.slice(0, group.id === 'delivery' ? 2 : 5)).map(
                  (task, index) => {
                    const status = workStatus(task, {
                      connected,
                      now: hostNow(),
                      stopping: cancelling?.has(task.id),
                      unread: isUnread?.(task),
                    })
                    const project = projectOf(task, snapshot.catalog?.workspaces ?? [])
                    const pullRequest = group.id === 'delivery' ? evidence?.entries.get(task.id)?.pr?.pr : undefined
                    const title = escapeSecurityText(
                      pullRequest ? `#${pullRequest.number} ${pullRequest.title}` : task.title || '未命名会话',
                    )
                    const projectName = project ? escapeSecurityText(project.name) : '无项目'
                    const branch = task.branch && escapeSecurityText(task.branch)
                    return (
                      <li key={task.id}>
                        {!compact && group.id === 'attention' && shell ? (
                          <WorkbenchDecision
                            task={task}
                            shell={shell}
                            emphasis={layout === 'overview' ? task.id === activeDecision : index === 0}
                            expanded={layout === 'triage' || task.id === activeDecision}
                            onExpand={() => setOpened(task.id)}
                            firstKeys={layout === 'triage' && index === 0}
                          />
                        ) : !compact && group.id === 'delivery' && evidence?.entries.get(task.id) ? (
                          <DeliveryRow
                            task={task}
                            entry={evidence.entries.get(task.id)!}
                            snapshot={snapshot}
                            onOpen={() => {
                              onSelect(task.id)
                              if (shell) requestAnimationFrame(() => shell.showSurface({ kind: 'delivery' }))
                            }}
                          />
                        ) : !compact && group.id === 'running' && shell ? (
                          <WorkRunning task={task} shell={shell} onSelect={onSelect} />
                        ) : (
                          <Button
                            variant="ghost"
                            className="work-overview-row"
                            data-work-session={task.id}
                            aria-current={selectedId === task.id ? 'page' : undefined}
                            aria-label={`${title}，${projectName}，${status.words}`}
                            onClick={() => onSelect(task.id)}>
                            <span className="work-overview-row-head">
                              {compact && group.id === 'delivery' ? (
                                <span className="session-row-glyph" data-tone="neutral">
                                  <Icon icon={pullRequest ? PullRequestGlyph : DiffGlyph} size={12} />
                                </span>
                              ) : compact ? (
                                <SessionRowGlyph
                                  status={rowStatus(task, {
                                    stopping: cancelling?.has(task.id),
                                    unread: isUnread?.(task),
                                    frozen: !connected,
                                  })}
                                />
                              ) : null}
                              <span className="work-overview-row-title">{title}</span>
                              <QueueTime task={task} connected={connected} now={now} />
                            </span>
                            <span className="work-overview-row-context">
                              <Icon icon={FolderGlyph} size={12} />
                              <span>{projectName}</span>
                              {branch && <span className="work-overview-branch">{branch}</span>}
                            </span>
                            <WorkState task={task} connected={connected} stopping={cancelling?.has(task.id)} unread={isUnread?.(task)} />
                          </Button>
                        )}
                      </li>
                    )
                  },
                )}
              </ul>
            )}
            {!compact && group.tasks.length > (group.id === 'delivery' ? 2 : 5) && (
              <Button
                variant="ghost"
                className="work-overview-more"
                onClick={() =>
                  setExpandedGroups(previous => {
                    const next = new Set(previous)
                    if (next.has(group.id)) next.delete(group.id)
                    else next.add(group.id)
                    return next
                  })
                }>
                {expandedGroups.has(group.id) ? '收起' : `还有 ${group.tasks.length - (group.id === 'delivery' ? 2 : 5)} 件`}
              </Button>
            )}
            {group.id === 'delivery' && group.tasks.length > 0 && deliveryNotice && (
              <p className="work-overview-connection">{deliveryNotice}</p>
            )}
            {group.id === 'delivery' && !compact && !deliveryNotice && unobserved > 0 && (
              <p className="work-overview-connection">
                已查看最近 {evidence?.entries.size ?? 0} 个会话{' '}
                {shell && (
                  <Button variant="ghost" size="xs" onClick={shell.openAllSessions}>
                    全部会话
                  </Button>
                )}
              </p>
            )}
            {group.id === 'delivery'
              && group.tasks.length > 0
              && !compact
              && evidence
              && !evidence.error
              && [...evidence.entries.values()].some(entry => entry.error || entry.prError) && (
                <p className="work-overview-connection">
                  部分目录暂时无法读取{' '}
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={!connected}
                    tooltip={!connected ? '连接恢复后可以重试' : undefined}
                    onClick={evidence.refresh}>
                    重试
                  </Button>
                </p>
              )}
          </section>
        ))}
      </div>
    </section>
  )
}
