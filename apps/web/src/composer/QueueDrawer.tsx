import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PromptQueueItem } from '@latch/protocol'
import { ArrowDown, ArrowUp, CornerDownRight, GripVertical } from 'lucide-react'
import { Button, Collapse, Dialog, Drawer, EditGlyph, IconButton, InlineNotice, Menu, MOTION, TextAreaField, TrashGlyph } from '@latch/ui'
import { api, inlineError } from '../core/api.ts'
import { defineCopy, formatNumber } from '../core/i18n.ts'
import { VisibleText, escapeHiddenCharacters } from '../components/VisibleText.tsx'

const COPY = defineCopy(
  {
    editTitle: '编辑排队内容',
    cancel: '取消',
    save: '保存',
    message: '排队消息',
    paused: '已暂停 · 请确认后发送',
    deliveryUnknown: '发送结果未确认',
    checkQueue: '未发送 · 请检查排队内容',
    next: (count: number) => `接下来 · ${formatNumber(count)}`,
    removedUnknown: '排队项已移除；此前的发送结果仍未确认，请核对会话记录。',
    queue: '排队发送',
    notSent: (reason: string) => `未发送：${reason}`,
    changed: '权限或会话已变化',
    send: '发送',
    steer: '追加到本轮',
    add: '追加',
    order: '调整顺序',
    up: '上移',
    down: '下移',
    edit: '编辑',
    remove: '移除',
  },
  {
    editTitle: 'Edit queued message',
    cancel: 'Cancel',
    save: 'Save',
    message: 'Queued message',
    paused: 'Paused · Confirm to send',
    deliveryUnknown: 'Delivery unconfirmed',
    checkQueue: 'Unsent · Review the queue',
    next: (count: number) => `Up next · ${formatNumber(count)}`,
    removedUnknown: 'Removed from the queue. The earlier send is still unconfirmed. Check the conversation.',
    queue: 'Queued messages',
    notSent: (reason: string) => `Unsent · ${reason}`,
    changed: 'Permissions or session changed',
    send: 'Send',
    steer: 'Add to this turn',
    add: 'Add',
    order: 'Reorder',
    up: 'Move up',
    down: 'Move down',
    edit: 'Edit',
    remove: 'Remove',
  },
)

function QueueRow({ open, arrived, children }: { open: boolean; arrived: boolean; children: ReactNode }) {
  const [entered, setEntered] = useState(!arrived)
  useEffect(() => {
    if (entered) return undefined
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [entered])
  return (
    <li aria-hidden={!open || undefined}>
      <Collapse open={open && entered}>{children}</Collapse>
    </li>
  )
}

/** Retain removed rows only for the shared 140ms disclosure exit; their controls are already inert. */
function QueueRows({
  items,
  arrive,
  render,
}: {
  items: PromptQueueItem[]
  arrive: boolean
  render(item: PromptQueueItem, index: number): ReactNode
}) {
  const [previous, setPrevious] = useState(items)
  const [rows, setRows] = useState(() => items.map(item => ({ item, open: true, arrived: arrive })))
  if (previous !== items) {
    setPrevious(items)
    const merged = items.map(item => ({ item, open: true, arrived: rows.find(row => row.item.id === item.id)?.arrived ?? true }))
    rows.forEach((row, index) => {
      if (!items.some(item => item.id === row.item.id)) merged.splice(index, 0, { ...row, open: false })
    })
    setRows(merged)
  }
  const leaving = rows
    .filter(row => !row.open)
    .map(row => row.item.id)
    .join(',')
  useEffect(() => {
    if (!leaving) return undefined
    const timer = setTimeout(() => setRows(current => current.filter(row => row.open)), MOTION.panelExit)
    return () => clearTimeout(timer)
  }, [leaving])
  return (
    <ol>
      {rows.map(row => (
        <QueueRow key={row.item.id} open={row.open} arrived={row.arrived}>
          {render(
            row.item,
            items.findIndex(item => item.id === row.item.id),
          )}
        </QueueRow>
      ))}
    </ol>
  )
}

function QueueEditor({
  item,
  writable,
  save,
  close,
}: {
  item: PromptQueueItem
  writable: boolean
  save(text: string): Promise<void>
  close(): void
}) {
  const form = useId()
  const [text, setText] = useState(item.text),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  return (
    <Dialog
      open
      title={COPY.editTitle}
      size="lg"
      onClose={() => {
        if (!busy) close()
      }}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            {COPY.cancel}
          </Button>
          <Button variant="primary" form={form} type="submit" loading={busy} disabled={!writable || !text.trim() || text === item.text}>
            {COPY.save}
          </Button>
        </>
      }>
      <form
        id={form}
        className="queue-edit-form"
        onSubmit={event => {
          event.preventDefault()
          event.stopPropagation()
          if (busy || !writable || !text.trim()) return
          setBusy(true)
          setError('')
          void save(text.trim()).then(close, error => {
            setError(inlineError(error))
            setBusy(false)
          })
        }}>
        <TextAreaField label={COPY.message} value={text} rows={5} maxLength={16_000} onChange={event => setText(event.target.value)} />
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
      </form>
    </Dialog>
  )
}

/** Queue contents come from the Host; actions use each item's stable identity even after an uncertain response. */
export function QueueDrawer({
  sessionId,
  items,
  canSend,
  canRemove,
  queueControl,
  steerRunId,
  running,
  onRemovedUnknown,
  onChanged,
}: {
  sessionId: string
  items: PromptQueueItem[]
  canSend: boolean
  canRemove: boolean
  queueControl: boolean
  steerRunId?: string | undefined
  running: boolean
  onRemovedUnknown(message: string): void
  onChanged(): Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null),
    [editing, setEditing] = useState<PromptQueueItem | null>(null),
    [notice, setNotice] = useState<{ cause: unknown }>()
  const changing = useRef(false)
  const [drag, setDrag] = useState<{ id: string; order: string[]; revision: number; target?: string } | null>(null)
  const canOrder = queueControl && canSend && items.length > 1 && items.every(item => !item.delivery)
  const queuePath = `tasks/${encodeURIComponent(sessionId)}/queue`
  const [empty, setEmpty] = useState(items.length === 0)
  const [opening, setOpening] = useState(0)
  if (empty !== (items.length === 0)) {
    setEmpty(items.length === 0)
    if (items.length) setOpening(current => current + 1)
  }
  const paused = items.some(item => item.state !== 'waiting')
  const heading = items.some(item => item.delivery === 'steer-unknown' || item.delivery === 'uncertain')
    ? COPY.deliveryUnknown
    : items.some(item => item.state === 'parked')
      ? COPY.paused
      : items.some(item => item.state === 'dropped')
        ? COPY.checkQueue
        : COPY.next(items.length)
  const error = notice && inlineError(notice.cause)
  const change = async (id: string, write: () => Promise<unknown>) => {
    if (changing.current) return
    changing.current = true
    setBusy(id)
    setNotice(undefined)
    try {
      await write()
    } catch (cause) {
      setNotice({ cause })
    }
    try {
      // A lost response or another device's reorder may already have changed the authoritative list.
      await onChanged()
    } catch (cause) {
      setNotice(previous => previous ?? { cause })
    } finally {
      changing.current = false
      setBusy(null)
    }
  }
  const move = (id: string, target: string, baseOrder = items.map(item => item.id), baseRevision = items[0]?.orderRevision ?? 0) => {
    if (!canOrder || changing.current || id === target) return
    const from = baseOrder.indexOf(id),
      to = baseOrder.indexOf(target)
    if (from < 0 || to < 0) return
    const order = baseOrder.slice()
    order.splice(from, 1)
    order.splice(to, 0, id)
    void change(id + '/order', () => api(queuePath, { method: 'PUT', body: { baseOrder, order, baseRevision } }))
  }
  return (
    <>
      {/* Rows enter after the ancestor is open; reopening a skipped until-found subtree can freeze its transitions. */}
      <Collapse key={opening} open={items.length > 0}>
        <Drawer className="prompt-queue" label={COPY.queue} data-paused={paused ? '' : undefined}>
          <p className="prompt-queue-title" role="status">
            {heading}
          </p>
          <QueueRows
            items={items}
            arrive={opening > 0}
            render={(item, index) => {
              const itemPath = `${queuePath}/${encodeURIComponent(item.id)}`
              const canSteer = queueControl && !!steerRunId && item.canSteer && !item.delivery && item.state !== 'dropped'
              const canResume = !running && index === 0 && item.state === 'parked' && item.delivery !== 'steer-unknown'
              const neighbors = [
                { target: items[index - 1], label: COPY.up, icon: ArrowUp },
                { target: items[index + 1], label: COPY.down, icon: ArrowDown },
              ]
              return (
                <div
                  className="prompt-queue-row"
                  data-drop={
                    drag?.target === item.id && drag.id !== item.id ? (index < drag.order.indexOf(drag.id) ? 'before' : 'after') : undefined
                  }
                  onDragOver={event => {
                    if (!drag || !canOrder || index < 0) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    if (drag.target !== item.id) setDrag({ ...drag, target: item.id })
                  }}
                  onDrop={event => {
                    if (!drag || index < 0) return
                    event.preventDefault()
                    event.stopPropagation()
                    move(drag.id, item.id, drag.order, drag.revision)
                    setDrag(null)
                  }}>
                  {canOrder && index >= 0 && (
                    <Menu
                      label={COPY.order}
                      trigger={props => (
                        <IconButton
                          {...props}
                          className="prompt-queue-grip"
                          label={COPY.order}
                          icon={GripVertical}
                          size="xs"
                          disabled={busy !== null}
                          draggable={busy === null}
                          onDragStart={event => {
                            if (changing.current) {
                              event.preventDefault()
                              return
                            }
                            event.dataTransfer.setData('application/x-latch-queue-item', item.id)
                            event.dataTransfer.effectAllowed = 'move'
                            setDrag({ id: item.id, order: items.map(entry => entry.id), revision: items[0]?.orderRevision ?? 0 })
                          }}
                          onDragEnd={() => setDrag(null)}
                        />
                      )}
                      sections={[
                        {
                          id: 'order',
                          items: neighbors.flatMap(({ target, label, icon }) =>
                            target ? [{ id: target.id, label, icon, onSelect: () => move(item.id, target.id) }] : [],
                          ),
                        },
                      ]}
                    />
                  )}
                  <span className="prompt-queue-text" title={escapeHiddenCharacters(item.text)}>
                    <VisibleText text={item.text} />
                    {item.state === 'dropped' && (
                      <span className="prompt-queue-reason">
                        <VisibleText text={COPY.notSent(item.reason ?? COPY.changed)} />
                      </span>
                    )}
                    {(item.state === 'parked' || item.delivery === 'sending') && item.reason && (
                      <span className="prompt-queue-reason">
                        <VisibleText text={item.reason} />
                      </span>
                    )}
                  </span>
                  <span className="prompt-queue-actions">
                    {(canSteer || canResume) && canSend && (
                      <Button
                        size="xs"
                        variant={canSteer ? 'ghost' : 'primary'}
                        icon={canSteer ? CornerDownRight : undefined}
                        aria-label={canSteer ? COPY.steer : COPY.send}
                        loading={busy === itemPath}
                        disabled={busy !== null}
                        onClick={() => {
                          void change(itemPath, () =>
                            canSteer
                              ? api(itemPath + '/steer', {
                                  method: 'POST',
                                  body: { runId: steerRunId, contentRevision: item.contentRevision ?? 0 },
                                })
                              : api(itemPath + '/send', { method: 'POST' }),
                          )
                        }}>
                        {canSteer ? COPY.add : COPY.send}
                      </Button>
                    )}
                    {canSend && item.state !== 'dropped' && !item.delivery && (
                      <IconButton size="xs" label={COPY.edit} icon={EditGlyph} disabled={busy !== null} onClick={() => setEditing(item)} />
                    )}
                    {canRemove && (
                      <IconButton
                        size="xs"
                        icon={TrashGlyph}
                        label={COPY.remove}
                        busy={busy === item.id + '/remove'}
                        disabled={busy !== null}
                        onClick={() => {
                          void change(item.id + '/remove', async () => {
                            const result = await api<{ deliveryUnknown?: boolean }>(itemPath, { method: 'DELETE' })
                            if (result.deliveryUnknown) onRemovedUnknown(COPY.removedUnknown)
                          })
                        }}
                      />
                    )}
                  </span>
                </div>
              )
            }}
          />
          {error && <InlineNotice tone="warn">{error}</InlineNotice>}
        </Drawer>
      </Collapse>
      {editing
        && createPortal(
          <QueueEditor
            key={editing.id}
            item={editing}
            writable={canSend && items.some(item => item.id === editing.id && item.state !== 'dropped' && !item.delivery)}
            close={() => setEditing(null)}
            save={async text => {
              await api(`tasks/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(editing.id)}`, {
                method: 'PATCH',
                body: { text },
              })
              await onChanged()
            }}
          />,
          document.body,
        )}
    </>
  )
}
