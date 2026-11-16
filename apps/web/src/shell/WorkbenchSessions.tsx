import { useState } from 'react'
import { escapeSecurityText, type AppSnapshot } from '@latch/protocol'
import {
  ArchiveGlyph,
  Button,
  ChevronLeftGlyph,
  EmptyState,
  FolderGlyph,
  Icon,
  IconButton,
  Menu,
  MoreGlyph,
  NewSessionGlyph,
  StatusWord,
} from '@latch/ui'
import { filterSessions, groupSessions, rowStatus } from '../sessions.ts'
import { relativeTime } from '../format.ts'
import { taskHarness } from '../components/Sidebar.tsx'
import { MarkTile } from '../components/BrandTile.tsx'
import { ProjectGroupHeading } from '../components/ProjectNavigation.tsx'
import { SessionRowGlyph } from '../components/SessionStatus.tsx'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { workStatus } from './workOverview.ts'
import type { ShellState } from './useShellLayout.tsx'
import { rowOf } from '../components/overlays.tsx'

/** The complete Code history, grouped by the Host's project identity, including its existing management actions. */
export function WorkbenchSessions({ shell, snapshot }: { shell: ShellState; snapshot: AppSnapshot }) {
  const [projectId, setProjectId] = useState<string>()
  const [archived, setArchived] = useState(false)
  const connected = shell.connection === 'connected'
  useTicker(connected && snapshot.tasks.some(task => task.status === 'running' || task.status === 'waiting-approval') ? 'second' : false)
  const projects = snapshot.catalog?.workspaces ?? []
  const groups = groupSessions(filterSessions(snapshot.tasks, archived ? 'archived' : 'all', '', 'code'), snapshot.catalog?.workspaces, {
    includeEmpty: !archived,
  }).filter(group => projectId === undefined || group.project?.id === projectId)
  const project = projects.find(item => item.id === projectId)
  return (
    <section className="workbench-sessions" aria-label="全部会话">
      <header className="workbench-sessions-head">
        {shell.phone && <IconButton label="返回总览" icon={ChevronLeftGlyph} onClick={shell.openOverview} />}
        <h1>全部会话</h1>
        <div className="workbench-sessions-filters">
          <Menu
            label="筛选项目"
            selection
            trigger={props => (
              <Button {...props} variant="ghost" icon={FolderGlyph} menu>
                {escapeSecurityText(project?.name ?? '全部项目')}
              </Button>
            )}
            sections={[
              {
                id: 'projects',
                items: [
                  { id: 'all', label: '全部项目', checked: projectId === undefined, onSelect: () => setProjectId(undefined) },
                  ...projects.map(item => ({
                    id: item.id,
                    label: item.name,
                    checked: item.id === projectId,
                    onSelect: () => setProjectId(item.id),
                  })),
                ],
              },
            ]}
          />
          <Button variant="ghost" icon={ArchiveGlyph} aria-pressed={archived} onClick={() => setArchived(value => !value)}>
            已归档
          </Button>
          <IconButton label="新建会话" icon={NewSessionGlyph} onClick={shell.startNew} />
        </div>
      </header>
      {groups.length === 0 && <EmptyState title={archived ? '没有已归档的会话' : '还没有会话'} />}
      {groups.map(group => (
        <section key={group.id} className="workbench-session-group" aria-label={group.label}>
          <header className="workbench-session-group-head">
            {group.project ? (
              <ProjectGroupHeading
                project={group.project}
                onNew={shell.startIn ? () => shell.startIn?.(group.project!.id) : undefined}
                onEditProject={shell.owner ? shell.openProjectSettings : undefined}
                onProjectsChanged={() => {
                  void shell.refresh()
                }}
              />
            ) : (
              <>
                <Icon icon={FolderGlyph} size={16} />
                <h2>{escapeSecurityText(group.label)}</h2>
              </>
            )}
            <span className="workbench-session-count">{group.tasks.length}</span>
          </header>
          {group.tasks.map(task => {
            const status = workStatus(task, {
              connected,
              now: hostNow(),
              unread: shell.unread(task),
              stopping: shell.stopping.has(task.id),
            })
            const harness = taskHarness(snapshot, task)
            const title = escapeSecurityText(task.title || '未命名会话')
            return (
              <div className="workbench-session-entry" key={task.id}>
                <button
                  type="button"
                  className="workbench-session-row"
                  data-task-id={task.id}
                  onClick={() => shell.choose(task.id)}
                  aria-current={shell.selectedId === task.id ? 'page' : undefined}>
                  <SessionRowGlyph
                    status={rowStatus(task, { unread: shell.unread(task), stopping: shell.stopping.has(task.id), frozen: !connected })}
                  />
                  <span className="workbench-session-title">{title}</span>
                  <StatusWord tone={status.tone}>{status.words}</StatusWord>
                  <span className="workbench-session-harness">
                    <MarkTile mark={harness.mark} size={14} />
                    {escapeSecurityText(harness.label)}
                  </span>
                  <span className="workbench-session-branch">{escapeSecurityText(task.branch ?? '')}</span>
                  <time dateTime={task.updatedAt}>{relativeTime(task.updatedAt, new Date(shell.now))}</time>
                </button>
                <Menu
                  label={`会话操作：${title}`}
                  align="end"
                  context={rowOf('.workbench-session-entry')}
                  sections={shell.sessionMenu(task)}
                  trigger={props => <IconButton {...props} size="sm" label={`更多操作：${title}`} icon={MoreGlyph} />}
                />
              </div>
            )
          })}
        </section>
      ))}
    </section>
  )
}
