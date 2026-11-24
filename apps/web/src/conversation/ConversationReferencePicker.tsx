import { useEffect, useRef, useState } from 'react'
import type { TaskSummary } from '@latch/protocol'
import { Button, InlineNotice, Modal, ModalHeader, SearchField } from '@latch/ui'
import { api, errorMessage, newRequestId } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { privateSession } from '../handoffs/model.ts'

export const REFERENCE_COPY = defineCopy(
  {
    title: '引用另一条会话',
    previous: '这台设备已授权的引用',
    revoke: '撤销',
    find: '搜索会话标题',
    empty: '没有可引用的会话',
    untitled: '未命名会话',
    scope: '发送后，Agent 可以按需读取所选会话最近 128 条已有消息的文字。',
  },
  {
    title: 'Reference a conversation',
    previous: 'References authorized from this device',
    revoke: 'Revoke',
    find: 'Search conversation titles',
    empty: 'No conversations available',
    untitled: 'Untitled conversation',
    scope: 'After sending, the agent can read the text of up to 128 recent messages that already exist in this conversation.',
  },
)

export function ConversationReferencePicker({
  target,
  tasks,
  phone,
  close,
  select,
}: {
  target: TaskSummary
  tasks: readonly TaskSummary[]
  phone: boolean
  close(): void
  select(reference: string, title: string): void
}) {
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const flight = useRef(false)
  const active = useRef(false)
  const requests = useRef(new Map<string, string>())
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const [previous, setPrevious] = useState<Array<{ reference: string; source?: string }>>([])
  const path = `tasks/${encodeURIComponent(target.id)}/conversation-references`
  useEffect(() => {
    let current = true
    void api<{ references: typeof previous }>(path).then(
      ({ references }) => {
        if (current) setPrevious(references)
      },
      cause => {
        if (current) setError(errorMessage(cause))
      },
    )
    return () => {
      current = false
    }
  }, [path])
  const revoke = async (reference: string) => {
    if (flight.current) return
    flight.current = true
    setBusy(true)
    try {
      await api(path, { method: 'DELETE', body: { reference } })
      if (active.current) setPrevious(list => list.filter(item => item.reference !== reference))
    } catch (cause) {
      if (active.current) setError(errorMessage(cause))
    } finally {
      flight.current = false
      if (active.current) setBusy(false)
    }
  }
  const sources = tasks.filter(
    task =>
      task.id !== target.id
      && (!(privateSession(task) || task.personal) || privateSession(target))
      && (task.title ?? '').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  )
  const choose = async (source: TaskSummary) => {
    if (flight.current) return
    flight.current = true
    setBusy(true)
    setError('')
    const requestId = requests.current.get(source.id) ?? newRequestId()
    requests.current.set(source.id, requestId)
    try {
      const { reference } = await api<{ reference: string }>(`tasks/${encodeURIComponent(target.id)}/conversation-references`, {
        method: 'POST',
        body: { requestId, source: source.id },
      })
      if (active.current) select(reference, source.title || REFERENCE_COPY.untitled)
    } catch (cause) {
      if (active.current) setError(errorMessage(cause))
    } finally {
      flight.current = false
      if (active.current) setBusy(false)
    }
  }
  return (
    <Modal label={REFERENCE_COPY.title} onClose={close} variant={phone ? 'sheet' : 'dialog'}>
      <ModalHeader title={REFERENCE_COPY.title} onClose={close} />
      <div className="ui-modal-body conversation-reference-picker">
        <SearchField label={REFERENCE_COPY.find} value={search} onValueChange={setSearch} />
        <p>{REFERENCE_COPY.scope}</p>
        {previous.length > 0 && (
          <details>
            <summary>{REFERENCE_COPY.previous}</summary>
            {previous.map(item => (
              <div key={item.reference}>
                <VisibleText text={tasks.find(task => task.id === item.source)?.title ?? REFERENCE_COPY.untitled} />
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => void revoke(item.reference)}>
                  {REFERENCE_COPY.revoke}
                </Button>
              </div>
            ))}
          </details>
        )}
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        {!sources.length && <p>{REFERENCE_COPY.empty}</p>}
        {sources.map(source => (
          <Button key={source.id} variant="ghost" disabled={busy} onClick={() => void choose(source)}>
            <VisibleText text={source.title || REFERENCE_COPY.untitled} />
          </Button>
        ))}
      </div>
    </Modal>
  )
}
