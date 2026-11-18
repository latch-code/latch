import { useEffect, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PromptQueueItem } from '@latch/protocol'
import { Button, Collapse, Dialog, Drawer, InlineNotice, MOTION, TextAreaField } from '@latch/ui'
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
    checkQueue: '未发送 · 请检查排队内容',
    next: (count: number) => `接下来 · ${formatNumber(count)}`,
    removedUnknown: '排队项已移除；此前的发送结果仍未确认，请核对会话记录。',
    queue: '排队发送',
    notSent: (reason: string) => `未发送：${reason}`,
    changed: '权限或会话已变化',
    send: '发送',
    edit: '编辑',
    remove: '移除',
  },
  {
    editTitle: 'Edit queued message',
    cancel: 'Cancel',
    save: 'Save',
    message: 'Queued message',
    paused: 'Paused · Confirm to send',
    checkQueue: 'Unsent · Review the queue',
    next: (count: number) => `Up next · ${formatNumber(count)}`,
    removedUnknown: 'Removed from the queue. The earlier send is still unconfirmed. Check the conversation.',
    queue: 'Queued messages',
    notSent: (reason: string) => `Unsent · ${reason}`,
    changed: 'Permissions or session changed',
    send: 'Send',
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
      <Collapse open={open && entered}>
        <div className="prompt-queue-row">{children}</div>
      </Collapse>
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
    const incoming = new Map(items.map(item => [item.id, item]))
    const merged = rows.map(row => ({ ...row, item: incoming.get(row.item.id) ?? row.item, open: incoming.has(row.item.id) }))
    for (const item of items) if (!rows.some(row => row.item.id === item.id)) merged.push({ item, open: true, arrived: true })
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

function QueueEditor({ item, save, close }: { item: PromptQueueItem; save(text: string): Promise<void>; close(): void }) {
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
          <Button variant="primary" form={form} type="submit" loading={busy} disabled={!text.trim() || text === item.text}>
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
          if (busy || !text.trim()) return
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
  onChanged,
}: {
  sessionId: string
  items: PromptQueueItem[]
  canSend: boolean
  canRemove: boolean
  onChanged(): Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null),
    [editing, setEditing] = useState<PromptQueueItem | null>(null),
    [notice, setNotice] = useState<{ cause: unknown } | 'delivery-unknown'>()
  const [empty, setEmpty] = useState(items.length === 0)
  const [opening, setOpening] = useState(0)
  if (empty !== (items.length === 0)) {
    setEmpty(items.length === 0)
    if (items.length) setOpening(current => current + 1)
  }
  const paused = items.some(item => item.state !== 'waiting')
  const heading = items.some(item => item.state === 'parked')
    ? COPY.paused
    : items.some(item => item.state === 'dropped')
      ? COPY.checkQueue
      : COPY.next(items.length)
  const error = notice === 'delivery-unknown' ? COPY.removedUnknown : notice && inlineError(notice.cause)
  const change = async (item: PromptQueueItem, action: 'send' | 'remove') => {
    if (busy) return
    setBusy(item.id)
    setNotice(undefined)
    try {
      const result = await api<{ deliveryUnknown?: boolean }>(
        `tasks/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(item.id)}${action === 'send' ? '/send' : ''}`,
        { method: action === 'send' ? 'POST' : 'DELETE' },
      )
      if (result.deliveryUnknown) setNotice('delivery-unknown')
      await onChanged()
    } catch (cause) {
      setNotice({ cause })
    } finally {
      setBusy(null)
    }
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
            render={(item, index) => (
              <>
                <span className="prompt-queue-text" title={escapeHiddenCharacters(item.text)}>
                  <VisibleText text={item.text} />
                  {item.state === 'dropped' && (
                    <span className="prompt-queue-reason">
                      <VisibleText text={COPY.notSent(item.reason ?? COPY.changed)} />
                    </span>
                  )}
                  {item.state === 'parked' && item.reason && (
                    <span className="prompt-queue-reason">
                      <VisibleText text={item.reason} />
                    </span>
                  )}
                </span>
                <span className="prompt-queue-actions">
                  {index === 0 && item.state === 'parked' && canSend && (
                    <Button
                      size="xs"
                      variant="primary"
                      loading={busy === item.id}
                      disabled={busy !== null}
                      onClick={() => {
                        void change(item, 'send')
                      }}>
                      {COPY.send}
                    </Button>
                  )}
                  {canSend && item.state !== 'dropped' && (
                    <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => setEditing(item)}>
                      {COPY.edit}
                    </Button>
                  )}
                  {canRemove && (
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={busy === item.id}
                      disabled={busy !== null}
                      onClick={() => {
                        void change(item, 'remove')
                      }}>
                      {COPY.remove}
                    </Button>
                  )}
                </span>
              </>
            )}
          />
          {error && <InlineNotice tone="warn">{error}</InlineNotice>}
        </Drawer>
      </Collapse>
      {editing
        && createPortal(
          <QueueEditor
            key={editing.id}
            item={editing}
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
