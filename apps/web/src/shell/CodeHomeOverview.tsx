import { useImperativeHandle, useRef, type Ref, type RefObject } from 'react'
import { GENERAL_AGENT_ID, type AppSnapshot, type TaskDetail, type TaskSummary, readsProjectFiles } from '@latch/protocol'
import {
  Button,
  ChevronRightGlyph,
  DiffGlyph,
  FolderGlyph,
  Icon,
  NewSessionGlyph,
  PullRequestGlyph,
  RunningEdge,
  StatusWord,
} from '@latch/ui'
import { personalChat } from '../agents/chat.ts'
import { AgentAvatar } from '../agents/AgentAvatar.tsx'
import { HarnessTile } from '../components/BrandTile.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { turnsOf } from '../conversation.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { sessionReadOnly } from '../core/permissions.ts'
import { basename } from '../format.ts'
import { HistoryImportEntry } from '../history/HistoryImport.tsx'
import { projectOf, spaceOf } from '../sessions.ts'
import { WorkbenchReviewQueue, type WorkbenchReviewHandle, type WorkbenchReviewMemory } from './WorkbenchReviewQueue.tsx'
import { deliverySessions, useWorkbenchSession, type DeliveryRead } from './useWorkbenchEvidence.ts'
import { recentCodeWork, useQueueEdge, workGroups, workStatus } from './workOverview.ts'
import type { WorkOverviewHandle } from './WorkOverview.tsx'
import type { ShellState } from './useShellLayout.tsx'

const outputsSettling = (detail: TaskDetail) => detail.messages.some(message => message.outputsPending)

function RecentOutput({ task, shell }: { task: TaskSummary; shell: ShellState }) {
  const { device } = shell.snapshot
  const read = useWorkbenchSession<HTMLLIElement>(
    task,
    `${device.id}:${device.dataScope}:${device.scopes.join(',')}`,
    shell.connection === 'connected',
    1200,
    outputsSettling,
  )
  const turn = read.detail && turnsOf(read.detail.messages).at(-1)
  const report = turn?.replies.findLast(message => message.outputs?.length && !message.outputsPending && !message.outputsUnavailable)
  const file = report?.outputs?.find(item => item.change !== 'deleted')
  const settling = !!read.detail && outputsSettling(read.detail)
  const failed = !!read.error
  return (
    <li ref={read.element} aria-hidden={(!file && !settling && !failed) || undefined}>
      {file ? (
        <Button
          variant="ghost"
          className="work-landing-row"
          onClick={() => shell.openFile({ sessionId: task.id, reference: file.path, rootId: file.root })}>
          <span className="work-landing-row-icon">
            <Icon icon={DiffGlyph} size={16} />
          </span>
          <span className="work-landing-row-copy">
            <code>
              <VisibleText text={basename(file.path)} />
            </code>
            <span>
              <VisibleText text={`${task.title || '未命名会话'} / ${file.path}`} />
            </span>
          </span>
          <Icon icon={ChevronRightGlyph} size={14} />
        </Button>
      ) : failed ? (
        <div className="work-landing-result-note">
          <span>暂时无法读取成果</span>
          <Button variant="ghost" size="xs" aria-label="重试读取成果" disabled={shell.connection !== 'connected'} onClick={read.retry}>
            重试
          </Button>
        </div>
      ) : settling ? (
        <p className="work-landing-result-note">正在核对文件改动…</p>
      ) : null}
    </li>
  )
}

function WorkContinuation({ task, shell, onSelect }: { task: TaskSummary; shell: ShellState; onSelect: (id: string) => void }) {
  const project = projectOf(task, shell.catalog?.workspaces ?? [])
  const harness = shell.catalog?.harnesses.find(item => item.id === task.harnessId)
  const connected = shell.connection === 'connected'
  const live = task.live
  useTicker(connected && live ? 'second' : false)
  const confirmed = useRef(hostNow())
  if (connected) confirmed.current = hostNow()
  const status = workStatus(task, { connected, now: confirmed.current, stopping: shell.stopping.has(task.id) })
  return (
    <li>
      <Button variant="ghost" className="work-landing-row" data-work-session={task.id} onClick={() => onSelect(task.id)}>
        <span className="work-landing-row-icon">
          {harness ? <HarnessTile harness={harness} size={16} /> : <Icon icon={FolderGlyph} size={16} />}
        </span>
        <span className="work-landing-row-copy">
          <strong>
            <VisibleText text={task.title || '未命名会话'} />
          </strong>
          {task.status === 'running' || status.tone === 'failed' || status.tone === 'warn' ? (
            <StatusWord tone={status.tone}>{status.words}</StatusWord>
          ) : (
            <span>
              <VisibleText text={project?.name ?? '无项目'} />
            </span>
          )}
        </span>
        <Icon icon={ChevronRightGlyph} size={14} />
        {connected && status.tone === 'running' && <RunningEdge />}
      </Button>
    </li>
  )
}

/** The opening page shows a current decision. Sorting and acting on the full queue belong to the other layout. */
export function CodeHomeOverview({
  snapshot,
  shell,
  onNew,
  onSelect,
  evidence,
  ref,
  reviewMemory,
}: {
  snapshot: AppSnapshot
  shell: ShellState
  onNew: () => void
  onSelect: (id: string) => void
  evidence?: DeliveryRead | undefined
  ref?: Ref<WorkOverviewHandle> | undefined
  reviewMemory?: RefObject<WorkbenchReviewMemory> | undefined
}) {
  const root = useRef<HTMLElement>(null)
  const review = useRef<WorkbenchReviewHandle>(null)
  useQueueEdge(root)
  useImperativeHandle(
    ref,
    () => ({
      focusAttention(id) {
        const focusHome = () => {
          if (!root.current?.closest('[inert]')) root.current?.focus({ preventScroll: true })
        }
        if (review.current) review.current.focusDecision(id, focusHome)
        else requestAnimationFrame(focusHome)
      },
    }),
    [],
  )
  const delivery = deliverySessions(snapshot.tasks, evidence?.entries ?? new Map())
  const groups = workGroups(snapshot.tasks, shell.stopping, delivery)
  const [attention, running, deliverable] = groups
  const connected = shell.connection === 'connected'
  const tasks = snapshot.tasks.filter(task => !task.archived && spaceOf(task) === 'code')
  const recent = [
    ...running!.tasks,
    ...attention!.tasks.slice(1).filter(task => task.status === 'failed' || task.runOutcome === 'failed'),
    ...recentCodeWork(snapshot.tasks, groups),
  ].slice(0, 3)
  const general = personalChat(snapshot, GENERAL_AGENT_ID)
  const continueGeneral = recent.length < 3 && general?.state === 'ready' && snapshot.tasks.some(task => task.id === general.sessionId)
  // Keep history reads bounded to two currently authorized summaries, and read each only once its row is on screen.
  const outputCandidates =
    readsProjectFiles(snapshot.device.dataScope) && shell.access.scopes.has('view') && snapshot.catalog?.features?.filePreview
      ? tasks
          .filter(task => task.status === 'idle' && task.runOutcome === 'completed' && !sessionReadOnly(task))
          .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 2)
      : []
  return (
    <section
      ref={root}
      className="work-landing"
      tabIndex={-1}
      aria-label="工作总览"
      data-backdrop-clear=""
      data-work-decision-navigation="">
      <header className="work-landing-heading">
        <h2>工作总览</h2>
        <Button variant="ghost" icon={NewSessionGlyph} onClick={onNew}>
          新会话
        </Button>
      </header>
      {!connected && <p className="work-landing-connection">{shell.connection === 'connecting' ? '正在连接' : '显示上次同步的会话'}</p>}
      {attention!.tasks.length > 0 && (
        <WorkbenchReviewQueue ref={review} tasks={attention!.tasks} shell={shell} layout="overview" featured memory={reviewMemory} />
      )}
      {tasks.length === 0 && (
        <div className="work-landing-empty workbench-empty">
          <h3>还没有会话</h3>
          <div className="workbench-empty-actions">
            <HistoryImportEntry snapshot={snapshot} workspaceId={shell.choice.workspaceId} phone={shell.phone} onOpen={onSelect} />
            {shell.owner && (
              <Button variant="ghost" icon={FolderGlyph} onClick={shell.createProjectAndStart}>
                添加项目
              </Button>
            )}
          </div>
        </div>
      )}
      <div className="work-landing-below">
        {(recent.length > 0 || continueGeneral) && (
          <section className="work-landing-continuation" aria-label="接着做">
            <h3>接着做</h3>
            <ul>
              {recent.map(task => (
                <WorkContinuation key={task.id} task={task} shell={shell} onSelect={onSelect} />
              ))}
              {continueGeneral && (
                <li>
                  <Button variant="ghost" className="work-landing-row" onClick={() => shell.openMyAgent({ id: GENERAL_AGENT_ID })}>
                    <span className="work-landing-row-icon">
                      <AgentAvatar avatar="general" size={16} />
                    </span>
                    <span className="work-landing-row-copy">
                      <strong>通用</strong>
                      <span>我的 Agent</span>
                    </span>
                    <Icon icon={ChevronRightGlyph} size={14} />
                  </Button>
                </li>
              )}
            </ul>
          </section>
        )}
        {(outputCandidates.length > 0 || deliverable!.tasks.length > 0) && (
          <section className="work-landing-results" aria-label="最近成果">
            <h3>最近成果</h3>
            <ul>
              {outputCandidates.map(task => (
                <RecentOutput key={task.id} task={task} shell={shell} />
              ))}
            </ul>
            {deliverable!.tasks[0] && (
              <Button
                variant="ghost"
                className="work-landing-delivery"
                icon={PullRequestGlyph}
                onClick={() => {
                  onSelect(deliverable!.tasks[0]!.id)
                  requestAnimationFrame(() => shell.showSurface({ kind: 'delivery' }))
                }}>
                查看交付
              </Button>
            )}
          </section>
        )}
      </div>
    </section>
  )
}
