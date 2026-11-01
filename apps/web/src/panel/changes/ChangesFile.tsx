import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, Copy, FileText, Plus, Undo2 } from 'lucide-react'
import type { ChangedFile, FileChangeDetail, FileMention } from '@latch/protocol'
import { Button, Collapse, ICON_STROKE, IconButton, useCopy } from '@latch/ui'
import { DiffLines, type DiffViewFile } from '../../components/DiffView.tsx'
import { escapeHiddenCharacters, VisibleText } from '../../components/VisibleText.tsx'
import { errorMessage } from '../../core/api.ts'
import type { DiffLine } from '../../diff.ts'
import { contentHidden, fileNote, fitPath, reviewOf } from './model.ts'

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
  onComment?: (mention: FileMention, line: number, text: string) => void
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

function FileBody({ file, layout, revision, read, onComment }: Pick<FileRowProps, 'file' | 'layout' | 'revision' | 'read' | 'onComment'>) {
  const [detail, setDetail] = useState<FileChangeDetail>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [commenting, setCommenting] = useState<DiffLine>()
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
  if (!detail.hunks?.length) return <p className="changes-body-note">{whyEmpty(detail.file)}</p>
  const { view, oldText, newText } = reviewOf(detail.hunks)
  const diff: DiffViewFile = {
    path: file.path,
    newText,
    ...(file.status === 'A' ? { previous: 'none', oldText: '' } : { oldText }),
    ...(file.status === 'D' ? { deleted: true } : {}),
  }
  return (
    <DiffLines
      diff={diff}
      view={view}
      layout={layout}
      {...(onComment
        ? {
            gutter: line => (
              <IconButton
                size="xs"
                icon={Plus}
                label={`评论第 ${line.newLine ?? line.oldLine} 行`}
                className="changes-comment-add"
                onClick={() => {
                  setCommenting(line)
                }}
              />
            ),
            annotation: line =>
              commenting === line ? (
                <CommentBox
                  key={line.newLine ?? line.oldLine}
                  onCancel={() => {
                    setCommenting(undefined)
                  }}
                  onSend={text => {
                    setCommenting(undefined)
                    onComment({ root: file.root, path: file.path }, line.newLine ?? line.oldLine ?? 1, text)
                  }}
                />
              ) : undefined,
          }
        : {})}
    />
  )
}

function CommentBox({ onCancel, onSend }: { onCancel: () => void; onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  const send = () => {
    if (text.trim()) onSend(text.trim())
  }
  return (
    <div
      className="changes-comment"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel()
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          send()
        }
      }}>
      <textarea
        aria-label="告诉 Harness"
        autoFocus
        rows={2}
        placeholder="告诉 Harness…"
        value={text}
        onChange={event => {
          setText(event.target.value)
        }}
      />
      <div className="changes-comment-actions">
        <Button size="xs" variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button size="xs" variant="primary" disabled={!text.trim()} onClick={send}>
          发送到对话
        </Button>
      </div>
    </div>
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
  onComment,
  read,
  twoLines,
}: FileRowProps) {
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
          <ChevronRight className="changes-chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
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
              </span>
            </span>
          ) : (
            <>
              <FittedPath text={shown} />
              <HeadFacts file={file} />
              {undone && <span className="changes-note">已撤销</span>}
            </>
          )}
        </button>
        {showActions && (
          <span className="changes-file-actions">
            <IconButton size="xs" icon={FileText} label="打开文件" onClick={onOpenFile} />
            {onUndo && <IconButton size="xs" icon={Undo2} label="撤销此文件" onClick={onUndo} />}
            <IconButton
              size="xs"
              icon={Copy}
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
          {open && <FileBody file={file} layout={layout} revision={revision} read={read} onComment={onComment} />}
        </div>
      </Collapse>
    </section>
  )
}
