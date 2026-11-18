import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
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
import { dateTime, relativeTime } from '../format.ts'
import { useBackLayer } from '../hooks/backStack.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { useWorkbenchDelivery } from '../shell/useWorkbenchEvidence.ts'
import { closeItemPage } from './itemPage.ts'
import { ItemPagePick } from './ItemPagePick.tsx'
import { ItemPageStart } from './ItemPageStart.tsx'
import { bringReply, joinableSessions, placeWords } from './items.ts'
import { PRIORITY_LABELS } from './model.ts'
import { cardState, TagChips } from './WorkBoardCard.tsx'
import { ExternalMark, ProposedBy } from './WorkBoardProposalCard.tsx'
import { ItemEvidence } from './ItemEvidence.tsx'

const PLACE_TONE: Record<WorkItemSummary['board']['group'], StatusTone> = {
  todo: 'neutral',
  attention: 'waiting',
  running: 'running',
  deliver: 'neutral',
  done: 'neutral',
}
const PRIORITIES = (['high', 'mid', 'low'] as const).map(value => ({ value, label: PRIORITY_LABELS[value] }))
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
 * board. `thread` is where its discussion goes (package H); nothing is drawn there before it.
 */
export function ItemPage({ shell, itemId, thread }: { shell: ShellState; itemId: string; thread?: ReactNode }) {
  const { snapshot } = shell
  const item = snapshot.items?.find(entry => entry.id === itemId)
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
  /** Sessions this page started: one the Host could not put in the 待办 (it filled up meanwhile) stays in view as such. */
  const [started, setStarted] = useState<string[]>([])
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
      if (done === 'empty') shell.setToast({ text: '这个会话还没有回复', tone: 'error' })
    } catch (cause) {
      fail(cause)
    } finally {
      setBringing(null)
    }
  }

  if (!item) return null
  const closed = item.closedAt !== undefined
  const members = item.sessionIds.map(id => ({ id, task: snapshot.tasks.find(task => task.id === id) }))
  const full = item.sessionIds.length >= WORK_ITEM_LIMITS.sessions
  const outside = started.flatMap(id => {
    const task = snapshot.tasks.find(entry => entry.id === id)
    return task && !item.sessionIds.includes(id) && !snapshot.items?.some(other => other.sessionIds.includes(id)) ? [task] : []
  })
  const canStart = canWrite && !closed && !full && shell.homeComposerState.gate.kind === 'open'
  const project = item.projectId ? shell.catalog?.workspaces.find(entry => entry.id === item.projectId) : undefined
  const harness = item.harnessId ? shell.catalog?.harnesses.find(entry => entry.id === item.harnessId) : undefined
  const title = escapeSecurityText(item.title)
  const menu: MenuSection[] = canWrite
    ? [{ id: 'danger', items: [{ id: 'delete', label: '删除待办', icon: TrashGlyph, danger: true, onSelect: () => setDeleting(true) }] }]
    : []

  return (
    <section ref={root} className="item-page" aria-label={`待办：${title}`} data-item-id={item.id} data-closed={closed ? '' : undefined}>
      <header className="item-page-head">
        <Button className="item-page-back" variant="ghost" size="sm" icon={ChevronLeftGlyph} onClick={close}>
          看板
        </Button>
        <ItemTitle title={item.title} canEdit={canWrite} busy={busy} onSave={next => patch({ title: next })} />
        <div className="item-page-head-actions">
          {canWrite
            && (closed ? (
              <Button size="sm" variant="outline" icon={UndoGlyph} disabled={busy} onClick={() => void patch({ closed: false })}>
                重新打开
              </Button>
            ) : (
              <Button size="sm" variant="outline" icon={CheckGlyph} disabled={busy} onClick={() => void patch({ closed: true })}>
                完成
              </Button>
            ))}
          {menu.length > 0 && (
            <Menu
              label="待办操作"
              placement="bottom-end"
              sections={menu}
              trigger={props => <IconButton {...props} size="sm" label="待办操作" icon={MoreGlyph} />}
            />
          )}
        </div>
      </header>
      <div className="item-page-body">
        <aside className="item-page-facts" aria-label="属性" data-facts-open={factsOpen ? '' : undefined}>
          <dl>
            <div>
              <dt>状态</dt>
              <dd className="item-page-fact-status">
                <StatusWord tone={closed ? 'neutral' : PLACE_TONE[item.board.group]}>{placeWords(item.board)}</StatusWord>
                {item.board.postId && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      const post = root.current?.querySelector<HTMLElement>(`[data-post-id="${CSS.escape(item.board.postId!)}"]`)
                      if (!post) return
                      post.scrollIntoView({ block: 'nearest' })
                      post.querySelector<HTMLElement>('.item-thread-action, .item-thread-post-state button')?.focus({ preventScroll: true })
                    }}>
                    查看发言
                  </Button>
                )}
              </dd>
            </div>
          </dl>
          <FoldHeader className="item-page-facts-toggle" open={factsOpen} onOpenChange={setFactsOpen} aria-controls={factsId}>
            待办属性
          </FoldHeader>
          <dl className="item-page-facts-details" id={factsId}>
            <div>
              <dt>项目</dt>
              <dd>{project ? escapeSecurityText(project.name) : '无项目'}</dd>
            </div>
            {item.harnessId && (
              <div>
                <dt>Harness</dt>
                <dd className="item-page-fact-harness">
                  <MarkTile mark={harness?.capabilities.display.mark ?? item.harnessId} size={14} />
                  <span>{escapeSecurityText(harness?.capabilities.display.label ?? item.harnessId)}</span>
                </dd>
              </div>
            )}
            <div>
              <dt>标签</dt>
              <dd className="item-page-fact-tags">
                {item.tags?.length ? <TagChips tags={item.tags} /> : <span className="item-page-none">无</span>}
                {canWrite && <IconButton size="xs" label="编辑标签" icon={EditGlyph} disabled={busy} onClick={() => setTagging(true)} />}
              </dd>
            </div>
            <div>
              <dt>优先级</dt>
              <dd>
                <SegmentedControl
                  size="xs"
                  label="优先级"
                  value={item.priority ?? 'mid'}
                  options={PRIORITIES}
                  disabled={!canWrite || busy}
                  onValueChange={(value: BoardPriority | 'mid') => {
                    if (value !== (item.priority ?? 'mid')) void patch({ priority: value })
                  }}
                />
              </dd>
            </div>
            {item.note && (
              <div>
                <dt>备注</dt>
                <dd>{escapeSecurityText(item.note)}</dd>
              </div>
            )}
            {item.from && (
              <div>
                <dt>来自</dt>
                <dd className="work-board-proposal-line">
                  <ProposedBy
                    proposal={{ from: item.from }}
                    shell={shell}
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
              <dt>创建</dt>
              <dd>
                <time dateTime={item.createdAt}>{dateTime(item.createdAt)}</time>
              </dd>
            </div>
            {item.closedAt && (
              <div>
                <dt>完成</dt>
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
          <section className="item-page-sessions" aria-label="会话">
            <header className="item-page-section-head">
              <h2>
                会话 <span className="item-page-count">{item.sessionIds.length}</span>
              </h2>
              {canWrite && !closed && (
                <span className="item-page-section-actions">
                  <Button size="sm" variant="ghost" icon={PlusGlyph} disabled={busy || full} onClick={() => setJoining(true)}>
                    加入会话
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    icon={NewSessionGlyph}
                    disabled={!canStart || !record}
                    onClick={() => setStarting(true)}>
                    {item.sessionIds.length ? '再开一个' : '开始'}
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
                      <span className="item-page-none">不在列表中</span>
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
            <ul className="item-page-rows item-page-outside" aria-label="未加入的会话">
              {outside.map(task => (
                <li key={task.id} className="item-page-row" data-outside="" data-work-session={task.id}>
                  <button type="button" className="item-page-row-main" onClick={() => openSession(task.id)}>
                    <MarkTile
                      mark={
                        shell.catalog?.harnesses.find(entry => entry.id === task.harnessId)?.capabilities.display.mark ?? task.harnessId
                      }
                      size={16}
                    />
                    <span className="item-page-row-title">{escapeSecurityText(task.title || '未命名会话')}</span>
                    <StatusWord className="item-page-row-state" tone="warn">
                      未加入
                    </StatusWord>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* The discussion with @ (package H) takes this place; nothing is drawn before it. */}
          {thread !== undefined && <div className="item-page-thread">{thread}</div>}
        </div>
      </div>
      {tagging && (
        <SessionTagsDialog
          task={{ title: item.title, ...(item.tags ? { tags: item.tags } : {}) }}
          known={knownTags([...snapshot.tasks, ...(snapshot.items ?? [])])}
          phone={shell.phone}
          onClose={() => setTagging(false)}
          onSave={async tags => {
            if (!(await patch({ tags }))) throw new MessageError('没有保存，请重试。')
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除待办"
          danger
          confirmLabel="删除"
          message={`删除「${title}」？它的会话保留。`}
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
          title="加入会话"
          phone={shell.phone}
          empty="没有可加入的会话"
          options={joinableSessions(snapshot).map(task => ({
            id: task.id,
            title: task.title || '未命名会话',
            mark: shell.catalog?.harnesses.find(entry => entry.id === task.harnessId)?.capabilities.display.mark ?? task.harnessId,
            meta: relativeTime(task.updatedAt, new Date(hostNow())),
          }))}
          onPick={join}
          onClose={() => setJoining(false)}
        />
      )}
      {starting && record && (
        <ItemPageStart
          shell={shell}
          item={record}
          revision={item.revision}
          onStarted={sessionId => setStarted(previous => [...previous, sessionId])}
          onClose={() => setStarting(false)}
        />
      )}
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
        aria-label="标题"
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
          aria-label={`标题：${escapeSecurityText(title)}，编辑`}
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
    <section className="item-page-prompt" aria-label="要求">
      <header className="item-page-section-head">
        <h2>要求</h2>
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
              保存
            </Button>
          </span>
        )}
      </header>
      {record === null ? (
        <div className="item-page-prompt-text" data-loading="" aria-busy="true" />
      ) : editable ? (
        <TextAreaField
          label="要求"
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
          <span className="item-page-none">无</span>
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
  const title = escapeSecurityText(task.title || '未命名会话')
  const branch = task.worktree ? (task.branch ?? task.worktree.branch) : task.branch
  const marked = shell.selectedId === task.id
  const sections: MenuSection[] = [
    { id: 'open', items: [{ id: 'open', label: '在对话中打开', icon: MessageGlyph, onSelect: () => onOpen(task.id) }] },
    ...(canWrite && others.length
      ? [
          {
            id: 'bring',
            label: '带过去',
            items: others.map(other => ({
              id: `bring-${other.id}`,
              label: escapeSecurityText(other.title || '未命名会话'),
              icon: TextQuote,
              onSelect: () => onBring(other.id),
            })),
          },
        ]
      : []),
    ...(canWrite ? [{ id: 'leave', items: [{ id: 'leave', label: '移出待办', icon: UndoGlyph, onSelect: onLeave }] }] : []),
  ]
  return (
    <li
      className="item-page-row item-page-session"
      data-work-session={task.id}
      data-tone={state.tone}
      data-marked={marked ? '' : undefined}>
      <div className="item-page-session-line">
        <button type="button" className="item-page-row-main" aria-current={marked ? 'true' : undefined} onClick={() => onOpen(task.id)}>
          <MarkTile mark={harness?.capabilities.display.mark ?? task.harnessId} size={16} label={harness?.capabilities.display.label} />
          <span className="item-page-row-title">{title}</span>
          <StatusWord className="item-page-row-state" tone={state.tone}>
            {state.words}
          </StatusWord>
          {branch && (
            <span className="item-page-row-branch">
              {task.worktree && <FolderGit2 size={12} aria-label="工作树" />}
              <span>{escapeSecurityText(branch)}</span>
            </span>
          )}
          <time dateTime={task.updatedAt}>{relativeTime(task.updatedAt, new Date(now))}</time>
        </button>
        <span className="item-page-row-actions">
          {canWrite && others.length > 0 && (
            <Menu
              label={`带过去：${title}`}
              placement="bottom-end"
              sections={[
                {
                  id: 'targets',
                  label: '带到',
                  items: others.map(other => ({
                    id: `bring-${other.id}`,
                    label: escapeSecurityText(other.title || '未命名会话'),
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
                  带过去
                </Button>
              )}
            />
          )}
          <Menu
            label={`会话操作：${title}`}
            placement="bottom-end"
            context={rowOf('.item-page-row')}
            sections={sections}
            trigger={props => <IconButton {...props} size="xs" label={`更多操作：${title}`} tooltip="更多操作" icon={MoreGlyph} />}
          />
        </span>
      </div>
      {itemId && <ItemEvidence itemId={itemId} task={task} entry={evidence} shell={shell} />}
    </li>
  )
}
