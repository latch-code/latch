import { useEffect, useRef, useState } from 'react'
import { History } from 'lucide-react'
import type { FileMention, TaskDetail, TaskSummary } from '@latch/protocol'
import { Badge, Button, Checkbox, Dialog, EmptyState, Loading, Sheet } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { relativeTime } from '../format.ts'
import { fileName, messageLine, sessionFiles } from '../handoffs/model.ts'
import { finalReply, type CarriedResult } from './scheduleModel.ts'

const SHOWN = 12
const fileKey = (file: FileMention) => `${file.root}\u0000${file.path}`

type Read = { state: 'loading' } | { state: 'ready'; reply: string; files: FileMention[] } | { state: 'failed'; message: string }
/** What is chosen from one earlier delegation: its last reply and some of its files. */
interface Pick {
  reply: boolean
  files: ReadonlySet<string>
}

/**
 * 带入上次成果: choose earlier delegations of this Agent and, from each, its last reply and the files it names. They go
 * into the draft as quoted text; the new session does not continue the old one's context.
 */
export function CarryResults({
  sessions,
  disabled,
  phone,
  onCarry,
}: {
  sessions: readonly TaskSummary[]
  disabled: boolean
  /** A phone chooses in the bottom sheet, as its other choices. */
  phone: boolean
  onCarry: (results: CarriedResult[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [picks, setPicks] = useState<ReadonlyMap<string, Pick>>(new Map())
  const [reads, setReads] = useState<ReadonlyMap<string, Read>>(new Map())
  const shown = sessions.slice(0, SHOWN)
  const reading = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      reading.current?.abort()
    },
    [],
  )
  /** Reads a chosen delegation once, for its last reply and its files. */
  const read = (id: string) => {
    if (reads.get(id)?.state === 'ready' || reads.get(id)?.state === 'loading') return
    reading.current ??= new AbortController()
    const { signal } = reading.current
    setReads(previous => new Map(previous).set(id, { state: 'loading' }))
    api<TaskDetail>(`tasks/${encodeURIComponent(id)}`, { signal })
      .then(detail => {
        const reply = finalReply(detail.messages)
        setReads(previous => new Map(previous).set(id, { state: 'ready', reply, files: sessionFiles(detail.messages) }))
        setPicks(previous => {
          const pick = previous.get(id)
          return pick ? new Map(previous).set(id, { ...pick, reply: reply !== '' }) : previous
        })
      })
      .catch((error: unknown) => {
        if (signal.aborted) return
        setReads(previous => new Map(previous).set(id, { state: 'failed', message: errorMessage(error) }))
      })
  }
  const close = () => {
    reading.current?.abort()
    reading.current = null
    setOpen(false)
    setPicks(new Map())
    setReads(new Map())
  }
  const results: CarriedResult[] = shown.flatMap(task => {
    const pick = picks.get(task.id),
      got = reads.get(task.id)
    if (!pick || got?.state !== 'ready') return []
    const files = got.files.filter(file => pick.files.has(fileKey(file)))
    if (!(pick.reply && got.reply) && !files.length) return []
    return [{ title: task.title || '未命名会话', ...(pick.reply && got.reply ? { reply: got.reply } : {}), files }]
  })
  const loading = [...picks.keys()].some(id => reads.get(id)?.state !== 'ready' && reads.get(id)?.state !== 'failed')
  const carry = (
    <Button
      size="md"
      variant="primary"
      disabled={results.length === 0 || loading}
      onClick={() => {
        onCarry(results)
        close()
      }}>
      带入
    </Button>
  )
  const list = (
    <>
      {shown.length === 0 ? (
        <EmptyState title="还没有委托" />
      ) : (
        <ul className="agent-carry" aria-label="之前的委托">
          {shown.map(task => {
            const pick = picks.get(task.id),
              got = reads.get(task.id)
            return (
              <li key={task.id} className="agent-carry-item">
                <Checkbox
                  label={
                    task.automationId ? (
                      <>
                        <Badge className="agent-run-tag">定时</Badge>
                        {task.title || '未命名会话'}
                      </>
                    ) : (
                      task.title || '未命名会话'
                    )
                  }
                  description={relativeTime(task.updatedAt)}
                  checked={pick !== undefined}
                  onChange={event => {
                    const checked = event.target.checked
                    setPicks(previous => {
                      const next = new Map(previous)
                      if (checked) next.set(task.id, { reply: true, files: new Set() })
                      else next.delete(task.id)
                      return next
                    })
                    if (checked) read(task.id)
                  }}
                />
                {pick && got?.state === 'loading' && <Loading label="正在读取" />}
                {pick && got?.state === 'failed' && <p className="agent-form-empty">{got.message}</p>}
                {pick && got?.state === 'ready' && (
                  <div className="agent-carry-parts">
                    {got.reply ? (
                      <Checkbox
                        label="最后的回复"
                        description={messageLine(got.reply, 60)}
                        checked={pick.reply}
                        onChange={event => {
                          const reply = event.target.checked
                          setPicks(previous => new Map(previous).set(task.id, { ...pick, reply }))
                        }}
                      />
                    ) : (
                      <p className="agent-form-empty">还没有回复</p>
                    )}
                    {got.files.map(file => (
                      <Checkbox
                        key={fileKey(file)}
                        label={fileName(file)}
                        description={file.path}
                        checked={pick.files.has(fileKey(file))}
                        onChange={event => {
                          const files = new Set(pick.files)
                          if (event.target.checked) files.add(fileKey(file))
                          else files.delete(fileKey(file))
                          setPicks(previous => new Map(previous).set(task.id, { ...pick, files }))
                        }}
                      />
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={History}
        disabled={disabled || sessions.length === 0}
        onClick={() => {
          setOpen(true)
        }}>
        带入上次成果
      </Button>
      {phone ? (
        <Sheet open={open} onClose={close} detent="large" title="带入上次成果" action={carry}>
          <div className="agent-carry-sheet">{list}</div>
        </Sheet>
      ) : (
        <Dialog
          open={open}
          onClose={close}
          size="form"
          title="带入上次成果"
          subtitle="作为引用文字放进输入框"
          footer={
            <>
              <Button size="md" onClick={close}>
                取消
              </Button>
              {carry}
            </>
          }>
          {list}
        </Dialog>
      )}
    </>
  )
}
