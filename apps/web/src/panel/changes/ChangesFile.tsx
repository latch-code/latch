import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'

import { noteLinesLabel, type ChangedFile, type ChangeScope, type FileChangeDetail, type ReviewNote } from '@latch/protocol'
import {
  Button,
  Collapse,
  ICON_STROKE,
  IconButton,
  useCopy,
  ChevronRightGlyph,
  AlertGlyph,
  CodeGlyph,
  CopyGlyph,
  FileGlyph,
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
  return (
    <>
      {absent ? null : file.status === 'A' ? (
        <span className="changes-tag" data-tone="new">
          新文件{(lines ?? file.add) !== undefined ? ` · ${lines ?? file.add} 行` : ''}
        </span>
      ) : file.status === 'D' ? (
        <span className="changes-tag" data-tone="gone">
          已删除{(lines ?? file.del) !== undefined ? ` · ${lines ?? file.del} 行` : ''}
        </span>
      ) : file.status === 'R' && !file.add && !file.del ? (
        <span className="changes-note">重命名</span>
      ) : (
        <Stat add={file.add} del={file.del} />
      )}
      {only !== 'stat' && note && (
        <span className="changes-note" title={note.title}>
          {note.text}
        </span>
      )}
      {only !== 'stat' && file.conflicted && <span className="changes-note changes-note-warn">有冲突</span>}
      {only !== 'stat' && file.modeChanged && <span className="changes-note">执行位变化</span>}
    </>
  )
}

const whyEmpty = (file: ChangedFile) =>
  file.binary
    ? '二进制文件，没有可比较的文字'
    : file.status === 'R'
      ? '内容相同，只是换了路径'
      : file.modeChanged
        ? '内容没有变化，只改了执行位'
        : '内容没有变化'

export function FileBody({
  file,
  layout,
  revision,
  read,
  notes,
  onStale,
}: Pick<FileRowProps, 'file' | 'layout' | 'revision' | 'read' | 'notes'> & { onStale: (count: number) => void }) {
  const [detail, setDetail] = useState<FileChangeDetail>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setError(undefined)
    read(file, controller.signal).then(
      answer => {
        if (!controller.signal.aborted) setDetail(answer)
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause))
      },
    )
    return () => {
      controller.abort()
    }
  }, [file.root, file.path, revision, attempt, read])
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
          重试
        </Button>
      </p>
    )
  if (!detail) return <p className="changes-body-note">正在读取…</p>
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
                    label={side === 'old' ? `反馈修改前第 ${number} 行` : `反馈第 ${number} 行`}
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
                  submitLabel="加入待发"
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
      <span className="changes-note review-note-count" title={`${count} 条反馈`}>
        <MessageGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        {count}
      </span>
      {stale > 0 && (
        <span className="changes-note changes-note-warn">
          <AlertGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
          位置可能过期
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
                {undone && <span className="changes-note">已撤销</span>}
                <NoteFacts count={notes?.notes.length ?? 0} stale={stale} />
              </span>
            </span>
          ) : (
            <>
              <FittedPath text={shown} />
              <HeadFacts file={file} />
              {undone && <span className="changes-note">已撤销</span>}
              <NoteFacts count={notes?.notes.length ?? 0} stale={stale} />
            </>
          )}
        </button>
        {showActions && (
          <span className="changes-file-actions">
            <IconButton size="xs" icon={FileGlyph} label="打开文件" onClick={onOpenFile} />
            {editor && !file.secret && !file.binary && file.status !== 'D' && (
              <IconButton size="xs" icon={CodeGlyph} label={editor.label} onClick={editor.run} />
            )}
            {onUndo && <IconButton size="xs" icon={UndoGlyph} label="撤销此文件" onClick={onUndo} />}
            <IconButton
              size="xs"
              icon={CopyGlyph}
              label={copyState === 'copied' ? '已复制' : '复制路径'}
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
