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
import { TURN_CHANGES_COPY } from '../conversation/turnChanges.copy.ts'
import { footAction, stepFile, tapLine, type PhoneReviewTarget } from './model.ts'
import { moveFocus } from './usePhoneReview.ts'
import { defineCopy, formatNumber } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    reviewSession: (title: string) => `复核 · ${title}`,
    turn: '本轮',
    session: '这个会话',
    uncommitted: '未提交',
    commit: '提交',
    backSessions: '返回会话列表',
    backChanges: '返回改动',
    untitled: '未命名会话',
    changes: '改动',
    scope: '改动范围',
    previous: '上一个文件',
    newFile: '新文件',
    deleted: '已删除',
    stale: '位置可能过期',
    next: '下一个文件',
    noFiles: '这台设备看不到会话文件夹里的文件',
    readFailed: '读不到改动',
    retry: '重试',
    running: '运行中 · 点按刷新',
    refreshFailed: '没有刷新成功 · 这是上次的列表',
    empty: '没有改动',
    noContent: '没有可以显示的内容',
    feedbackFailed: '读不到反馈 · ',
    offline: (value1: string | number) => `${value1} 不在线，反馈留在待发`,
    cancel: '取消',
    write: '写反馈',
    unknown: '发送结果未知',
    abandon: '放弃这次发送',
    retrySame: '重试同一请求',
    clear: '清空',
    sending: '发送中…',
    goCommit: '去提交',
    feedback: '反馈',
    adding: '加入中…',
    add: '加入待发',
    selected: '选中的代码',
    feedbackHint: '写给 Agent 的反馈…',
    confirmClear: (count: number) => `清空 ${formatNumber(count)} 条待发反馈？`,
    clearMessage: '这些反馈还没有发出，清空后不能恢复。',
    outside: '不在这个范围的反馈',
  },
  {
    reviewSession: (title: string) => `Review · ${title}`,
    turn: 'Latest turn',
    session: 'This session',
    uncommitted: 'Uncommitted',
    commit: 'Commit',
    backSessions: 'Back to sessions',
    backChanges: 'Back to changes',
    untitled: 'Untitled session',
    changes: 'Changes',
    scope: 'Changes scope',
    previous: 'Previous file',
    newFile: 'New file',
    deleted: 'Deleted',
    stale: 'Location may be out of date',
    next: 'Next file',
    noFiles: 'This device can’t see the session’s files',
    readFailed: 'Couldn’t read changes',
    retry: 'Retry',
    running: 'Running · press to refresh',
    refreshFailed: 'Couldn’t refresh · showing the last list',
    empty: 'No changes',
    noContent: 'Nothing to show',
    feedbackFailed: 'Couldn’t read feedback · ',
    offline: (value1: string | number) => `${value1} is offline. Feedback stays queued.`,
    cancel: 'Cancel',
    write: 'Write feedback',
    unknown: 'Send outcome unknown',
    abandon: 'Stop waiting for this send',
    retrySame: 'Retry same request',
    clear: 'Clear',
    sending: 'Sending…',
    goCommit: 'Go to commit',
    feedback: 'Feedback',
    adding: 'Adding…',
    add: 'Queue feedback',
    selected: 'Selected code',
    feedbackHint: 'Write feedback for the agent…',
    confirmClear: (count: number) => `Clear ${formatNumber(count)} queued feedback items?`,
    clearMessage: 'This feedback hasn’t been sent. Clearing it can’t be undone.',
    outside: 'Feedback outside this scope',
  },
)

export type ReviewScope = PhoneReviewTarget['scope']

const SCOPES = [
  {
    value: 'turn',
    get label() {
      return COPY.turn
    },
  },
  {
    value: 'session',
    get label() {
      return COPY.session
    },
  },
  {
    value: 'uncommitted',
    get label() {
      return COPY.uncommitted
    },
  },
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
      aria-label={COPY.reviewSession(summary.title || COPY.untitled)}
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
          aria-label={COPY.commit}
          inert={deliveryLeaving || undefined}>
          <header className="phone-review-bar">
            <IconButton
              ref={deliveryBack}
              size="lg"
              icon={ChevronLeftGlyph}
              label={committed ? COPY.backSessions : COPY.backChanges}
              onClick={committed ? onClose : toChanges}
            />
            <div className="phone-review-title">
              <h2>{COPY.commit}</h2>
              <span>
                <VisibleText text={summary.title || COPY.untitled} />
              </span>
            </div>
          </header>
          <div className="phone-review-delivery">
            <DeliveryPanel
              summary={summary}
              open={delivering && !leaving}
              canRun={props.canRun}
              canReadFiles={readsProjectFiles(snapshot.device.dataScope)}
              {...(snapshot.hostName ? { hostName: snapshot.hostName } : {})}
              offline={props.offline}
              phone
              sync={snapshot.catalog?.features?.gitSync === true}
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
    <section className="phone-review-level" data-state={under ? 'under' : 'top'} aria-label={COPY.changes} inert={under || undefined}>
      <header className="phone-review-bar">
        <IconButton ref={backRef} size="lg" icon={ChevronLeftGlyph} label={COPY.backSessions} onClick={onClose} />
        <div className="phone-review-title">
          <h2>{COPY.changes}</h2>
          <span>
            <VisibleText text={summary.title || COPY.untitled} />
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
            label={COPY.scope}
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
          <IconButton size="lg" icon={ChevronLeftGlyph} label={COPY.previous} disabled={index === 0} onClick={() => go(-1)} />
          <div className="phone-review-file" aria-live="polite">
            <span className="phone-review-file-line">
              <span className="phone-review-file-name">
                <VisibleText text={file.path.split('/').at(-1)!} />
              </span>
              {!contentHidden(file) && (
                <span className="changes-stat">
                  {file.status === 'A' ? (
                    <span className="changes-tag" data-tone="new">
                      {COPY.newFile}
                    </span>
                  ) : file.status === 'D' ? (
                    <span className="changes-tag" data-tone="gone">
                      {COPY.deleted}
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
                  {COPY.stale}
                </span>
              )}
            </span>
          </div>
          <span className="phone-review-count">
            {index + 1} / {files.length}
          </span>
          <IconButton size="lg" icon={ChevronRightGlyph} label={COPY.next} disabled={index >= files.length - 1} onClick={() => go(1)} />
        </div>
      )}
      <div className="phone-review-body">
        {!canRead ? (
          <div className="changes-empty phone-review-locked">
            <div>
              <LockGlyph size={20} nonScalingStroke strokeWidth={ICON_STROKE[20]} aria-hidden="true" />
              <p className="changes-empty-title">{COPY.noFiles}</p>
              <p className="changes-empty-detail">{SETUP_COPY.filesNeedScope(hostName)}</p>
            </div>
          </div>
        ) : failure?.kind === 'denied' ? (
          <div className="changes-empty">
            <div>
              <p className="changes-empty-title">{COPY.noFiles}</p>
              <p className="changes-empty-detail">{SETUP_COPY.filesNeedScope(hostName)}</p>
            </div>
          </div>
        ) : failure && !list ? (
          <div className="changes-empty">
            <div>
              <p className="changes-empty-title">{COPY.readFailed}</p>
              {failure.kind === 'failed' && <p className="changes-empty-detail">{failure.text}</p>}
              <Button size="sm" variant="outline" onClick={() => void reload()}>
                {COPY.retry}
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
                <span className="changes-line-text">{COPY.running}</span>
              </button>
            )}
            {list.partial && (
              <div className="changes-line" data-tone="amber">
                <WarningGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
                <span className="changes-line-text">{TURN_CHANGES_COPY.partialLabel}</span>
              </div>
            )}
            {failure?.kind === 'failed' && (
              <button type="button" className="changes-line changes-line-button" data-tone="muted" onClick={() => void reload()}>
                <AlertGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
                <span className="changes-line-text">{COPY.refreshFailed}</span>
              </button>
            )}
            {empty || !file ? (
              <div className="changes-empty">
                <div>
                  <p className="changes-empty-title">{empty?.title ?? COPY.empty}</p>
                  {empty?.detail && <p className="changes-empty-detail">{empty.detail}</p>}
                </div>
              </div>
            ) : contentHidden(file) ? (
              <div className="changes-empty">
                <div>
                  <p className="changes-empty-title">{note?.text ?? COPY.noContent}</p>
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
            <span className="changes-line-text">
              {COPY.feedbackFailed}
              {review.readError}
            </span>
          </div>
        )}
      </div>
      <footer className="phone-review-foot" data-tone={action.kind === 'unknown' ? 'amber' : undefined}>
        {(offline || review.error) && (
          <p className="phone-review-foot-note" data-tone="amber">
            {offline ? COPY.offline(hostName) : review.error}
          </p>
        )}
        <div className="phone-review-foot-row">
          {action.kind === 'note' ? (
            <>
              <span className="phone-review-foot-text">{action.label}</span>
              <Button size="lg" variant="ghost" onClick={() => setPicked(undefined)}>
                {COPY.cancel}
              </Button>
              <Button size="lg" variant="primary" onClick={() => setWritingNote(true)}>
                {COPY.write}
              </Button>
            </>
          ) : action.kind === 'unknown' ? (
            <>
              <span className="phone-review-foot-text" data-lock="">
                <CircleHelp size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
                {COPY.unknown}
              </span>
              <Button size="lg" variant="ghost" disabled={review.busy || offline} onClick={() => void review.actions.abandonSend()}>
                {COPY.abandon}
              </Button>
              <Button size="lg" variant="outline" disabled={review.busy || offline} onClick={() => void review.actions.retrySend()}>
                {COPY.retrySame}
              </Button>
            </>
          ) : action.kind === 'send' ? (
            <>
              <Button size="lg" variant="ghost" disabled={review.busy} onClick={() => setAskClear(true)}>
                {COPY.clear}
              </Button>
              <Button
                size="lg"
                variant="primary"
                className="phone-review-primary"
                loading={review.busy}
                loadingLabel={COPY.sending}
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
                  {COPY.goCommit}
                </Button>
              )}
            </>
          )}
        </div>
      </footer>
      <Sheet
        open={writingNote && selection !== undefined}
        title={selection ? noteLinesLabel(selection) : COPY.feedback}
        onClose={() => {
          setWritingNote(false)
        }}
        action={
          <Button
            variant="primary"
            disabled={!text.trim() || review.busy}
            loading={review.busy}
            loadingLabel={COPY.adding}
            onClick={() => void submitNote()}>
            {COPY.add}
          </Button>
        }>
        <div className="phone-review-sheet">
          {picked && (
            <pre className="review-note-snippet" aria-label={COPY.selected}>
              {snippetOf(picked.sides[picked.selection.side], picked.selection).join('\n')}
            </pre>
          )}
          <TextAreaField
            label={COPY.feedback}
            rows={4}
            autoFocus
            placeholder={COPY.feedbackHint}
            value={text}
            onChange={event => {
              setText(event.target.value)
            }}
          />
        </div>
      </Sheet>
      {askClear && (
        <ConfirmDialog
          title={COPY.confirmClear(tally.ready.length)}
          confirmLabel={COPY.clear}
          danger
          message={COPY.clearMessage}
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
    <section className="review-notes-apart" aria-label={COPY.outside}>
      <p className="review-notes-apart-title">{COPY.outside}</p>
      {notes.map(note => (
        <NoteCard key={note.id} note={note} quote where={`${note.path} `} {...(writing ? { writing } : {})} />
      ))}
    </section>
  )
}
