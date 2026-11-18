import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { TextQuote } from 'lucide-react'
import {
  WORK_ITEM_LIMITS,
  escapeSecurityText,
  readsProjectFiles,
  type BoardPriority,
  type TaskDetail,
  type TaskSummary,
  type WorkItem,
  type WorkItemAnswer,
  type WorkItemPatchInput,
  type WorkItemSummary,
  type WorkbenchDeliveryEntry,
} from '@latch/protocol'
import {
  Button,
  CheckGlyph,
  ChevronLeftGlyph,
  EditGlyph,
  FoldHeader,
  IconButton,
  LockGlyph,
  MessageGlyph,
  MoreGlyph,
  NewSessionGlyph,
  PlusGlyph,
  SegmentedControl,
  StatusWord,
  TextAreaField,
  TrashGlyph,
  UndoGlyph,
  type StatusTone,
} from '@latch/ui'
import { FolderGit2 } from 'lucide-react'
import { MarkTile } from '../components/BrandTile.tsx'
import { knownTags, SessionTagsDialog } from '../components/SessionTagsDialog.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { ConfirmDialog, Menu, rowOf, type MenuSection } from '../components/overlays.tsx'
import { api, ApiError, errorMessage, MessageError } from '../core/api.ts'
import { handDraft } from '../core/draftHandoff.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { harnessName } from '../core/harnessName.ts'
import { defineCopy, formatNumber } from '../core/i18n.ts'
import { dateTime, relativeTime } from '../format.ts'
import { useBackLayer } from '../hooks/backStack.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { useWorkbenchDelivery } from '../shell/useWorkbenchEvidence.ts'
import { closeItemPage } from './itemPage.ts'
import { ItemPagePick } from './ItemPagePick.tsx'
import { ItemPageStart } from './ItemPageStart.tsx'
import { ItemThread, useItemThread } from './ItemThread.tsx'
import { THREAD_COPY } from './itemThread.ts'
import { bringReply, joinableSessions, placeWords } from './items.ts'
import { PRIORITY_LABELS } from './model.ts'
import { BOARD_CARD_COPY, cardState, TagChips } from './WorkBoardCard.tsx'
import { ExternalMark, ProposedBy } from './WorkBoardProposalCard.tsx'
import { ItemEvidence } from './ItemEvidence.tsx'
import { BranchName } from '../components/MiddleEllipsis.tsx'

const COPY = defineCopy(
  {
    noReply: '这个会话还没有回复',
    deleteTask: '删除待办',
    task: (title: string) => `待办：${title}`,
    board: '看板',
    reopen: '重新打开',
    done: '完成',
    actions: '待办操作',
    properties: '属性',
    taskProperties: '待办属性',
    viewPost: '查看发言',
    status: '状态',
    attention: '等你处理',
    project: '项目',
    tags: '标签',
    none: '无',
    editTags: '编辑标签',
    priority: '优先级',
    note: '备注',
    from: '来自',
    created: '创建',
    completed: '完成',
    sessions: '会话',
    addSession: '加入会话',
    anotherSession: '再开一个',
    start: '开始',
    unlisted: '不在列表中',
    outside: '未加入的会话',
    outsideOne: '未加入',
    notSaved: '没有保存，请重试。',
    delete: '删除',
    confirmDelete: (title: string) => `删除「${title}」？它的会话保留。`,
    noSessionsToAdd: '没有可加入的会话',
    title: '标题',
    editTitle: (title: string) => `标题：${title}，编辑`,
    instructions: '要求',
    save: '保存',
    openInChat: '在对话中打开',
    bring: '带过去',
    removeSession: '移出待办',
    worktree: '工作树',
    bringReply: (title: string) => `带过去：${title}`,
    bringTo: '带到',
    sessionActions: (title: string) => `会话操作：${title}`,
  },
  {
    noReply: 'This session has no reply yet',
    deleteTask: 'Delete task',
    task: (title: string) => `Task: ${title}`,
    board: 'Board',
    reopen: 'Reopen',
    done: 'Mark done',
    actions: 'Task actions',
    properties: 'Properties',
    taskProperties: 'Task properties',
    viewPost: 'View post',
    status: 'Status',
    attention: 'Needs you',
    project: 'Project',
    tags: 'Tags',
    none: 'None',
    editTags: 'Edit tags',
    priority: 'Priority',
    note: 'Note',
    from: 'From',
    created: 'Created',
    completed: 'Completed',
    sessions: 'Sessions',
    addSession: 'Add session',
    anotherSession: 'Start another',
    start: 'Start',
    unlisted: 'Not in the list',
    outside: 'Sessions outside this task',
    outsideOne: 'Outside this task',
    notSaved: 'Changes weren’t saved. Try again.',
    delete: 'Delete',
    confirmDelete: (title: string) => `Delete “${title}”? Its sessions will be kept.`,
    noSessionsToAdd: 'No sessions to add',
    title: 'Title',
    editTitle: (title: string) => `Edit title: ${title}`,
    instructions: 'Instructions',
    save: 'Save',
    openInChat: 'Open in chat',
    bring: 'Bring reply',
    removeSession: 'Remove from task',
    worktree: 'Worktree',
    bringReply: (title: string) => `Bring reply from ${title}`,
    bringTo: 'Bring reply to',
    sessionActions: (title: string) => `Session actions for ${title}`,
  },
)

const PLACE_TONE: Record<WorkItemSummary['board']['group'], StatusTone> = {
  todo: 'neutral',
  attention: 'waiting',
  running: 'running',
  deliver: 'neutral',
  done: 'neutral',
}
const PRIORITIES = ['high', 'mid', 'low'] as const
const itemPath = (id: string) => `work/items/${encodeURIComponent(id)}`

/** The 待办's full record (its 要求 is not in the snapshot), read again whenever the Host's revision moves. */
function useItemRecord(id: string, revision: number | undefined, onGone: () => void) {
  const [record, setRecord] = useState<WorkItem | null>(null)
  const gone = useRef(onGone)
  useEffect(() => {
    gone.current = onGone
  })
  const read = useCallback(async () => {
    try {
      const { item } = await api<WorkItemAnswer>(itemPath(id))
      setRecord(previous => (previous && previous.id === item.id && previous.revision > item.revision ? previous : item))
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) gone.current()
    }
  }, [id])
  useEffect(() => {
    if (revision === undefined) return
    void read()
  }, [read, revision])
  return { record: record?.id === id ? record : null, setRecord, read }
}

/**
 * A 待办's page, in 看板's place (no sidebar): its title and 要求 (editable until it has a session), its sessions with the
 * state the Host gives each, 再开一个, adding or removing a session, 带过去 (a session's last reply into another one's
 * input), 完成 or 重新打开, and a facts card with its tags and priority. ← 看板, Esc and the browser's back return to the
 * board. The discussion shares its authorized read with the current decision above the scrolling body.
 */
export function ItemPage({ shell, itemId, outside }: { shell: ShellState; itemId: string; outside: readonly TaskSummary[] }) {
  const { snapshot } = shell
  const item = snapshot.items?.find(entry => entry.id === itemId)
  const thread = useItemThread(item, snapshot, shell.connection === 'connected')
  const canWrite = shell.access.scopes.has('run')
  const root = useRef<HTMLElement>(null)
  const close = useCallback(() => {
    closeItemPage()
  }, [])
  const { record, setRecord, read } = useItemRecord(itemId, item?.revision, close)
  // A 待办 the snapshot no longer lists (deleted, or no longer readable here) closes its page without a word.
  const listed = item !== undefined
  useEffect(() => {
    if (!listed && snapshot.items !== undefined) close()
  }, [listed, snapshot.items, close])
  useBackLayer(shell.board, close)
  // Esc on the page itself goes back; a dialog, a menu or a field takes its own Esc first.
  useEffect(() => {
    if (!shell.board) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target && (target.isContentEditable || target.closest('input, textarea, select, dialog, [role="menu"], [role="dialog"]'))) return
      // Menus stay mounted while closed: only one in sight takes the Esc.
      if (document.querySelector('dialog[open]') || [...document.querySelectorAll('[role="menu"]')].some(menu => menu.checkVisibility()))
        return
      // Focus on the board's own surface or nowhere: anything else (the title row, a sheet) keeps its Esc.
      if (target && target !== document.body && !target.closest('.board-surface')) return
      event.preventDefault()
      close()
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
    }
  }, [close, shell.board])

  const canReadFiles = readsProjectFiles(snapshot.device.dataScope)
  const evidence = useWorkbenchDelivery(snapshot, shell.connection, shell.board && item !== undefined, item?.sessionIds ?? [])

  const factsId = useId()
  const [factsOpen, setFactsOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tagging, setTagging] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [joining, setJoining] = useState(false)
  const [starting, setStarting] = useState(false)
  const [bringing, setBringing] = useState<string | null>(null)
  const fail = (cause: unknown) => {
    shell.setToast({ text: errorMessage(cause), tone: 'error' })
  }
  /** One change of the record, made on the revision this page read; a stale one reads the 待办 again. */
  const patch = async (change: Omit<WorkItemPatchInput, 'baseRevision'>): Promise<boolean> => {
    const base = record?.revision ?? item?.revision
    if (base === undefined) return false
    setBusy(true)
    try {
      const { item: next } = await api<WorkItemAnswer>(itemPath(itemId), { method: 'PATCH', body: { baseRevision: base, ...change } })
      setRecord(next)
      await shell.refresh()
      return true
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'item-changed') void read()
      fail(cause)
      return false
    } finally {
      setBusy(false)
    }
  }
  const leave = async (sessionId: string) => {
    setBusy(true)
    try {
      const { item: next } = await api<WorkItemAnswer>(`${itemPath(itemId)}/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      })
      setRecord(next)
      await shell.refresh()
    } catch (cause) {
      fail(cause)
    } finally {
      setBusy(false)
    }
  }
  const join = async (sessionId: string) => {
    try {
      const { item: next } = await api<WorkItemAnswer>(`${itemPath(itemId)}/sessions`, { method: 'POST', body: { sessionId } })
      setRecord(next)
    } catch (cause) {
      throw new MessageError(errorMessage(cause))
    }
    await shell.refresh()
  }
  const openSession = (id: string) => {
    shell.openWorkItemSession(itemId, { sessionId: id })
  }
  /**
   * 带过去: the source's last settled reply goes into the target's input as a quote, and the target opens in 对话. Nothing
   * is sent; sending is the person's.
   */
  const bring = async (sourceId: string, targetId: string) => {
    setBringing(sourceId)
    try {
      const done = await bringReply(sourceId, targetId, {
        read: path => api<TaskDetail>(path),
        hand: handDraft,
        open: openSession,
      })
      if (done === 'empty') shell.setToast({ text: COPY.noReply, tone: 'error' })
    } catch (cause) {
      fail(cause)
    } finally {
      setBringing(null)
    }
  }

  if (!item) return null
  const closed = item.closedAt !== undefined
  const decisionPost = closed
    ? undefined
    : (thread.posts?.find(post => post.id === item.board.postId && thread.decisions.has(post.id))
      ?? thread.posts?.findLast(post => thread.decisions.has(post.id)))
  const decision = decisionPost && thread.decisions.get(decisionPost.id)
  const members = item.sessionIds.map(id => ({ id, task: snapshot.tasks.find(task => task.id === id) }))
  const full = item.sessionIds.length >= WORK_ITEM_LIMITS.sessions
  const canStart = canWrite && !closed && !full && shell.homeComposerState.gate.kind === 'open'
  const project = item.projectId ? shell.catalog?.workspaces.find(entry => entry.id === item.projectId) : undefined
  const harness = item.harnessId ? shell.catalog?.harnesses.find(entry => entry.id === item.harnessId) : undefined
  const title = escapeSecurityText(item.title)
  const menu: MenuSection[] = canWrite
    ? [
        {
          id: 'danger',
          items: [{ id: 'delete', label: COPY.deleteTask, icon: TrashGlyph, danger: true, onSelect: () => setDeleting(true) }],
        },
      ]
    : []

  return (
    <section ref={root} className="item-page" aria-label={COPY.task(title)} data-item-id={item.id} data-closed={closed ? '' : undefined}>
      <header className="item-page-head">
        <Button className="item-page-back" variant="ghost" size="sm" icon={ChevronLeftGlyph} onClick={close}>
          {COPY.board}
        </Button>
        <ItemTitle title={item.title} canEdit={canWrite} busy={busy} onSave={next => patch({ title: next })} />
        <div className="item-page-head-actions">
          {canWrite
            && (closed ? (
              <Button size="sm" variant="outline" icon={UndoGlyph} disabled={busy} onClick={() => void patch({ closed: false })}>
                {COPY.reopen}
              </Button>
            ) : (
              <Button size="sm" variant="outline" icon={CheckGlyph} disabled={busy} onClick={() => void patch({ closed: true })}>
                {COPY.done}
              </Button>
            ))}
          {menu.length > 0 && (
            <Menu
              label={COPY.actions}
              placement="bottom-end"
              sections={menu}
              trigger={props => <IconButton {...props} size="sm" label={COPY.actions} icon={MoreGlyph} />}
            />
          )}
        </div>
      </header>
      {decisionPost?.turn && decision && (
        <section className="item-page-attention" aria-label={COPY.attention}>
          <StatusWord tone="waiting">{THREAD_COPY.waiting[decision.kind].status}</StatusWord>
          <Button size="sm" variant="secondary" onClick={() => shell.openWorkItemSession(itemId, { ...decisionPost.turn!, decision })}>
            {THREAD_COPY.waiting[decision.kind].action}
          </Button>
        </section>
      )}
      <div className="item-page-body">
        <aside className="item-page-facts" aria-label={COPY.properties} data-facts-open={factsOpen ? '' : undefined}>
          <dl>
            <div>
              <dt>{COPY.status}</dt>
              <dd className="item-page-fact-status">
                <StatusWord tone={closed ? 'neutral' : PLACE_TONE[item.board.group]}>{placeWords(item.board)}</StatusWord>
                {item.board.postId && item.board.postId !== decisionPost?.id && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      const post = root.current?.querySelector<HTMLElement>(`[data-post-id="${CSS.escape(item.board.postId!)}"]`)
                      if (!post) return
                      post.scrollIntoView({ block: 'nearest' })
                      post.querySelector<HTMLElement>('.item-thread-action, .item-thread-post-state button')?.focus({ preventScroll: true })
                    }}>
                    {COPY.viewPost}
                  </Button>
                )}
              </dd>
            </div>
          </dl>
          <FoldHeader className="item-page-facts-toggle" open={factsOpen} onOpenChange={setFactsOpen} aria-controls={factsId}>
            {COPY.taskProperties}
          </FoldHeader>
          <dl className="item-page-facts-details" id={factsId}>
            <div>
              <dt>{COPY.project}</dt>
              <dd>{project ? escapeSecurityText(project.name) : BOARD_CARD_COPY.noProject}</dd>
            </div>
            {item.harnessId && (
              <div>
                <dt>Harness</dt>
                <dd className="item-page-fact-harness">
                  <MarkTile mark={harness?.capabilities.display.mark ?? item.harnessId} size={14} />
                  <span>{escapeSecurityText(harness ? harnessName(harness) : item.harnessId)}</span>
                </dd>
              </div>
            )}
            <div>
              <dt>{COPY.tags}</dt>
              <dd className="item-page-fact-tags">
                {item.tags?.length ? <TagChips tags={item.tags} /> : <span className="item-page-none">{COPY.none}</span>}
                {canWrite && (
                  <IconButton size="xs" label={COPY.editTags} icon={EditGlyph} disabled={busy} onClick={() => setTagging(true)} />
                )}
              </dd>
            </div>
            <div>
              <dt>{COPY.priority}</dt>
              <dd>
                <SegmentedControl
                  size="xs"
                  label={COPY.priority}
                  value={item.priority ?? 'mid'}
                  options={PRIORITIES.map(value => ({ value, label: PRIORITY_LABELS[value] }))}
                  disabled={!canWrite || busy}
                  onValueChange={(value: BoardPriority | 'mid') => {
                    if (value !== (item.priority ?? 'mid')) void patch({ priority: value })
                  }}
                />
              </dd>
            </div>
            {item.note && (
              <div>
                <dt>{COPY.note}</dt>
                <dd>{escapeSecurityText(item.note)}</dd>
              </div>
            )}
            {item.from && (
              <div>
                <dt>{COPY.from}</dt>
                <dd className="work-board-proposal-line">
                  <ProposedBy
                    proposal={{ from: item.from }}
                    shell={shell}
                    details
                    onOpenSession={id =>
                      shell.openWorkItemSession(item.id, {
                        sessionId: id,
                        ...(item.from?.messageId ? { messageId: item.from.messageId } : {}),
                      })
                    }
                  />
                  {item.from.external && <ExternalMark />}
                </dd>
              </div>
            )}
            <div>
              <dt>{COPY.created}</dt>
              <dd>
                <time dateTime={item.createdAt}>{dateTime(item.createdAt)}</time>
              </dd>
            </div>
            {item.closedAt && (
              <div>
                <dt>{COPY.completed}</dt>
                <dd>
                  <time dateTime={item.closedAt}>{dateTime(item.closedAt)}</time>
                </dd>
              </div>
            )}
          </dl>
        </aside>
        <div className="item-page-main">
          <ItemPrompt
            record={record}
            editable={canWrite && item.sessionIds.length === 0 && !closed}
            busy={busy}
            onSave={prompt => patch({ prompt })}
          />
          <section className="item-page-sessions" aria-label={COPY.sessions}>
            <header className="item-page-section-head">
              <h2>
                {COPY.sessions} <span className="item-page-count">{formatNumber(item.sessionIds.length)}</span>
              </h2>
              {canWrite && !closed && (
                <span className="item-page-section-actions">
                  <Button size="sm" variant="ghost" icon={PlusGlyph} disabled={busy || full} onClick={() => setJoining(true)}>
                    {COPY.addSession}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    icon={NewSessionGlyph}
                    disabled={!canStart || !record}
                    onClick={() => setStarting(true)}>
                    {item.sessionIds.length ? COPY.anotherSession : COPY.start}
                  </Button>
                </span>
              )}
            </header>
            {members.length > 0 ? (
              <ul className="item-page-rows">
                {members.map(({ id, task }) =>
                  task ? (
                    <SessionRow
                      key={id}
                      task={task}
                      shell={shell}
                      {...(canReadFiles ? { evidence: evidence.entries.get(task.id), itemId: item.id } : {})}
                      others={members.flatMap(other => (other.task && other.id !== id ? [other.task] : []))}
                      canWrite={canWrite}
                      bringing={bringing === id}
                      onOpen={openSession}
                      onBring={target => void bring(id, target)}
                      onLeave={() => void leave(id)}
                    />
                  ) : (
                    <li key={id} className="item-page-row" data-withheld="">
                      <LockGlyph size={12} aria-hidden="true" />
                      <span className="item-page-none">{COPY.unlisted}</span>
                    </li>
                  ),
                )}
              </ul>
            ) : (
              <div className="item-page-rows" data-empty="">
                <span className="work-board-empty-line" aria-hidden="true" />
              </div>
            )}
          </section>
          {outside.length > 0 && (
            <ul className="item-page-rows item-page-outside" aria-label={COPY.outside}>
              {outside.map(task => (
                <li key={task.id} className="item-page-row" data-outside="" data-work-session={task.id}>
                  <button type="button" className="item-page-row-main" onClick={() => openSession(task.id)}>
                    <MarkTile
                      mark={
                        shell.catalog?.harnesses.find(entry => entry.id === task.harnessId)?.capabilities.display.mark ?? task.harnessId
                      }
                      size={16}
                    />
                    <span className="item-page-row-title">{escapeSecurityText(task.title || BOARD_CARD_COPY.untitled)}</span>
                    <StatusWord className="item-page-row-state" tone="warn">
                      {COPY.outsideOne}
                    </StatusWord>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="item-page-thread">
            <ItemThread key={thread.scope} shell={shell} item={item} thread={thread} />
          </div>
        </div>
      </div>
      {tagging && (
        <SessionTagsDialog
          task={{ title: item.title, ...(item.tags ? { tags: item.tags } : {}) }}
          known={knownTags([...snapshot.tasks, ...(snapshot.items ?? [])])}
          phone={shell.phone}
          onClose={() => setTagging(false)}
          onSave={async tags => {
            if (!(await patch({ tags }))) throw new MessageError(COPY.notSaved)
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={COPY.deleteTask}
          danger
          confirmLabel={COPY.delete}
          message={COPY.confirmDelete(title)}
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            try {
              await api<unknown>(itemPath(itemId), { method: 'DELETE', body: { baseRevision: record?.revision ?? item.revision } })
            } catch (cause) {
              if (cause instanceof ApiError && cause.code === 'item-changed') void read()
              throw new MessageError(errorMessage(cause))
            }
            close()
            await shell.refresh()
          }}
        />
      )}
      {joining && (
        <ItemPagePick
          title={COPY.addSession}
          phone={shell.phone}
          empty={COPY.noSessionsToAdd}
          options={joinableSessions(snapshot).map(task => ({
            id: task.id,
            title: task.title || BOARD_CARD_COPY.untitled,
            mark: shell.catalog?.harnesses.find(entry => entry.id === task.harnessId)?.capabilities.display.mark ?? task.harnessId,
            meta: relativeTime(task.updatedAt, new Date(hostNow())),
          }))}
          onPick={join}
          onClose={() => setJoining(false)}
        />
      )}
      {starting && record && <ItemPageStart shell={shell} item={record} revision={item.revision} onClose={() => setStarting(false)} />}
    </section>
  )
}

/** The title, a button that turns into a field; Enter or leaving it saves, Esc puts it back. */
function ItemTitle({
  title,
  canEdit,
  busy,
  onSave,
}: {
  title: string
  canEdit: boolean
  busy: boolean
  onSave: (title: string) => Promise<boolean>
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const open = editing !== null
  useEffect(() => {
    if (open) input.current?.select()
  }, [open])
  const commit = async () => {
    const next = editing?.trim()
    if (!next || next === title) {
      setEditing(null)
      return
    }
    if (await onSave(next)) setEditing(null)
  }
  if (editing !== null)
    return (
      <input
        ref={input}
        className="item-page-title item-page-title-field"
        aria-label={COPY.title}
        value={editing}
        maxLength={WORK_ITEM_LIMITS.titleChars * 2}
        disabled={busy}
        onChange={event => setEditing(event.target.value.replace(/[\r\n]+/gu, ' '))}
        onBlur={() => void commit()}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setEditing(null)
          }
        }}
      />
    )
  return (
    <h1 className="item-page-title" title={title}>
      {canEdit ? (
        <button
          type="button"
          className="item-page-title-button"
          aria-label={COPY.editTitle(escapeSecurityText(title))}
          onClick={() => setEditing(title)}>
          <VisibleText text={title} />
        </button>
      ) : (
        <VisibleText text={title} />
      )}
    </h1>
  )
}

/** 要求: a field while the 待办 has no session, then read-only (the Host refuses a change). */
export function ItemPrompt({
  record,
  editable,
  busy,
  onSave,
}: {
  record: WorkItem | null
  editable: boolean
  busy: boolean
  onSave: (prompt: string) => Promise<boolean>
}) {
  const saved = record?.prompt ?? ''
  const [text, setText] = useState<string | null>(null)
  // Another device's change replaces what this one has not edited.
  const shown = text ?? saved
  const changed = text !== null && text !== saved
  return (
    <section className="item-page-prompt" aria-label={COPY.instructions}>
      <header className="item-page-section-head">
        <h2>{COPY.instructions}</h2>
        {editable && (
          <span className="item-page-section-actions">
            <Button
              size="sm"
              variant="primary"
              disabled={!changed || busy || Array.from(shown).length > WORK_ITEM_LIMITS.promptChars}
              onClick={() => {
                void onSave(shown).then(done => {
                  if (done) setText(null)
                })
              }}>
              {COPY.save}
            </Button>
          </span>
        )}
      </header>
      {record === null ? (
        <div className="item-page-prompt-text" data-loading="" aria-busy="true" />
      ) : editable ? (
        <TextAreaField
          label={COPY.instructions}
          className="item-page-prompt-field"
          value={shown}
          rows={6}
          disabled={busy}
          onChange={event => setText(event.target.value)}
        />
      ) : saved ? (
        <div className="item-page-prompt-text" data-readonly="">
          <VisibleText text={saved} />
        </div>
      ) : (
        <div className="item-page-prompt-text" data-readonly="" data-empty="">
          <span className="item-page-none">{COPY.none}</span>
        </div>
      )}
    </section>
  )
}

/** One session of the 待办: its Harness, title, the Host's state for it, branch; 打开, 带过去 and 移出 on its menu. */
function SessionRow({
  task,
  shell,
  itemId,
  evidence,
  others,
  canWrite,
  bringing,
  onOpen,
  onBring,
  onLeave,
}: {
  task: TaskSummary
  shell: ShellState
  itemId?: string
  evidence?: WorkbenchDeliveryEntry | undefined
  others: TaskSummary[]
  canWrite: boolean
  bringing: boolean
  onOpen: (id: string) => void
  onBring: (targetId: string) => void
  onLeave: () => void
}) {
  const connected = shell.connection === 'connected'
  const live = task.status === 'running' || task.status === 'waiting-approval'
  useTicker(connected && live ? 'second' : 'minute')
  const now = hostNow()
  const stopping = shell.stopping.has(task.id) || task.live?.activity === 'cancelling'
  const state = cardState(task, { connected, now, stopping, sharedFolder: false })
  const harness = shell.catalog?.harnesses.find(entry => entry.id === task.harnessId)
  const title = escapeSecurityText(task.title || BOARD_CARD_COPY.untitled)
  const branch = task.worktree ? (task.branch ?? task.worktree.branch) : task.branch
  const marked = shell.selectedId === task.id
  const sections: MenuSection[] = [
    { id: 'open', items: [{ id: 'open', label: COPY.openInChat, icon: MessageGlyph, onSelect: () => onOpen(task.id) }] },
    ...(canWrite && others.length
      ? [
          {
            id: 'bring',
            label: COPY.bring,
            items: others.map(other => ({
              id: `bring-${other.id}`,
              label: escapeSecurityText(other.title || BOARD_CARD_COPY.untitled),
              icon: TextQuote,
              onSelect: () => onBring(other.id),
            })),
          },
        ]
      : []),
    ...(canWrite ? [{ id: 'leave', items: [{ id: 'leave', label: COPY.removeSession, icon: UndoGlyph, onSelect: onLeave }] }] : []),
  ]
  return (
    <li
      className="item-page-row item-page-session"
      data-work-session={task.id}
      data-tone={state.tone}
      data-marked={marked ? '' : undefined}>
      <div className="item-page-session-line">
        <button type="button" className="item-page-row-main" aria-current={marked ? 'true' : undefined} onClick={() => onOpen(task.id)}>
          <MarkTile
            mark={harness?.capabilities.display.mark ?? task.harnessId}
            size={16}
            label={harness ? harnessName(harness) : undefined}
          />
          <span className="item-page-row-title">{title}</span>
          <StatusWord className="item-page-row-state" tone={state.tone}>
            {state.words}
          </StatusWord>
          {branch && (
            <span className="item-page-row-branch">
              {task.worktree && <FolderGit2 size={12} aria-label={COPY.worktree} />}
              <BranchName branch={branch} title />
            </span>
          )}
          <time dateTime={task.updatedAt}>{relativeTime(task.updatedAt, new Date(now))}</time>
        </button>
        <span className="item-page-row-actions">
          {canWrite && others.length > 0 && (
            <Menu
              label={COPY.bringReply(title)}
              placement="bottom-end"
              sections={[
                {
                  id: 'targets',
                  label: COPY.bringTo,
                  items: others.map(other => ({
                    id: `bring-${other.id}`,
                    label: escapeSecurityText(other.title || BOARD_CARD_COPY.untitled),
                    onSelect: () => onBring(other.id),
                  })),
                },
              ]}
              trigger={props => (
                <Button
                  {...props}
                  className="item-page-row-bring"
                  size="xs"
                  variant="ghost"
                  icon={TextQuote}
                  loading={bringing}
                  disabled={bringing}>
                  {COPY.bring}
                </Button>
              )}
            />
          )}
          <Menu
            label={COPY.sessionActions(title)}
            placement="bottom-end"
            context={rowOf('.item-page-row')}
            sections={sections}
            trigger={props => (
              <IconButton {...props} size="xs" label={BOARD_CARD_COPY.moreFor(title)} tooltip={BOARD_CARD_COPY.more} icon={MoreGlyph} />
            )}
          />
        </span>
      </div>
      {itemId && <ItemEvidence itemId={itemId} task={task} entry={evidence} shell={shell} />}
    </li>
  )
}
