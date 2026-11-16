import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { CircleHelp } from 'lucide-react'
import { noteLinesLabel, type AppSnapshot, type ChangedFile, type ReviewNote, type TaskSummary, readsProjectFiles } from '@latch/protocol'
import {
  Button,
  ConfirmDialog,
  ICON_STROKE,
  IconButton,
  MOTION,
  SegmentedControl,
  Sheet,
  Spinner,
  StatusWord,
  TextAreaField,
  ChevronLeftGlyph,
  ChevronRightGlyph,
  AlertGlyph,
  LockGlyph,
  MessageGlyph,
  WarningGlyph,
} from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { computerName, SETUP_COPY } from '../core/securityCopy.ts'
import type { DiffLine } from '../diff.ts'
import { useBackLayer } from '../hooks/backStack.ts'
import { useVisualViewportFit } from '../hooks/useVisualViewportFit.ts'
import { FileBody } from '../panel/changes/ChangesFile.tsx'
import { compareFiles, contentHidden, emptyState, fileId, fileNote, queryOf, type ScopeChoice } from '../panel/changes/model.ts'
import { noteTally, sameFile, snippetOf, type LineSelection } from '../panel/changes/notes.ts'
import { NoteCard, type NoteWriting } from '../panel/changes/ReviewNotes.tsx'
import { useChanges } from '../panel/changes/useChanges.ts'
import { useReviewNotes } from '../panel/changes/useReviewNotes.ts'
import { DeliveryPanel } from '../panel/delivery/DeliveryPanel.tsx'
import { PARTIAL_NOTE } from '../conversation/turnChanges.ts'
import { footAction, stepFile, tapLine, type PhoneReviewTarget } from './model.ts'
import { moveFocus } from './usePhoneReview.ts'

export type ReviewScope = PhoneReviewTarget['scope']

const SCOPES = [
  { value: 'turn', label: '本轮' },
  { value: 'session', label: '这个会话' },
  { value: 'uncommitted', label: '未提交' },
] as const

const choiceOf = (scope: ReviewScope): ScopeChoice => (scope === 'turn' ? { kind: 'latest' } : { kind: scope })

/** How long a level takes to slide away before it is dropped: --m-push, plus a frame. */
const LEAVE_MS = MOTION.push + 20

export interface PhoneReviewProps {
  target: PhoneReviewTarget
  summary: TaskSummary
  snapshot: AppSnapshot
  canRun: boolean
  canDeliver: boolean
  offline: boolean
  /** The page slides away to the list. */
  leaving: boolean
  onTarget: (target: PhoneReviewTarget) => void
  onClose: () => void
}

/** Lines picked on one file, with that file's text on both sides for the note's snippet. */
interface Picked {
  file: string
  selection: LineSelection
  sides: { old: string[]; new: string[] }
}

/**
 * The phone's review of a session, pushed over the list from a row's 「复核 N 处改动」: one file of the scope at a time with
 * its line notes, a bottom bar with the one thing to do next, and 提交 pushed over it. Back returns to the list.
 */
export function PhoneReview(props: PhoneReviewProps) {
  const { target, summary, snapshot, canDeliver, leaving, onTarget, onClose } = props
  const page = useRef<HTMLElement>(null)
  useVisualViewportFit(page, true)
  const [committed, setCommitted] = useState(false)
  const delivering = target.level === 'delivery'
  const [deliveryShown, setDeliveryShown] = useState(delivering)
  const [deliveryLeaving, setDeliveryLeaving] = useState(false)
  if (delivering && (!deliveryShown || deliveryLeaving)) {
    setDeliveryShown(true)
    setDeliveryLeaving(false)
  } else if (!delivering && deliveryShown && !deliveryLeaving) setDeliveryLeaving(true)
  useEffect(() => {
    if (!deliveryLeaving) return undefined
    const timer = setTimeout(() => {
      setDeliveryShown(false)
      setDeliveryLeaving(false)
    }, LEAVE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [deliveryLeaving])

  const toChanges = useCallback(() => {
    onTarget({ ...target, level: 'changes' })
  }, [onTarget, target])
  // 提交 holds its own place in the browser's history: the platform's back returns to 改动, or after a commit to the list.
  useBackLayer(delivering && !leaving, () => {
    if (committed) onClose()
    else toChanges()
  })

  const changesBack = useRef<HTMLButtonElement>(null)
  const deliveryBack = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (delivering) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      moveFocus(deliveryBack.current)
    } else if (opener.current?.isConnected) moveFocus(opener.current)
    else moveFocus(changesBack.current)
  }, [delivering])

  return (
    <section
      ref={page}
      className="phone-review"
      aria-label={`复核 · ${summary.title || '未命名会话'}`}
      data-leaving={leaving ? '' : undefined}
      inert={leaving || undefined}>
      <ReviewChanges
        {...props}
        backRef={changesBack}
        under={delivering}
        onDeliver={() => {
          onTarget({ ...target, level: 'delivery' })
        }}
      />
      {deliveryShown && canDeliver && (
        <section
          className="phone-review-level"
          data-state={deliveryLeaving ? 'leaving' : 'top'}
          aria-label="提交"
          inert={deliveryLeaving || undefined}>
          <header className="phone-review-bar">
            <IconButton
              ref={deliveryBack}
              size="lg"
              icon={ChevronLeftGlyph}
              label={committed ? '返回会话列表' : '返回改动'}
              onClick={committed ? onClose : toChanges}
            />
            <div className="phone-review-title">
              <h2>提交</h2>
              <span>
                <VisibleText text={summary.title || '未命名会话'} />
              </span>
            </div>
          </header>
          <div className="phone-review-delivery">
            <DeliveryPanel
              summary={summary}
              open={delivering && !leaving}
              canRun={props.canRun}
              {...(snapshot.hostName ? { hostName: snapshot.hostName } : {})}
              offline={props.offline}
              phone
              onOpenFile={path => {
                const root = summary.folders?.[0]?.id
                onTarget({ ...target, level: 'changes', scope: 'uncommitted', file: { path, ...(root ? { root } : {}) } })
              }}
              onOutcome={kind => {
                if (kind === 'committed' || kind === 'pushed') setCommitted(true)
              }}
            />
          </div>
        </section>
      )}
    </section>
  )
}

function ReviewChanges({
  target,
  summary,
  snapshot,
  canRun,
  canDeliver,
  offline,
  onTarget,
  onClose,
  backRef,
  under,
  onDeliver,
}: PhoneReviewProps & { backRef: RefObject<HTMLButtonElement | null>; under: boolean; onDeliver: () => void }) {
  const features = snapshot.catalog?.features
  const canRead = readsProjectFiles(snapshot.device.dataScope)
  const hostName = computerName(snapshot.hostName)
  const reviewNotes = features?.reviewNotes === true && canRead
  const choice = useMemo(() => choiceOf(target.scope), [target.scope])
  const { list, running, failure, revision, reload, readFile } = useChanges(summary, choice, offline || !canRead)
  const review = useReviewNotes(summary.id, {
    enabled: reviewNotes,
    revision: snapshot.reviewNotes?.find(counts => counts.sessionId === summary.id)?.revision ?? 0,
    poke: `${summary.status}:${summary.runId ?? ''}`,
    offline,
  })
  const files = useMemo(() => (list && !list.unavailable ? list.files.toSorted(compareFiles) : []), [list])
  const [current, setCurrent] = useState<string>()
  const [picked, setPicked] = useState<Picked>()
  const [writingNote, setWritingNote] = useState(false)
  const [text, setText] = useState('')
  const [stale, setStale] = useState(0)
  const [askClear, setAskClear] = useState(false)
  // The file shown stays while the list refreshes; a link from 提交 lands on its file once; otherwise the first one.
  const wanted = target.file
  const [landed, setLanded] = useState<PhoneReviewTarget['file']>()
  const linked = wanted && files.find(file => file.path === wanted.path && (wanted.root === undefined || file.root === wanted.root))
  if (wanted && wanted !== landed && linked) {
    setLanded(wanted)
    setCurrent(fileId(linked))
  }
  const index = Math.max(
    0,
    files.findIndex(file => fileId(file) === current),
  )
  const file: ChangedFile | undefined = files[index]
  const kept = review.notes ?? []
  const writing: NoteWriting | undefined =
    reviewNotes && canRun && !offline && summary.personal === undefined ? { actions: review.actions, busy: review.busy } : undefined
  const tally = noteTally(kept)
  const anchor = list && !list.unavailable ? { scope: queryOf(choice).scope, ...(list.turnId ? { turnId: list.turnId } : {}) } : undefined
  const selection = picked && file && picked.file === fileId(file) ? picked.selection : undefined
  const apart = kept.filter(note => !files.some(item => sameFile(note, item)))
  const empty = emptyState(list)
  const action = footAction({
    tally: { ready: tally.ready.length, sending: tally.sending.length, queued: tally.queued, sent: tally.sent, toReview: tally.toReview },
    selection,
    running,
    canQueue: features?.queue === true,
    offline,
    unknownSend: review.unknownSend !== undefined && !review.busy,
    canWrite: writing !== undefined,
    canDeliver,
  })

  const go = (by: 1 | -1) => {
    const next = stepFile(index, files.length, by)
    if (next === undefined) return
    setCurrent(fileId(files[next]))
    setPicked(undefined)
    setStale(0)
  }
  const onTap = (line: DiffLine, sides: { old: string[]; new: string[] }) => {
    if (!file) return
    const id = fileId(file)
    setPicked(previous => {
      const next = tapLine(previous?.file === id ? previous.selection : undefined, line)
      return next ? { file: id, selection: next, sides } : undefined
    })
  }
  const submitNote = async () => {
    if (!picked || !file || !anchor || !writing || !text.trim()) return
    const done = await writing.actions.create({
      root: file.root,
      path: file.path,
      range: { start: picked.selection.start, end: picked.selection.end },
      side: picked.selection.side,
      scope: anchor.scope,
      ...(anchor.turnId ? { turnId: anchor.turnId } : {}),
      lines: snippetOf(picked.sides[picked.selection.side], picked.selection),
      text: text.trim(),
    })
    if (done) {
      setWritingNote(false)
      setPicked(undefined)
      setText('')
    }
  }

  const folder = file && file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
  const fileNotes = file ? kept.filter(note => sameFile(note, file)) : []
  const note = file ? fileNote(file) : undefined

  return (
    <section className="phone-review-level" data-state={under ? 'under' : 'top'} aria-label="改动" inert={under || undefined}>
      <header className="phone-review-bar">
        <IconButton ref={backRef} size="lg" icon={ChevronLeftGlyph} label="返回会话列表" onClick={onClose} />
        <div className="phone-review-title">
          <h2>改动</h2>
          <span>
            <VisibleText text={summary.title || '未命名会话'} />
          </span>
        </div>
        {list && !list.unavailable && list.files.length > 0 && (
          <span className="changes-stat phone-review-total">
            <span className="changes-add">+{list.totals.add}</span>
            <span className="changes-del">−{list.totals.del}</span>
          </span>
        )}
      </header>
      {canRead && (
        <div className="phone-review-scope">
          <SegmentedControl
            label="改动范围"
            value={target.scope}
            options={SCOPES}
            onValueChange={scope => {
              setPicked(undefined)
              onTarget({ sessionId: target.sessionId, scope, level: target.level })
            }}
          />
        </div>
      )}
      {canRead && file && (
        <div className="phone-review-pager">
          <IconButton size="lg" icon={ChevronLeftGlyph} label="上一个文件" disabled={index === 0} onClick={() => go(-1)} />
          <div className="phone-review-file" aria-live="polite">
            <span className="phone-review-file-line">
              <span className="phone-review-file-name">
                <VisibleText text={file.path.split('/').at(-1)!} />
              </span>
              {!contentHidden(file) && (
                <span className="changes-stat">
                  {file.status === 'A' ? (
                    <span className="changes-tag" data-tone="new">
                      新文件
                    </span>
                  ) : file.status === 'D' ? (
                    <span className="changes-tag" data-tone="gone">
                      已删除
                    </span>
                  ) : (
                    <>
                      {!!file.add && <span className="changes-add">+{file.add}</span>}
                      {!!file.del && <span className="changes-del">−{file.del}</span>}
                    </>
                  )}
                </span>
              )}
            </span>
            <span className="phone-review-file-line phone-review-file-meta">
              {folder && (
                <span className="phone-review-file-folder">
                  <VisibleText text={folder} />
                </span>
              )}
              {note && <span>{note.text}</span>}
              {fileNotes.length > 0 && (
                <span className="review-note-count">
                  <MessageGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
                  {fileNotes.length}
                </span>
              )}
              {stale > 0 && (
                <span className="changes-note-warn">
                  <AlertGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
                  位置可能过期
                </span>
              )}
            </span>
          </div>
          <span className="phone-review-count">
            {index + 1} / {files.length}
          </span>
          <IconButton size="lg" icon={ChevronRightGlyph} label="下一个文件" disabled={index >= files.length - 1} onClick={() => go(1)} />
        </div>
      )}
      <div className="phone-review-body">
        {!canRead ? (
          <div className="changes-empty phone-review-locked">
            <div>
              <LockGlyph size={20} nonScalingStroke strokeWidth={ICON_STROKE[20]} aria-hidden="true" />
              <p className="changes-empty-title">这台设备看不到会话文件夹里的文件</p>
              <p className="changes-empty-detail">{SETUP_COPY.filesNeedScope(hostName)}</p>
            </div>
          </div>
        ) : failure?.kind === 'denied' ? (
          <div className="changes-empty">
            <div>
              <p className="changes-empty-title">这台设备看不到会话文件夹里的文件</p>
              <p className="changes-empty-detail">{SETUP_COPY.filesNeedScope(hostName)}</p>
            </div>
          </div>
        ) : failure && !list ? (
          <div className="changes-empty">
            <div>
              <p className="changes-empty-title">读不到改动</p>
              {failure.kind === 'failed' && <p className="changes-empty-detail">{failure.text}</p>}
              <Button size="sm" variant="outline" onClick={() => void reload()}>
                重试
              </Button>
            </div>
          </div>
        ) : !list ? (
          <div className="changes-empty" aria-busy="true">
            <div>
              <Spinner size={14} />
            </div>
          </div>
        ) : (
          <>
            {running && (
              <button type="button" className="changes-line changes-line-button" data-tone="muted" onClick={() => void reload()}>
                <Spinner size={12} />
                <span className="changes-line-text">运行中 · 点按刷新</span>
              </button>
            )}
            {list.partial && (
              <div className="changes-line" data-tone="amber">
                <WarningGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
                <span className="changes-line-text">{PARTIAL_NOTE.label}</span>
              </div>
            )}
            {failure?.kind === 'failed' && (
              <button type="button" className="changes-line changes-line-button" data-tone="muted" onClick={() => void reload()}>
                <AlertGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
                <span className="changes-line-text">没有刷新成功 · 这是上次的列表</span>
              </button>
            )}
            {empty || !file ? (
              <div className="changes-empty">
                <div>
                  <p className="changes-empty-title">{empty?.title ?? '没有改动'}</p>
                  {empty?.detail && <p className="changes-empty-detail">{empty.detail}</p>}
                </div>
              </div>
            ) : contentHidden(file) ? (
              <div className="changes-empty">
                <div>
                  <p className="changes-empty-title">{note?.text ?? '没有可以显示的内容'}</p>
                  {note?.title && <p className="changes-empty-detail">{note.title}</p>}
                </div>
              </div>
            ) : (
              <div className="changes-file-body" key={fileId(file)}>
                <FileBody
                  file={file}
                  layout="unified"
                  revision={revision}
                  read={readFile}
                  onStale={setStale}
                  notes={{
                    notes: fileNotes,
                    ...(anchor ? { anchor } : {}),
                    ...(writing ? { writing } : {}),
                    pick: { selection, onTap },
                  }}
                />
              </div>
            )}
            {apart.length > 0 && <ApartNotes notes={apart} writing={writing} />}
          </>
        )}
        {reviewNotes && review.readError && !review.notes && (
          <div className="changes-line" data-tone="muted">
            <AlertGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            <span className="changes-line-text">读不到反馈 · {review.readError}</span>
          </div>
        )}
      </div>
      <footer className="phone-review-foot" data-tone={action.kind === 'unknown' ? 'amber' : undefined}>
        {(offline || review.error) && (
          <p className="phone-review-foot-note" data-tone="amber">
            {offline ? `${hostName} 不在线，反馈留在待发` : review.error}
          </p>
        )}
        <div className="phone-review-foot-row">
          {action.kind === 'note' ? (
            <>
              <span className="phone-review-foot-text">{action.label}</span>
              <Button size="lg" variant="ghost" onClick={() => setPicked(undefined)}>
                取消
              </Button>
              <Button size="lg" variant="primary" onClick={() => setWritingNote(true)}>
                写反馈
              </Button>
            </>
          ) : action.kind === 'unknown' ? (
            <>
              <span className="phone-review-foot-text" data-lock="">
                <CircleHelp size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
                发送结果未知
              </span>
              <Button size="lg" variant="ghost" disabled={review.busy || offline} onClick={() => void review.actions.abandonSend()}>
                放弃这次发送
              </Button>
              <Button size="lg" variant="outline" disabled={review.busy || offline} onClick={() => void review.actions.retrySend()}>
                重试同一请求
              </Button>
            </>
          ) : action.kind === 'send' ? (
            <>
              <Button size="lg" variant="ghost" disabled={review.busy} onClick={() => setAskClear(true)}>
                清空
              </Button>
              <Button
                size="lg"
                variant="primary"
                className="phone-review-primary"
                loading={review.busy}
                loadingLabel="发送中…"
                disabled={action.disabled}
                onClick={() => {
                  void review.actions.send(
                    tally.ready.map(item => item.id),
                    running && features?.queue === true,
                  )
                }}>
                {action.label}
              </Button>
            </>
          ) : (
            <>
              {action.status && (
                <span className="phone-review-foot-text">
                  {action.status.running ? <StatusWord tone="running">{action.status.text}</StatusWord> : action.status.text}
                </span>
              )}
              {action.kind === 'deliver' && (
                <Button size="lg" variant="primary" className="phone-review-primary" onClick={onDeliver}>
                  去提交
                </Button>
              )}
            </>
          )}
        </div>
      </footer>
      <Sheet
        open={writingNote && selection !== undefined}
        title={selection ? noteLinesLabel(selection) : '反馈'}
        onClose={() => {
          setWritingNote(false)
        }}
        action={
          <Button
            variant="primary"
            disabled={!text.trim() || review.busy}
            loading={review.busy}
            loadingLabel="加入中…"
            onClick={() => void submitNote()}>
            加入待发
          </Button>
        }>
        <div className="phone-review-sheet">
          {picked && (
            <pre className="review-note-snippet" aria-label="选中的代码">
              {snippetOf(picked.sides[picked.selection.side], picked.selection).join('\n')}
            </pre>
          )}
          <TextAreaField
            label="反馈"
            rows={4}
            autoFocus
            placeholder="写给 Agent 的反馈…"
            value={text}
            onChange={event => {
              setText(event.target.value)
            }}
          />
        </div>
      </Sheet>
      {askClear && (
        <ConfirmDialog
          title={`清空 ${tally.ready.length} 条待发反馈？`}
          confirmLabel="清空"
          danger
          message="这些反馈还没有发出，清空后不能恢复。"
          onConfirm={async () => {
            for (const item of tally.ready) await review.actions.remove(item.id)
          }}
          onClose={() => {
            setAskClear(false)
          }}
        />
      )}
    </section>
  )
}

/** Notes on files this scope does not list: they stay in reach with their original lines. */
function ApartNotes({ notes, writing }: { notes: ReviewNote[]; writing: NoteWriting | undefined }) {
  return (
    <section className="review-notes-apart" aria-label="不在这个范围的反馈">
      <p className="review-notes-apart-title">不在这个范围的反馈</p>
      {notes.map(note => (
        <NoteCard key={note.id} note={note} quote where={`${note.path} `} {...(writing ? { writing } : {})} />
      ))}
    </section>
  )
}
