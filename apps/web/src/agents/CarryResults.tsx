import { useEffect, useRef, useState } from 'react'

import type { FileMention, TaskDetail, TaskSummary } from '@latch/protocol'
import { Badge, Button, Checkbox, Dialog, EmptyState, Loading, Sheet, HistoryGlyph } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { relativeTime } from '../format.ts'
import { fileName, messageLine, sessionFiles } from '../handoffs/model.ts'
import { finalReply, type CarriedResult } from './scheduleModel.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    untitled: '未命名会话',
    attach: '带入',
    noTopics: '还没有话题',
    previousTopics: '之前的话题',
    scheduled: '定时',
    loading: '正在读取',
    lastReply: '最后的回复',
    noReply: '还没有回复',
    quotePrevious: '带入上次成果',
    quoteGuidance: '作为引用文字放进输入框',
    cancel: '取消',
  },
  {
    untitled: 'Untitled session',
    attach: 'Quote',
    noTopics: 'No topics yet',
    previousTopics: 'Previous topics',
    scheduled: 'Scheduled',
    loading: 'Loading',
    lastReply: 'Last reply',
    noReply: 'No reply yet',
    quotePrevious: 'Quote previous work',
    quoteGuidance: 'Add the selected text as a quote',
    cancel: 'Cancel',
  },
)

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
  asked,
  onClosed,
}: {
  sessions: readonly TaskSummary[]
  disabled: boolean
  /** A phone chooses in the bottom sheet, as its other choices. */
  phone: boolean
  onCarry: (results: CarriedResult[]) => void
  /** Opened from elsewhere (a helper's ＋ menu), which draws no button of its own; it closes through `onClosed`. */
  asked?: boolean
  onClosed?: () => void
}) {
  const [own, setOwn] = useState(false)
  const controlled = asked !== undefined
  const open = controlled ? asked : own
  const setOpen = (value: boolean) => {
    if (controlled) {
      if (!value) onClosed?.()
    } else setOwn(value)
  }
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
    return [{ title: task.title || COPY.untitled, ...(pick.reply && got.reply ? { reply: got.reply } : {}), files }]
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
      {COPY.attach}
    </Button>
  )
  const list = (
    <>
      {shown.length === 0 ? (
        <EmptyState title={COPY.noTopics} />
      ) : (
        <ul className="agent-carry" aria-label={COPY.previousTopics}>
          {shown.map(task => {
            const pick = picks.get(task.id),
              got = reads.get(task.id)
            return (
              <li key={task.id} className="agent-carry-item">
                <Checkbox
                  label={
                    task.automationId ? (
                      <>
                        <Badge className="agent-run-tag">{COPY.scheduled}</Badge>
                        {task.title || COPY.untitled}
                      </>
                    ) : (
                      task.title || COPY.untitled
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
                {pick && got?.state === 'loading' && <Loading label={COPY.loading} />}
                {pick && got?.state === 'failed' && <p className="agent-form-empty">{got.message}</p>}
                {pick && got?.state === 'ready' && (
                  <div className="agent-carry-parts">
                    {got.reply ? (
                      <Checkbox
                        label={COPY.lastReply}
                        description={messageLine(got.reply, 60)}
                        checked={pick.reply}
                        onChange={event => {
                          const reply = event.target.checked
                          setPicks(previous => new Map(previous).set(task.id, { ...pick, reply }))
                        }}
                      />
                    ) : (
                      <p className="agent-form-empty">{COPY.noReply}</p>
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
      {!controlled && (
        <Button
          variant="ghost"
          size="sm"
          icon={HistoryGlyph}
          disabled={disabled || sessions.length === 0}
          onClick={() => {
            setOpen(true)
          }}>
          {COPY.quotePrevious}
        </Button>
      )}
      {phone ? (
        <Sheet open={open} onClose={close} detent="large" title={COPY.quotePrevious} action={carry}>
          <div className="agent-carry-sheet">{list}</div>
        </Sheet>
      ) : (
        <Dialog
          open={open}
          onClose={close}
          size="lg"
          title={COPY.quotePrevious}
          subtitle={COPY.quoteGuidance}
          footer={
            <>
              <Button size="md" onClick={close}>
                {COPY.cancel}
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
