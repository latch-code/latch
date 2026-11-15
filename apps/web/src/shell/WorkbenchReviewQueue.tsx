import { escapeSecurityText, type TaskSummary } from '@latch/protocol'
import { Button, ChevronRightGlyph, FolderGlyph, Icon, StatusWord } from '@latch/ui'
import { useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { harnessName } from '../composerChoice.ts'
import { hostNow } from '../core/hostClock.ts'
import { APPROVAL_COPY } from '../core/securityCopy.ts'
import { projectOf } from '../sessions.ts'
import { WorkbenchDecision } from './WorkbenchDecision.tsx'
import { workStatus } from './workOverview.ts'
import type { ShellState } from './useShellLayout.tsx'

const PREVIEW_COUNT = 5

export interface WorkbenchReviewHandle {
  focusDecision(id: string, focusOverview: () => void): void
}

export function WorkbenchReviewQueue({
  tasks,
  shell,
  layout,
  ref,
}: {
  tasks: readonly TaskSummary[]
  shell: ShellState
  layout: 'overview' | 'triage'
  ref?: Ref<WorkbenchReviewHandle>
}) {
  const [selection, setSelection] = useState<{ id: string; position: number }>()
  const [all, setAll] = useState(false)
  const [edges, setEdges] = useState({ before: false, after: false })
  const detailId = useId()
  const listId = useId()
  const list = useRef<HTMLUListElement>(null)
  const detail = useRef<HTMLDivElement>(null)
  const position = selection ? tasks.findIndex(task => task.id === selection.id) : 0
  const index = position < 0 ? Math.min(selection?.position ?? 0, tasks.length - 1) : position
  const active = tasks[index]
  const activeId = active?.id
  const multiple = tasks.length > 1
  const hasMore = tasks.length > PREVIEW_COUNT
  const visible =
    all || !hasMore
      ? tasks
      : index >= PREVIEW_COUNT && active
        ? [...tasks.slice(0, PREVIEW_COUNT - 1), active]
        : tasks.slice(0, PREVIEW_COUNT)
  const visibleIds = visible.map(task => task.id).join('\n')
  useImperativeHandle(
    ref,
    () => ({
      focusDecision(id, focusOverview) {
        const position = tasks.findIndex(task => task.id === id)
        if (position >= 0) setSelection({ id, position })
        requestAnimationFrame(() => {
          const preview = detail.current
          if (!preview || preview.closest('[inert]') || !preview.checkVisibility({ visibilityProperty: true })) {
            focusOverview()
            return
          }
          const card = preview.querySelector<HTMLElement>(`[data-work-session="${CSS.escape(id)}"]`)
          const target = card?.querySelector<HTMLElement>('.approval-panel, .question-card') ?? card ?? preview
          if (!target.hasAttribute('tabindex')) target.tabIndex = -1
          target.scrollIntoView({ block: 'nearest' })
          target.focus({ preventScroll: true })
        })
      },
    }),
    [tasks],
  )

  useEffect(() => {
    if (selection && activeId && (selection.id !== activeId || selection.position !== index))
      setSelection(current => (current === selection ? { id: activeId, position: index } : current))
  }, [activeId, index, selection])

  const readEdges = useCallback(() => {
    const element = list.current
    if (!element) return
    const before = element.scrollTop > 1
    const after = element.scrollTop + element.clientHeight < element.scrollHeight - 1
    setEdges(previous => (previous.before === before && previous.after === after ? previous : { before, after }))
  }, [])
  useEffect(() => {
    const element = list.current
    if (!element) return
    const resize = new ResizeObserver(readEdges)
    resize.observe(element)
    for (const row of element.children) resize.observe(row)
    readEdges()
    return () => resize.disconnect()
  }, [multiple, readEdges, visibleIds])

  if (!active) return null
  const workspaces = shell.catalog?.workspaces ?? []
  const harnesses = shell.catalog?.harnesses ?? []
  const sourceProject = projectOf(active, workspaces)
  const sourceHarness = harnesses.find(item => item.id === active.harnessId)
  const sameProject = tasks.every(task => projectOf(task, workspaces)?.id === sourceProject?.id)
  const sameHarness = sourceHarness && tasks.every(task => task.harnessId === sourceHarness.id)
  const unknown = new Set(shell.snapshot.approvals.filter(item => shell.statuses.get(item.id)?.uncertain).map(item => item.sessionId))
  return (
    <div className="work-overview-review" data-multiple={multiple ? '' : undefined}>
      <div className="work-overview-review-layout">
        <div
          ref={detail}
          className="work-overview-review-detail"
          id={detailId}
          role="region"
          aria-label="当前请求"
          data-work-decision-navigation=""
          tabIndex={-1}>
          <WorkbenchDecision key={activeId} task={active} shell={shell} emphasis firstKeys={layout === 'triage' && index === 0} />
        </div>
        {multiple && (
          <div className="work-overview-review-list" data-work-decision-navigation>
            {(sameProject || sameHarness) && (
              <p className="work-overview-review-context work-overview-review-source">
                {sameProject && (
                  <>
                    <Icon icon={FolderGlyph} size={12} />
                    <span>{escapeSecurityText(sourceProject?.name ?? '无项目')}</span>
                  </>
                )}
                {sameHarness && <span>{escapeSecurityText(harnessName(sourceHarness))}</span>}
              </p>
            )}
            <ul ref={list} id={listId} className="work-overview-review-items" aria-label="待处理会话" onScroll={readEdges}>
              {visible.map(task => {
                const selected = task.id === activeId
                const status = workStatus(task, { connected: shell.connection === 'connected', now: hostNow() })
                const project = !sameProject && projectOf(task, workspaces)
                const harness = !sameHarness && harnesses.find(item => item.id === task.harnessId)
                const uncertain = unknown.has(task.id)
                return (
                  <li key={task.id}>
                    <Button
                      variant="ghost"
                      className="work-overview-review-row"
                      data-request-session={task.id}
                      aria-current={selected ? 'true' : undefined}
                      aria-controls={detailId}
                      onClick={() => {
                        setSelection({ id: task.id, position: tasks.indexOf(task) })
                        const preview = detail.current
                        if (!preview || !list.current) return
                        const previewBox = preview.getBoundingClientRect()
                        const listBox = list.current.getBoundingClientRect()
                        if (previewBox.left < listBox.right && listBox.left < previewBox.right) {
                          requestAnimationFrame(() => {
                            preview.scrollIntoView({ block: 'start' })
                            preview.focus({ preventScroll: true })
                          })
                        }
                      }}>
                      <span className="work-overview-review-title">
                        {status.tone === 'failed' && <span className="work-decision-verb">查看</span>}
                        {escapeSecurityText(task.title || '未命名会话')}
                      </span>
                      <span className="work-overview-review-source">
                        {!sameProject && (
                          <>
                            <Icon icon={FolderGlyph} size={12} />
                            <span>{escapeSecurityText(project ? project.name : '无项目')}</span>
                          </>
                        )}
                        {harness && <span>{escapeSecurityText(harnessName(harness))}</span>}
                        <StatusWord tone={uncertain ? 'warn' : status.tone}>
                          {uncertain ? APPROVAL_COPY.uncertainApproval : status.words}
                        </StatusWord>
                      </span>
                      <Icon icon={ChevronRightGlyph} size={14} />
                    </Button>
                  </li>
                )
              })}
            </ul>
            {(hasMore || edges.before || edges.after) && (
              <div className="work-overview-review-nav">
                {hasMore && (
                  <Button variant="ghost" size="xs" aria-controls={listId} aria-expanded={all} onClick={() => setAll(!all)}>
                    {all ? '收起' : `还有 ${tasks.length - PREVIEW_COUNT} 件`}
                  </Button>
                )}
                {(edges.before || edges.after) && (
                  <>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={!edges.before}
                      onClick={() => list.current?.scrollBy(0, -list.current.clientHeight)}>
                      上一组
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={!edges.after}
                      onClick={() => list.current?.scrollBy(0, list.current.clientHeight)}>
                      下一组
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
