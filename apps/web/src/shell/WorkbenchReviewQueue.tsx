import { escapeSecurityText, type TaskSummary } from '@latch/protocol'
import { Button, ChevronRightGlyph, FolderGlyph, Icon, StatusWord } from '@latch/ui'
import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref, type RefObject } from 'react'
import { harnessName } from '../composerChoice.ts'
import { hostNow } from '../core/hostClock.ts'
import { APPROVAL_COPY } from '../core/securityCopy.ts'
import { projectOf } from '../sessions.ts'
import { WorkbenchDecision } from './WorkbenchDecision.tsx'
import { stepRows, workStatus } from './workOverview.ts'
import type { ShellState } from './useShellLayout.tsx'

const PREVIEW_COUNT = 5
type Selection = { id: string; position: number }

export interface WorkbenchReviewMemory {
  selection: Selection | undefined
  open: boolean
}

export interface WorkbenchReviewHandle {
  focusDecision(id: string, focusOverview: () => void): void
}

export function WorkbenchReviewQueue({
  tasks,
  shell,
  layout,
  featured = false,
  memory,
  ref,
}: {
  tasks: readonly TaskSummary[]
  shell: ShellState
  layout: 'overview' | 'triage'
  featured?: boolean
  memory?: RefObject<WorkbenchReviewMemory> | undefined
  ref?: Ref<WorkbenchReviewHandle>
}) {
  const [selection, setSelection] = useState(memory?.current.selection)
  const [all, setAll] = useState(false)
  const [listOpen, setListOpen] = useState(memory?.current.open ?? false)
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
  const listVisible = multiple && (!featured || listOpen)
  const visible =
    all || !hasMore
      ? tasks
      : index >= PREVIEW_COUNT && active
        ? [...tasks.slice(0, PREVIEW_COUNT - 1), active]
        : tasks.slice(0, PREVIEW_COUNT)
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
          const target = card?.querySelector<HTMLElement>('.approval-panel, .question-card, .work-feature-action button') ?? card ?? preview
          if (!(target instanceof HTMLButtonElement) && !target.hasAttribute('tabindex')) target.tabIndex = -1
          target.scrollIntoView({ block: 'nearest' })
          target.focus({ preventScroll: true })
        })
      },
    }),
    [tasks],
  )

  useLayoutEffect(() => {
    if (!memory) return
    memory.current.selection = selection
    memory.current.open = listOpen
  }, [memory, selection, listOpen])

  useEffect(() => {
    if (selection && activeId && (selection.id !== activeId || selection.position !== index))
      setSelection(current => (current === selection ? { id: activeId, position: index } : current))
  }, [activeId, index, selection])

  if (!active) return null
  const workspaces = shell.catalog?.workspaces ?? []
  const harnesses = shell.catalog?.harnesses ?? []
  const sourceProject = projectOf(active, workspaces)
  const sourceHarness = harnesses.find(item => item.id === active.harnessId)
  const sameProject = tasks.every(task => projectOf(task, workspaces)?.id === sourceProject?.id)
  const sameHarness = sourceHarness && tasks.every(task => task.harnessId === sourceHarness.id)
  const unknown = new Set(shell.snapshot.approvals.filter(item => shell.statuses.get(item.id)?.uncertain).map(item => item.sessionId))
  const queue = listVisible ? (
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
      <ul
        ref={list}
        id={listId}
        className="work-overview-review-items"
        aria-label="待处理会话"
        onKeyDown={featured ? event => stepRows(event, event.currentTarget) : undefined}>
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
                  const material = featured ? preview.querySelector<HTMLElement>('.work-feature-material') : preview
                  if (!material) return
                  const previewBox = material.getBoundingClientRect()
                  const listBox = list.current.getBoundingClientRect()
                  if (previewBox.left < listBox.right && listBox.left < previewBox.right) {
                    requestAnimationFrame(() => {
                      if (featured) preview.querySelector('.work-feature-summary')?.scrollIntoView({ block: 'nearest' })
                      else {
                        preview.scrollIntoView({ block: 'start' })
                        preview.focus({ preventScroll: true })
                      }
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
      {hasMore && (
        <div className="work-overview-review-nav">
          <Button variant="ghost" size="xs" aria-controls={listId} aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? '收起' : `还有 ${tasks.length - PREVIEW_COUNT} 件`}
          </Button>
        </div>
      )}
    </div>
  ) : null
  const navigation =
    featured && multiple ? (
      <div className="work-feature-queue" data-open={listOpen ? '' : undefined}>
        <Button
          variant="ghost"
          size="sm"
          className="work-overview-review-toggle"
          aria-controls={listOpen ? listId : undefined}
          aria-expanded={listOpen}
          onClick={() => setListOpen(!listOpen)}>
          {tasks.length} 项待处理
          <Icon icon={ChevronRightGlyph} size={14} />
        </Button>
        {queue}
      </div>
    ) : undefined
  return (
    <div
      className="work-overview-review"
      data-multiple={!featured && listVisible ? '' : undefined}
      data-featured={featured ? '' : undefined}>
      <div className="work-overview-review-layout">
        <div
          ref={detail}
          className="work-overview-review-detail"
          id={detailId}
          role="region"
          aria-label="当前请求"
          data-work-decision-navigation=""
          tabIndex={-1}>
          <WorkbenchDecision
            key={featured ? undefined : activeId}
            task={active}
            shell={shell}
            emphasis
            featured={featured}
            navigation={navigation}
            firstKeys={layout === 'triage' && index === 0}
          />
        </div>
        {!featured && queue}
      </div>
    </div>
  )
}
