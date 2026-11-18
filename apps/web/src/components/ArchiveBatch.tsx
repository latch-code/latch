import { useState } from 'react'
import type { HarnessInfo, SessionBatchResult, TaskSummary } from '@latch/protocol'
import { Button, InlineNotice } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { sessionDeletionMessage } from '../deletionCopy.ts'
import { isActive } from '../format.ts'
import { ConfirmDialog } from './overlays.tsx'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    failedCount: (count: number, value2: string) => `${formatNumber(count)} 个会话未处理：${value2}`,
    manage: '批量管理',
    region: '批量管理归档会话',
    restore: '恢复 ',
    delete: '删除',
    done: '完成',
    untitled: '未命名会话',
    deleteTitle: (count: number) => `删除 ${formatNumber(count)} 个会话？`,
  },
  {
    failedCount: (count: number, value2: string) =>
      `Could not process ${plural(count, { one: '{n} session', other: '{n} sessions' })}. ${value2}`,
    manage: 'Manage',
    region: 'Manage archived sessions',
    restore: 'Restore ',
    delete: 'Delete',
    done: 'Done',
    untitled: 'Untitled session',
    deleteTitle: (count: number) => `Delete ${plural(count, { one: '{n} session', other: '{n} sessions' })}?`,
  },
)

export function ArchiveBatch({
  tasks,
  harnesses,
  onChanged,
  onDeleted,
}: {
  tasks: TaskSummary[]
  harnesses: readonly HarnessInfo[]
  onChanged: () => Promise<unknown>
  onDeleted: (id: string) => void
}) {
  const [active, setActive] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<number>()
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [failure, setError] = useState<{ kind: 'batch'; messages: string[] } | { kind: 'request'; cause: unknown }>()
  const error =
    failure?.kind === 'batch'
      ? COPY.failedCount(failure.messages.length, failure.messages.join('；'))
      : failure && errorMessage(failure.cause)
  const rows = tasks.filter(task => task.archived)
  const run = async (action: 'unarchive' | 'delete') => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await api<SessionBatchResult>('tasks/batch', { method: 'POST', body: { action, ids: [...selected] } })
      if (action === 'delete') for (const item of result.results) if (item.ok) onDeleted(item.id)
      const failed = result.results.filter(item => !item.ok)
      setSelected(new Set(failed.map(item => item.id)))
      if (failed.length) setError({ kind: 'batch', messages: failed.map(item => (item.ok ? '' : item.message)) })
      else {
        setActive(false)
        setDeleting(false)
      }
      await onChanged()
    } catch (cause) {
      setError({ kind: 'request', cause })
    } finally {
      setBusy(false)
    }
  }
  if (!active)
    return (
      <Button
        variant="ghost"
        onClick={() => {
          setActive(true)
        }}>
        {COPY.manage}
      </Button>
    )
  return (
    <section className="archive-batch" aria-label={COPY.region}>
      <div>
        <Button
          size="sm"
          disabled={busy || !selected.size}
          onClick={() => {
            void run('unarchive')
          }}>
          {COPY.restore}
          {selected.size || ''}
        </Button>
        <Button
          size="sm"
          disabled={busy || !selected.size || rows.some(task => selected.has(task.id) && isActive(task.status))}
          onClick={() => {
            setDeleting(true)
          }}>
          {COPY.delete}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setActive(false)
            setSelected(new Set())
          }}>
          {COPY.done}
        </Button>
      </div>
      {rows.map((task, index) => (
        <label key={task.id}>
          <input
            type="checkbox"
            checked={selected.has(task.id)}
            disabled={busy}
            onClick={event => {
              if (event.shiftKey && anchor !== undefined) {
                const range = rows.slice(Math.min(anchor, index), Math.max(anchor, index) + 1)
                setSelected(previous => new Set([...previous, ...range.map(item => item.id)]))
              }
            }}
            onChange={event => {
              const checked = event.target.checked
              setSelected(previous => {
                const next = new Set(previous)
                if (checked) next.add(task.id)
                else next.delete(task.id)
                return next
              })
              setAnchor(index)
            }}
          />
          <span>{task.title || COPY.untitled}</span>
        </label>
      ))}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {deleting && (
        <ConfirmDialog
          title={COPY.deleteTitle(selected.size)}
          message={sessionDeletionMessage(
            rows.filter(task => selected.has(task.id)),
            harnesses,
          )}
          confirmLabel={COPY.delete}
          danger
          onConfirm={() => run('delete')}
          onClose={() => {
            if (!busy) setDeleting(false)
          }}
        />
      )}
    </section>
  )
}
