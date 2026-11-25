import { useContext, useEffect, useMemo, useRef, useState } from 'react'

import type { ChangeList, ChangeReceipt, Message, TurnChanges } from '@latch/protocol'
import { Button, Collapse, Hint, ICON_STROKE, WarningGlyph, UndoGlyph } from '@latch/ui'
import { FileListToggle, OutputNotes, ProducedFiles } from '../components/FileOutputs.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import type { Turn } from '../conversation.ts'
import { api, isUncertain, newRequestId } from '../core/api.ts'
import { useChangesLink, type ChangesTarget } from './changesLink.ts'
import { TurnSummaryOptions } from './summaryOptions.ts'
import {
  firstOpenable,
  notRestoredLine,
  changedOutputs,
  producedFiles,
  turnSummary,
  turnUndo,
  undoExceptions,
  type SummaryFile,
  type TurnUndo,
} from './turnChanges.ts'
import { TURN_CHANGES_COPY } from './turnChanges.copy.ts'
import { defineCopy, formatNumber, plural, useLocale } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    deleted: '已删除',
    byCommand: '由命令修改',
    undone: '已撤销本轮改动',
    redoUnknownRetry: '恢复结果未知 · 重试',
    redo: '恢复',
    redoUnknown: ' · 恢复结果未知',
    willTell: ' · 下一条消息会告诉 ',
    outsideUndo: (count: number) => `${formatNumber(count)} 个文件不在撤销范围`,
    outsideDetail: '它们在文件夹之外或被忽略。',
    undoUnknown: '撤销结果未知',
    unknownRetry: '结果未知 · 重试',
    undo: '撤销本轮',
    notRestored: (count: number) => `不会恢复 ${formatNumber(count)} 个文件`,
    cancel: '取消',
    changedFiles: '这一轮改动的文件',
    changed: (count: number) => `改动了 ${formatNumber(count)} 个文件`,
    openChanges: '打开改动',
  },
  {
    deleted: 'Deleted',
    byCommand: 'Changed by a command',
    undone: 'Turn undone',
    redoUnknownRetry: 'Redo outcome unknown · Retry',
    redo: 'Redo',
    redoUnknown: ' · Redo outcome unknown',
    willTell: ' · The next message tells ',
    outsideUndo: (count: number) => `${plural(count, { one: '{n} file', other: '{n} files' })} outside undo`,
    outsideDetail: 'They are outside the folder or ignored.',
    undoUnknown: 'Undo outcome unknown',
    unknownRetry: 'Outcome unknown · Retry',
    undo: 'Undo turn',
    notRestored: (count: number) => plural(count, { one: 'Will leave {n} file as it is', other: 'Will leave {n} files as they are' }),
    cancel: 'Cancel',
    changedFiles: 'Files changed in this turn',
    changed: (count: number) => plural(count, { one: 'Changed {n} file', other: 'Changed {n} files' }),
    openChanges: 'Open changes',
  },
)

/**
 * Reads the turn's list the first time the card comes into view, and again when the record moves or something else moved
 * on while it stays in view. The card's root element changes with its state, so the observer follows the element.
 */
function useTurnList(sessionId: string, record: TurnChanges | undefined, revision: string) {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [seen, setSeen] = useState(false)
  const [list, setList] = useState<ChangeList>()
  // A settled turn that changed nothing has nothing to list.
  const turnId = record?.files === 0 ? undefined : record?.turnId
  // A run that just ended is read as running until the Host has recorded it, and refreshing does not move the session.
  const recorded = `${record?.state}:${record?.files}:${record?.undone}`
  useEffect(() => {
    if (!element || seen) return undefined
    if (typeof IntersectionObserver !== 'function') {
      setSeen(true)
      return undefined
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setSeen(true)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [element, seen])
  useEffect(() => {
    if (turnId === undefined) {
      setList(undefined)
      return undefined
    }
    if (!seen) return undefined
    const controller = new AbortController()
    void api<ChangeList>(`tasks/${encodeURIComponent(sessionId)}/changes?scope=turn&turn=${encodeURIComponent(turnId)}`, {
      signal: controller.signal,
    })
      .then(answer => {
        if (!controller.signal.aborted) setList(answer)
      })
      .catch(() => undefined)
    return () => {
      controller.abort()
    }
  }, [seen, sessionId, turnId, recorded, revision])
  return { list, cardRef: setElement }
}

function Stat({ add, del }: { add: number | undefined; del: number | undefined }) {
  if (add === undefined && del === undefined) return null
  return (
    <span className="process-stat">
      <span className="stat-add">+{add ?? 0}</span> <span className="stat-del">−{del ?? 0}</span>
    </span>
  )
}

/** A row of the card: the file's folder quietly, its name, who changed it when that is not the agent, and its lines. */
function FileRow({ file, onOpen }: { file: SummaryFile; onOpen: () => void }) {
  const cut = file.path.lastIndexOf('/')
  const content = (
    <>
      <span className="summary-file-path">
        {cut >= 0 && (
          <span className="summary-file-folder">
            <VisibleText text={file.path.slice(0, cut + 1)} />
          </span>
        )}
        <VisibleText text={file.path.slice(cut + 1)} />
      </span>
      {file.deleted && <span className="summary-file-note">{COPY.deleted}</span>}
      {file.byCommand && <span className="summary-file-note">{COPY.byCommand}</span>}
      <Stat add={file.add} del={file.del} />
    </>
  )
  if (file.deleted)
    return (
      <div className="summary-file" title={file.path}>
        {content}
      </div>
    )
  return (
    <button type="button" className="summary-file" onClick={onOpen} title={file.path}>
      {content}
    </button>
  )
}

type UndoAction = 'undo' | 'redo'
type UndoPhase = 'idle' | 'confirm' | 'running' | 'uncertain'

/** A record that does not cover every file says so wherever the turn's files are shown. */
function PartialNote({ list }: { list: ChangeList | undefined }) {
  if (!list?.partial) return null
  return (
    <div className="changed-files-partial">
      <Hint inline lead={<WarningGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} />} label={TURN_CHANGES_COPY.partialLabel}>
        {TURN_CHANGES_COPY.partialDetail}
      </Hint>
    </div>
  )
}

function NotRestored({ receipt }: { receipt: ChangeReceipt }) {
  const line = notRestoredLine(receipt)
  if (!line) return null
  return (
    <>
      <p>{line}</p>
      <ul>
        {receipt.notRestored.map(file => (
          <li key={`${file.root}\n${file.path}`}>
            <VisibleText text={file.path} />
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * What a settled turn leaves behind. 「改动了 3 个文件 +64 −8」 lists the files under 显示文件, each row and 打开改动 go to
 * this turn's files, and 撤销本轮 acts on the turn the Host recorded; the action or the reason it cannot run sits in the
 * header. 「生成了 2 个文件」 offers new documents to open, and alone stands for a turn that changed nothing else. After
 * an undo the cards give way to the record line.
 */
export function TurnCards({
  sessionId,
  turn,
  record,
  revision,
  enabled,
  engine,
  active,
  outputs,
  onError,
}: {
  sessionId: string
  turn: Turn
  record: TurnChanges | undefined
  revision: string
  /** The Host keeps per-turn records. Without them the card comes from the turn's own edits and has no undo. */
  enabled: boolean
  engine: string
  /** Another turn of the session runs. */
  active: boolean
  outputs: Pick<Message, 'outputs' | 'outputsTruncated' | 'outputsUnavailable'> | undefined
  onError?: ((error: unknown) => void) | undefined
}) {
  const { undo: undoGate, offline = false, refresh } = useContext(TurnSummaryOptions)
  const link = useChangesLink()
  const usable = enabled ? record : undefined
  const { list, cardRef } = useTurnList(sessionId, usable, revision)
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<UndoPhase>('idle')
  // The record it arrived against: the Host's record takes over once it has moved on.
  const [done, setDone] = useState<{ receipt: ChangeReceipt; record: TurnChanges | undefined }>()
  const [undone, setUndone] = useState<boolean>()
  // The request whose answer is not known yet: a retry repeats that action under the same ID.
  const attempt = useRef<{ action: UndoAction; requestId: string } | null>(null)
  useEffect(() => {
    if (!list) return
    const nowUndone = list.undone === true
    setUndone(nowUndone)
    // The record says the unknown request landed, so its outcome is known now.
    if (attempt.current && nowUndone === (attempt.current.action === 'undo')) {
      attempt.current = null
      setPhase(current => (current === 'uncertain' ? 'idle' : current))
    }
  }, [list])
  const seen = outputs?.outputs
  const locale = useLocale()
  const summary = useMemo(() => turnSummary(turn, list, changedOutputs(usable, seen ?? [])), [locale, turn, list, usable, seen])
  const produced = useMemo(() => producedFiles(seen ?? []), [seen])
  const turnId = record?.turnId
  const openable = firstOpenable(summary.files)
  const target = (file?: SummaryFile): ChangesTarget => {
    const shown = file ?? openable
    return {
      ...(turnId ? { turnId } : {}),
      ...(shown?.root ? { root: shown.root } : {}),
      ...(shown ? { path: shown.path } : {}),
    }
  }
  const act = (action: UndoAction) => {
    if (!turnId) return
    const current = attempt.current?.action === action ? attempt.current : { action, requestId: newRequestId() }
    attempt.current = current
    setPhase('running')
    void api<ChangeReceipt>(`tasks/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/${action}`, {
      method: 'POST',
      body: { requestId: current.requestId },
    }).then(
      answer => {
        attempt.current = null
        setPhase('idle')
        setDone({ receipt: answer, record })
        setUndone(action === 'undo')
        refresh()
      },
      (error: unknown) => {
        if (isUncertain(error)) setPhase(attempt.current ? 'uncertain' : 'idle')
        else {
          attempt.current = null
          setPhase('idle')
          onError?.(error)
        }
        // A refusal means this device's picture is old, and an unknown outcome may already show in the record.
        refresh()
      },
    )
  }
  const unknown = phase === 'uncertain'
  const receipt = done?.receipt
  const exceptions = list ? undoExceptions(list) : []
  // The same judgement and words as the 改动 tab. A device or session that only reads is said so at the composer, and
  // the card cannot tell which of the two it is, so it offers nothing and says nothing more.
  const decision: TurnUndo =
    list && record && undoGate !== 'read-only' ? turnUndo(list, record, { canRun: true, active, offline }) : { kind: 'none' }
  const why = decision.kind === 'why' ? decision.text : undefined
  if (undone) {
    const undoReceipt = receipt?.action === 'undo' ? receipt : undefined
    const notCovered = undoReceipt?.notCovered ?? list?.notCovered ?? []
    const canRedo = decision.kind === 'redo'
    // The engine hears as soon as a turn begins, so nothing is still to be told once one runs.
    const noted = !active && (done && done.record === record ? done.receipt.noteNextTurn : record?.notePending === true)
    return (
      <section ref={cardRef} className="undo-record" aria-label={COPY.undone}>
        <p className="undo-record-line">
          <span className="process-slot" aria-hidden="true">
            <UndoGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} />
          </span>
          {COPY.undone}
          {canRedo && (
            <>
              {' · '}
              <button
                type="button"
                className="undo-record-action"
                data-lock={unknown ? '' : undefined}
                disabled={phase === 'running'}
                onClick={() => {
                  act('redo')
                }}>
                {unknown ? COPY.redoUnknownRetry : COPY.redo}
              </button>
            </>
          )}
          {unknown && !canRedo && <span data-lock="">{COPY.redoUnknown}</span>}
          {why && <span> · {why}</span>}
          {noted && (
            <span>
              {COPY.willTell}
              {engine}
            </span>
          )}
        </p>
        <PartialNote list={list} />
        {((undoReceipt?.skipped ?? 0) > 0 || notCovered.length > 0) && (
          <div className="undo-record-missing">
            {undoReceipt && <NotRestored receipt={undoReceipt} />}
            {notCovered.length > 0 && (
              <>
                <Hint label={COPY.outsideUndo(notCovered.length)}>{COPY.outsideDetail}</Hint>
                <ul>
                  {notCovered.map(path => (
                    <li key={path}>
                      <VisibleText text={path} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </section>
    )
  }
  const notes = (
    <>
      {receipt?.action === 'redo' && receipt.skipped > 0 && (
        <div className="undo-record-missing">
          <NotRestored receipt={receipt} />
        </div>
      )}
      <OutputNotes truncated={outputs?.outputsTruncated} unavailable={outputs?.outputsUnavailable} />
    </>
  )
  const hasRow = summary.files.length > 0
  // A record with files is still a reason to read its list, though the turn's own rows say nothing about them.
  if (!hasRow && produced.length === 0)
    return (
      <div ref={cardRef}>
        <PartialNote list={list} />
        {notes}
      </div>
    )
  const canUndo = decision.kind === 'undo'
  const count = list?.totals.files ?? summary.files.length
  const undoControl = (
    <>
      {why && <span className="changed-files-why">{why}</span>}
      {unknown && !canUndo && (
        <span className="changed-files-why" data-lock="">
          {COPY.undoUnknown}
        </span>
      )}
      {canUndo && (
        <Button
          size="xs"
          variant="ghost"
          icon={UndoGlyph}
          data-lock={unknown ? '' : undefined}
          loading={phase === 'running'}
          onClick={() => {
            if (exceptions.length > 0 && phase === 'idle') setPhase('confirm')
            else act('undo')
          }}>
          {unknown ? COPY.unknownRetry : COPY.undo}
        </Button>
      )}
    </>
  )
  const confirm = (
    <Collapse open={phase === 'confirm'}>
      <div className="changed-files-confirm">
        <p className="changed-files-warning">{COPY.notRestored(exceptions.length)}</p>
        <ul>
          {exceptions.map(line => (
            <li key={line}>
              <VisibleText text={line} />
            </li>
          ))}
        </ul>
        <div className="changed-files-confirm-actions">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setPhase('idle')
            }}>
            {COPY.cancel}
          </Button>
          <Button
            size="xs"
            variant="secondary"
            onClick={() => {
              act('undo')
            }}>
            {COPY.undo}
          </Button>
        </div>
      </div>
    </Collapse>
  )
  // Documents are offered to open; the changed-files card stands only for what else the turn changed.
  const producedPaths = new Set(produced.map(file => file.path))
  const onlyProduced = produced.length > 0 && summary.files.every(file => producedPaths.has(file.path))
  if (onlyProduced) {
    return (
      <div ref={cardRef} className="turn-cards">
        <ProducedFiles files={produced} actions={undoControl} />
        {confirm}
        <PartialNote list={list} />
        {notes}
      </div>
    )
  }
  return (
    <div className="turn-cards">
      <section ref={cardRef} className="changed-files" aria-label={COPY.changedFiles} data-open={open ? '' : undefined}>
        <div className="changed-files-head">
          <span className="changed-files-title">{COPY.changed(count)}</span>
          <Stat add={summary.add} del={summary.del} />
          <FileListToggle expanded={open} onToggle={() => setOpen(!open)} />
          <span className="process-fill" />
          {undoControl}
          {link && openable && (
            <Button
              size="xs"
              variant="outline"
              className="changed-files-open"
              onClick={() => {
                link.open(target())
              }}>
              {COPY.openChanges}
            </Button>
          )}
        </div>
        {confirm}
        <PartialNote list={list} />
        <Collapse
          open={open}
          lazy
          onReveal={() => {
            setOpen(true)
          }}>
          <div className="changed-files-rows">
            {summary.files.map(file => (
              <FileRow
                key={`${file.root ?? ''}\n${file.path}`}
                file={file}
                onOpen={() => {
                  link?.open(target(file))
                }}
              />
            ))}
          </div>
        </Collapse>
      </section>
      <ProducedFiles files={produced} />
      {notes}
    </div>
  )
}
