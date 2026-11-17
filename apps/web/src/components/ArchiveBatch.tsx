import { useState } from 'react'
import type { HarnessInfo, SessionBatchResult, TaskSummary } from '@latch/protocol'
import { Button, InlineNotice } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { sessionDeletionMessage } from '../deletionCopy.ts'
import { isActive } from '../format.ts'
import { ConfirmDialog } from './overlays.tsx'

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
  const [error, setError] = useState('')
  const rows = tasks.filter(task => task.archived)
  const run = async (action: 'unarchive' | 'delete') => {
    setBusy(true)
    setError('')
    try {
      const result = await api<SessionBatchResult>('tasks/batch', { method: 'POST', body: { action, ids: [...selected] } })
      if (action === 'delete') for (const item of result.results) if (item.ok) onDeleted(item.id)
      const failed = result.results.filter(item => !item.ok)
      setSelected(new Set(failed.map(item => item.id)))
      if (failed.length) setError(`${failed.length} 个会话未处理：${failed.map(item => (item.ok ? '' : item.message)).join('；')}`)
      else {
        setActive(false)
        setDeleting(false)
      }
      await onChanged()
    } catch (cause) {
      setError(errorMessage(cause))
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
        批量管理
      </Button>
    )
  return (
    <section className="archive-batch" aria-label="批量管理归档会话">
      <div>
        <Button
          size="sm"
          disabled={busy || !selected.size}
          onClick={() => {
            void run('unarchive')
          }}>
          恢复 {selected.size || ''}
        </Button>
        <Button
          size="sm"
          disabled={busy || !selected.size || rows.some(task => selected.has(task.id) && isActive(task.status))}
          onClick={() => {
            setDeleting(true)
          }}>
          删除
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setActive(false)
            setSelected(new Set())
          }}>
          完成
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
          <span>{task.title || '未命名会话'}</span>
        </label>
      ))}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {deleting && (
        <ConfirmDialog
          title={`删除 ${selected.size} 个会话？`}
          message={sessionDeletionMessage(
            rows.filter(task => selected.has(task.id)),
            harnesses,
          )}
          confirmLabel="删除"
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
