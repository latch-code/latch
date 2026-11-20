import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'

import { noteLinesLabel, type ChangedFile, type ChangeScope, type FileChangeDetail, type ReviewNote } from '@latch/protocol'
import {
  Button,
  Collapse,
  ICON_STROKE,
  IconButton,
  Menu,
  useCopy,
  ChevronRightGlyph,
  AlertGlyph,
  CodeGlyph,
  CopyGlyph,
  FileGlyph,
  HistoryGlyph,
  MessageGlyph,
  PlusGlyph,
  UndoGlyph,
} from '@latch/ui'
import { DiffLines, type DiffViewFile } from '../../components/DiffView.tsx'
import { escapeHiddenCharacters, VisibleText } from '../../components/VisibleText.tsx'
import { errorMessage } from '../../core/api.ts'
import type { DiffLine } from '../../diff.ts'
import { contentHidden, fileNote, fitPath, reviewOf } from './model.ts'
import {
  inSelection,
  noted,
  notesUnder,
  numberOn,
  placeNotes,
  selectLine,
  sideOf,
  snippetOf,
  stepSelection,
  textLines,
  type LineSelection,
} from './notes.ts'
import { NoteCard, NoteEditor, type NoteWriting } from './ReviewNotes.tsx'
import { rowOf } from '../../components/overlays.tsx'
import { defineCopy, formatNumber, plural } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    newFile: '新文件',
    lineCount: (count: number) => ` · ${formatNumber(count)} 行`,
    deleted: '已删除',
    renamed: '重命名',
    conflict: '有冲突',
    mode: '执行位变化',
    secret: '可能含密钥，不显示内容',
    tooLarge: '超过 1 MB，不显示内容',
    binary: '二进制文件，没有可比较的文字',
    moved: '内容相同，只是换了路径',
    modeOnly: '内容没有变化，只改了执行位',
    unchanged: '内容没有变化',
    retry: '重试',
    loading: '正在读取…',
    beforeLine: (line: number) => `反馈修改前第 ${formatNumber(line)} 行`,
    line: (line: number) => `反馈第 ${formatNumber(line)} 行`,
    queue: '加入待发',
    feedbackCount: (count: number) => `${formatNumber(count)} 条反馈`,
    expired: '位置可能过期',
    undone: '已撤销',
    actions: (value1: string | number) => `${value1} 的操作`,
    open: '打开文件',
    history: '文件历史',
    copyPath: '复制路径',
    undoFile: '撤销此文件',
    copied: '已复制',
  },
  {
    newFile: 'New file',
    lineCount: (count: number) => ` · ${plural(count, { one: '{n} line', other: '{n} lines' })}`,
    deleted: 'Deleted',
    renamed: 'Renamed',
    conflict: 'Conflict',
    mode: 'Executable bit changed',
    secret: 'Contents are hidden because they may contain secret keys',
    tooLarge: 'Contents are hidden because the file exceeds 1 MB',
    binary: 'Binary file · No text to compare',
    moved: 'Same contents at a new path',
    modeOnly: 'Contents unchanged · Executable bit changed',
    unchanged: 'Contents unchanged',
    retry: 'Retry',
    loading: 'Reading…',
    beforeLine: (line: number) => `Give feedback on original line ${formatNumber(line)}`,
    line: (line: number) => `Give feedback on line ${formatNumber(line)}`,
    queue: 'Queue feedback',
    feedbackCount: (count: number) => `${plural(count, { one: '{n} feedback item', other: '{n} feedback items' })}`,
    expired: 'Location may be out of date',
    undone: 'Undone',
    actions: (value1: string | number) => `Actions for ${value1}`,
    open: 'Open file',
    history: 'File history',
    copyPath: 'Copy path',
    undoFile: 'Undo this file',
    copied: 'Copied',
  },
)

/**
 * Lines picked by the page around the diff (the phone's review): taps go to `onTap` with both sides' lines, for the
 * note's snippet, and the note is written in the page's sheet instead of under the lines.
 */
export interface ExternalPick {
  selection: LineSelection | undefined
  onTap: (line: DiffLine, sides: { old: string[]; new: string[] }) => void
}

/** A file's line feedback: the notes kept on it, and whether this device may add more. */
export interface FileNotes {
  notes: ReviewNote[]
  /** The diff new notes are anchored to; absent, no new notes from here. */
  anchor?: { scope: ChangeScope; turnId?: string }
  writing?: NoteWriting
  pick?: ExternalPick
}

export interface FileRowProps {
  file: ChangedFile
  open: boolean
  selected: boolean
  /** 撤销此文件 went through here: the list still shows what the turn recorded. */
  undone: boolean
  layout: 'unified' | 'split'
  /** Bumped when the list refreshes, so an open file reads its diff again. */
  revision: number
  /** Absent: no 撤销此文件 here. */
  onUndo?: () => void
  onToggle: () => void
  onOpenFile: () => void
  /** 在 <编辑器> 中打开, in the desktop app's own window: the label, and what it does. */
  editor?: { label: string; run(): void }
  /** 文件历史: the commits that changed this file. */
  onHistory?: () => void
  notes?: FileNotes
  read: (file: Pick<ChangedFile, 'root' | 'path'>, signal: AbortSignal) => Promise<FileChangeDetail>
  /** The phone's rows: the name over its folder, with the note. */
  twoLines: boolean
}

const HOVERLESS = () => typeof matchMedia === 'function' && matchMedia('(hover: none)').matches

/** Every path waiting to be fitted: one read of the layout for the whole list, however long it is. */
const waiting = new Map<HTMLElement, string>()
let characterPx = 0
function fitWaiting() {
  const batch = [...waiting]
  waiting.clear()
  for (const [element, text] of batch) element.textContent = text
  // `clientWidth` rounds: a path that exactly fits can read as half a pixel too wide for itself.
  const room = batch.map(([element]) => (element.isConnected ? element.clientWidth + 1 : 0))
  if (!characterPx && batch[0]) {
    const context = document.createElement('canvas').getContext('2d')
    if (context) {
      context.font = getComputedStyle(batch[0][0]).font
      characterPx = context.measureText('0').width
    }
  }
  batch.forEach(([element, text], index) => {
    const fitted = fitPath(text, room[index]!, characterPx)
    if (fitted !== text) element.textContent = fitted
  })
}
function fitSoon(element: HTMLElement, text: string) {
  if (!waiting.size) queueMicrotask(fitWaiting)
  waiting.set(element, text)
}

/** Every path on screen, refitted when its list changes width. One observer per list: rows come by the hundred. */
const fitted = new Map<HTMLElement, string>()
const watchedLists = new WeakSet<Element>()
const listWidths =
  typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        for (const [element, text] of fitted) fitSoon(element, text)
      })
    : undefined

/** A path that does not fit gives up whole leading folders, against the room it really has. */
function FittedPath({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return undefined
    fitted.set(element, text)
    fitSoon(element, text)
    const list = element.closest('.changes-list')
    if (list && !watchedLists.has(list)) {
      watchedLists.add(list)
      listWidths?.observe(list)
    }
    return () => {
      fitted.delete(element)
    }
  }, [text])
  return <span ref={ref} className="changes-path" title={text} />
}

function Stat({ add, del }: { add?: number; del?: number }) {
  if (add === undefined && del === undefined) return null
  return (
    <span className="changes-stat">
      {!!add && <span className="changes-add">+{add}</span>}
      {!!del && <span className="changes-del">−{del}</span>}
      {!add && !del && <span>±0</span>}
    </span>
  )
}

/** What the head says beside the path: a new or deleted file is itself, and the note says one thing. */
function HeadFacts({ file, lines, only }: { file: ChangedFile; lines?: number; only?: 'stat' | 'note' }) {
  const note = fileNote(file)
  const absent = contentHidden(file) || only === 'note'
  const addedLines = lines ?? file.add
  const deletedLines = lines ?? file.del
  return (
    <>
      {absent ? null : file.status === 'A' ? (
        <span className="changes-tag" data-tone="new">
          {COPY.newFile}
          {addedLines !== undefined ? COPY.lineCount(addedLines) : ''}
        </span>
      ) : file.status === 'D' ? (
        <span className="changes-tag" data-tone="gone">
          {COPY.deleted}
          {deletedLines !== undefined ? COPY.lineCount(deletedLines) : ''}
        </span>
      ) : file.status === 'R' && !file.add && !file.del ? (
        <span className="changes-note">{COPY.renamed}</span>
      ) : (
        <Stat add={file.add} del={file.del} />
      )}
      {only !== 'stat' && note && (
        <span className="changes-note" title={note.title}>
          {note.text}
        </span>
      )}
      {only !== 'stat' && file.conflicted && <span className="changes-note changes-note-warn">{COPY.conflict}</span>}
      {only !== 'stat' && file.modeChanged && <span className="changes-note">{COPY.mode}</span>}
    </>
  )
}

const whyEmpty = (file: ChangedFile) =>
  file.secret
    ? COPY.secret
    : file.large
      ? COPY.tooLarge
      : file.binary
        ? COPY.binary
        : file.status === 'R'
          ? COPY.moved
          : file.modeChanged
            ? COPY.modeOnly
            : COPY.unchanged

export function FileBody({
  file,
  layout,
  revision,
  read,
  notes,
  onStale,
  onDetail,
}: Pick<FileRowProps, 'file' | 'layout' | 'revision' | 'read' | 'notes'> & {
  onStale: (count: number) => void
  onDetail?: ((detail: FileChangeDetail | undefined) => void) | undefined
}) {
  const [answer, setAnswer] = useState<{ detail: FileChangeDetail; revision: number; attempt: number; read: FileRowProps['read'] }>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setError(undefined)
    read(file, controller.signal).then(
      detail => {
        if (!controller.signal.aborted) setAnswer({ detail, revision, attempt, read })
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause))
      },
    )
    return () => {
      controller.abort()
    }
  }, [file.root, file.path, revision, attempt, read])
  const detail = answer?.detail
  const fresh = !error && answer?.revision === revision && answer.attempt === attempt && answer.read === read
  useEffect(() => {
    onDetail?.(fresh ? detail : undefined)
  }, [detail, fresh, onDetail])
  if (error)
    return (
      <p className="changes-body-note">
        {error}
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setAttempt(value => value + 1)
          }}>
          {COPY.retry}
        </Button>
      </p>
    )
  if (!detail) return <p className="changes-body-note">{COPY.loading}</p>
  if (!detail.hunks?.length)
    return (
      <>
        {notes?.notes.map(note => (
          <NoteCard key={note.id} note={note} quote {...(notes.writing ? { writing: notes.writing } : {})} />
        ))}
        <p className="changes-body-note">{whyEmpty(detail.file)}</p>
      </>
    )
  return <FileReview file={file} detail={detail} layout={layout} notes={notes} onStale={onStale} />
}

const HOVERLESS_NOW = () => typeof matchMedia === 'function' && matchMedia('(hover: none)').matches

/** One file's diff with its notes: picked lines, the box for a new note under them, and each kept note in its place. */
function FileReview({
  file,
  detail,
  layout,
  notes,
  onStale,
}: {
  file: ChangedFile
  detail: FileChangeDetail
  layout: 'unified' | 'split'
  notes: FileNotes | undefined
  onStale: (count: number) => void
}) {
  const [own, setSelection] = useState<LineSelection>()
  const pick = notes?.pick
  const selection = pick ? pick.selection : own
  const kept = notes?.notes ?? []
  const texts = useMemo(() => reviewOf(detail.hunks!), [detail])
  const placed = useMemo(() => placeNotes(kept, texts.oldText, texts.newText), [kept, texts])
  const { view, oldText, newText } = useMemo(
    () => (kept.length || selection ? reviewOf(detail.hunks!, line => noted(placed, kept, line) || inSelection(selection, line)) : texts),
    [detail, texts, kept, placed, selection],
  )
  useEffect(() => {
    onStale(placed.stale.length)
  }, [placed.stale.length, onStale])
  const sides = useMemo(() => ({ old: textLines(oldText), new: textLines(newText) }), [oldText, newText])
  const diff: DiffViewFile = {
    path: file.path,
    newText,
    ...(file.status === 'A' ? { previous: 'none', oldText: '' } : { oldText }),
    ...(file.status === 'D' ? { deleted: true } : {}),
  }
  const anchor = notes?.anchor
  const writing = notes?.writing
  const press = (line: DiffLine) => (event: MouseEvent) => {
    if (pick) {
      pick.onTap(line, sides)
      return
    }
    setSelection(current => selectLine(current, line, event.shiftKey || (HOVERLESS_NOW() && current !== undefined)))
  }
  const step = (event: KeyboardEvent) => {
    if (pick || !event.shiftKey || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || !selection) return
    event.preventDefault()
    setSelection(stepSelection(selection, event.key === 'ArrowDown' ? 1 : -1, sides[selection.side].length))
  }
  return (
    <>
      {placed.stale.map(note => (
        <NoteCard key={note.id} note={note} stale {...(writing ? { writing } : {})} />
      ))}
      <DiffLines
        diff={diff}
        view={view}
        layout={layout}
        lineMark={line => (inSelection(selection, line) ? 'selected' : noted(placed, kept, line) ? 'noted' : undefined)}
        {...(anchor && writing
          ? {
              gutter: (line: DiffLine) => {
                const side = sideOf(line),
                  number = numberOn(line, side)
                return number === undefined ? null : (
                  <IconButton
                    size="xs"
                    icon={PlusGlyph}
                    label={side === 'old' ? COPY.beforeLine(number) : COPY.line(number)}
                    className="changes-comment-add"
                    pressed={inSelection(selection, line)}
                    onClick={press(line)}
                    onKeyDown={step}
                  />
                )
              },
            }
          : {})}
        annotation={line => {
          const under = notesUnder(placed, line)
          const editing = !pick && anchor && writing && selection && numberOn(line, selection.side) === selection.end
          if (!under.length && !editing) return undefined
          return (
            <>
              {under.map(note => {
                const at = placed.located.get(note.id)
                return <NoteCard key={note.id} note={note} {...(at ? { at } : {})} {...(writing ? { writing } : {})} />
              })}
              {editing && (
                <NoteEditor
                  key={`${selection.side}:${selection.start}`}
                  label={noteLinesLabel(selection)}
                  submitLabel={COPY.queue}
                  busy={writing.busy}
                  onCancel={() => {
                    setSelection(undefined)
                  }}
                  onStep={by => {
                    setSelection(stepSelection(selection, by, sides[selection.side].length))
                  }}
                  onSubmit={async text => {
                    const done = await writing.actions.create({
                      root: file.root,
                      path: file.path,
                      range: { start: selection.start, end: selection.end },
                      side: selection.side,
                      scope: anchor.scope,
                      ...(anchor.turnId ? { turnId: anchor.turnId } : {}),
                      lines: snippetOf(sides[selection.side], selection),
                      text,
                    })
                    if (done) setSelection(undefined)
                    return done
                  }}
                />
              )}
            </>
          )
        }}
      />
    </>
  )
}

/** The head's word on the file's notes: how many, and whether any lost their place. */
function NoteFacts({ count, stale }: { count: number; stale: number }) {
  if (!count) return null
  return (
    <>
      <span className="changes-note review-note-count" title={COPY.feedbackCount(count)}>
        <MessageGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        {count}
      </span>
      {stale > 0 && (
        <span className="changes-note changes-note-warn">
          <AlertGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
          {COPY.expired}
        </span>
      )}
    </>
  )
}

/** One file: a 32px sticky head and, once opened, its diff, read only then. */
export function ChangesFile({
  file,
  open,
  selected,
  undone,
  layout,
  revision,
  onUndo,
  onToggle,
  onOpenFile,
  editor,
  onHistory,
  notes,
  read,
  twoLines,
}: FileRowProps) {
  const [stale, setStale] = useState(0)
  const shown = escapeHiddenCharacters(file.oldPath ? `${file.oldPath} → ${file.path}` : file.path)
  const { state: copyState, copy } = useCopy()
  const hidden = file.secret || file.notRetained || file.large
  const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
  // Each action carries a tooltip; a long list mounts them only for the row in use.
  const [touched, setTouched] = useState(false)
  const showActions = touched || open || selected || HOVERLESS()
  return (
    <section
      className="changes-file"
      data-open={open ? '' : undefined}
      data-selected={selected ? '' : undefined}
      data-file-undone={undone ? '' : undefined}>
      <div
        className="changes-file-head"
        onPointerEnter={() => {
          setTouched(true)
        }}
        onFocusCapture={() => {
          setTouched(true)
        }}>
        <button type="button" className="changes-file-toggle" aria-expanded={open} disabled={Boolean(hidden)} onClick={onToggle}>
          <ChevronRightGlyph className="changes-chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
          {twoLines ? (
            <span className="changes-file-lines">
              <span className="changes-file-line">
                <span className="changes-path">
                  <VisibleText text={file.path.split('/').at(-1)!} />
                </span>
                <HeadFacts file={file} only="stat" />
              </span>
              <span className="changes-file-line changes-file-folder">
                {folder && (
                  <span className="changes-file-folder-name">
                    <VisibleText text={folder} />
                  </span>
                )}
                <HeadFacts file={file} only="note" />
                {undone && <span className="changes-note">{COPY.undone}</span>}
                <NoteFacts count={notes?.notes.length ?? 0} stale={stale} />
              </span>
            </span>
          ) : (
            <>
              <FittedPath text={shown} />
              <HeadFacts file={file} />
              {undone && <span className="changes-note">{COPY.undone}</span>}
              <NoteFacts count={notes?.notes.length ?? 0} stale={stale} />
            </>
          )}
        </button>
        {/* The head's hover actions as its context menu too: right click, press and hold, the context-menu key. */}
        <Menu
          label={COPY.actions(escapeHiddenCharacters(file.path))}
          context={rowOf('.changes-file-head')}
          sections={[
            {
              id: 'file',
              items: [
                { id: 'open', label: COPY.open, icon: FileGlyph, onSelect: onOpenFile },
                ...(editor && !file.secret && !file.binary && file.status !== 'D'
                  ? [{ id: 'editor', label: editor.label, icon: CodeGlyph, onSelect: editor.run }]
                  : []),
                ...(onHistory ? [{ id: 'history', label: COPY.history, icon: HistoryGlyph, onSelect: onHistory }] : []),
                { id: 'copy', label: COPY.copyPath, icon: CopyGlyph, onSelect: () => void copy(file.path) },
              ],
            },
            ...(onUndo
              ? [{ id: 'undo', items: [{ id: 'undo', label: COPY.undoFile, icon: UndoGlyph, danger: true, onSelect: onUndo }] }]
              : []),
          ]}
        />
        {showActions && (
          <span className="changes-file-actions">
            <IconButton size="xs" icon={FileGlyph} label={COPY.open} onClick={onOpenFile} />
            {editor && !file.secret && !file.binary && file.status !== 'D' && (
              <IconButton size="xs" icon={CodeGlyph} label={editor.label} onClick={editor.run} />
            )}
            {onHistory && <IconButton size="xs" icon={HistoryGlyph} label={COPY.history} onClick={onHistory} />}
            {onUndo && <IconButton size="xs" icon={UndoGlyph} label={COPY.undoFile} onClick={onUndo} />}
            <IconButton
              size="xs"
              icon={CopyGlyph}
              label={copyState === 'copied' ? COPY.copied : COPY.copyPath}
              onClick={() => {
                void copy(file.path)
              }}
            />
          </span>
        )}
      </div>
      <Collapse open={open} lazy>
        <div className="changes-file-body">
          {open && <FileBody file={file} layout={layout} revision={revision} read={read} notes={notes} onStale={setStale} />}
        </div>
      </Collapse>
    </section>
  )
}
