import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { GitHunkDiff, GitStagingView } from '@latch/protocol'
import {
  Button,
  Collapse,
  HistoryGlyph,
  ICON_STROKE,
  IconButton,
  SegmentedControl,
  Spinner,
  AlertGlyph,
  ChevronRightGlyph,
  FileGlyph,
  UnknownGlyph,
  WarningGlyph,
} from '@latch/ui'
import { DiffLines, type DiffViewFile } from '../../components/DiffView.tsx'
import { escapeHiddenCharacters, VisibleText } from '../../components/VisibleText.tsx'
import { errorMessage } from '../../core/api.ts'
import type { DiffLine } from '../../diff.ts'
import { STATUS_WORD } from '../delivery/model.ts'
import { reviewOf } from './model.ts'
import {
  changedLines,
  EMPTY_PICK,
  extendTo,
  keepPick,
  keyOf,
  keyStep,
  pickAll,
  stagingRows,
  toggleBlock,
  toggleLine,
  viewCounts,
  wholeNote,
  type LineKey,
  type LinePick,
  type StagingRow,
} from './staging.ts'
import type { StagingEnd, useStaging } from './useStaging.ts'

export interface StagingViewProps {
  staging: ReturnType<typeof useStaging>
  view: GitStagingView
  onView: (view: GitStagingView) => void
  /** The device may write here now: `run`, a session that takes input, online, and no turn running in it. */
  canWrite: boolean
  /** Why it may not, in a few words; shown in place of the buttons. */
  whyNot?: string
  onOpenFile: (path: string) => void
  onHistory: (path: string) => void
}

const VERB: Record<GitStagingView, string> = { unstaged: '暂存', staged: '取消暂存' }

/** One file's lines with a box on each changed line; the pick goes to the Host as line numbers. */
export function PickableDiff({
  diff,
  view,
  busy,
  canWrite,
  onWrite,
}: {
  diff: GitHunkDiff
  view: GitStagingView
  busy: boolean
  canWrite: boolean
  onWrite: (pick: LinePick) => Promise<StagingEnd>
}) {
  const hunks = diff.hunks!
  const order = useMemo(() => changedLines(hunks), [hunks])
  const [pick, setPick] = useState<LinePick>(EMPTY_PICK)
  // A diff read again keeps the lines that are still changes; the rest of the pick is gone with them.
  useEffect(() => {
    setPick(current => keepPick(current, order))
  }, [order])
  const shown = useMemo(() => reviewOf(hunks), [hunks])
  const file: DiffViewFile = { path: diff.path, oldText: shown.oldText, newText: shown.newText }
  const body = useRef<HTMLDivElement>(null)
  const focus = (key: LineKey) => {
    requestAnimationFrame(() => {
      body.current?.querySelector<HTMLElement>(`[data-stage-key="${key}"]`)?.focus()
    })
  }
  const press = (key: LineKey) => (event: MouseEvent) => {
    setPick(current => (event.shiftKey && current.anchor ? extendTo(current, order, key) : toggleLine(current, key)))
  }
  const keyDown = (key: LineKey) => (event: KeyboardEvent) => {
    const step = keyStep(pick, order, key, event)
    if (!step) return
    event.preventDefault()
    setPick(step.pick)
    if (step.focus !== key) focus(step.focus)
  }
  const count = pick.lines.size
  return (
    <div ref={body} className="staging-diff">
      <div className="staging-tools">
        <span className="staging-count">{count ? `已选 ${count} 行` : `${order.length} 行改动`}</span>
        <span className="changes-scope-space" />
        <Button
          size="xs"
          variant="ghost"
          disabled={!pick.anchor}
          onClick={() => {
            if (pick.anchor) setPick(toggleBlock(pick, order, pick.anchor))
          }}>
          选这一块
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setPick(count === order.length ? EMPTY_PICK : pickAll(order))
          }}>
          {count === order.length ? '清除' : '全选'}
        </Button>
        <Button
          size="xs"
          variant="primary"
          disabled={!count || !canWrite}
          loading={busy}
          loadingLabel={`${VERB[view]}中…`}
          onClick={() => {
            void onWrite(pick).then(end => {
              if (end === 'done' || end === 'stale') setPick(EMPTY_PICK)
            })
          }}>
          {VERB[view]}所选
        </Button>
      </div>
      <DiffLines
        diff={file}
        view={shown.view}
        layout="unified"
        lineMark={(line: DiffLine) => {
          const key = keyOf(line)
          return key && pick.lines.has(key) ? 'selected' : undefined
        }}
        gutter={(line: DiffLine) => {
          const key = keyOf(line)
          if (!key) return null
          const checked = pick.lines.has(key)
          const number = line.kind === 'remove' ? line.oldLine : line.newLine
          return (
            <button
              type="button"
              role="checkbox"
              aria-checked={checked}
              aria-label={line.kind === 'remove' ? `删除的第 ${number} 行` : `新增的第 ${number} 行`}
              className="staging-check"
              data-stage-key={key}
              onClick={press(key)}
              onDoubleClick={() => {
                setPick(current => toggleBlock({ ...current, lines: new Set(current.lines).add(key) }, order, key))
              }}
              onKeyDown={keyDown(key)}
              // Space is handled on the way down; the click a button makes of it on the way up would flip the line back.
              onKeyUp={event => {
                if (event.key === ' ') event.preventDefault()
              }}
            />
          )
        }}
      />
    </div>
  )
}

function StagingFile({
  row,
  view,
  open,
  revision,
  busy,
  canWrite,
  note,
  staging,
  onToggle,
  onOpenFile,
  onHistory,
}: {
  row: StagingRow
  view: GitStagingView
  open: boolean
  revision: number
  busy: boolean
  canWrite: boolean
  note: string | undefined
  staging: ReturnType<typeof useStaging>
  onToggle: () => void
  onOpenFile: () => void
  onHistory: () => void
}) {
  const [diff, setDiff] = useState<GitHunkDiff>()
  const [error, setError] = useState<string>()
  const { diff: readDiff } = staging
  useEffect(() => {
    if (!open) return undefined
    const controller = new AbortController()
    setError(undefined)
    readDiff(view, row.path, controller.signal).then(
      answer => {
        if (!controller.signal.aborted) setDiff(answer)
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause))
      },
    )
    return () => {
      controller.abort()
    }
  }, [open, view, row.path, revision, readDiff])
  const whole = diff?.whole
  const word = row.conflicted ? '冲突' : row.untracked ? '未跟踪' : STATUS_WORD[row.status]
  return (
    <section className="changes-file" data-open={open ? '' : undefined}>
      <div className="changes-file-head">
        <button type="button" className="changes-file-toggle" aria-expanded={open} onClick={onToggle}>
          <ChevronRightGlyph className="changes-chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
          <span className="changes-path" title={escapeHiddenCharacters(row.path)}>
            <VisibleText text={row.path} />
          </span>
          <span className={row.conflicted ? 'changes-note changes-note-warn' : 'changes-note'}>{word}</span>
          {diff && !whole && (
            <span className="changes-stat">
              {!!diff.add && <span className="changes-add">+{diff.add}</span>}
              {!!diff.del && <span className="changes-del">−{diff.del}</span>}
            </span>
          )}
          {busy && <Spinner size={12} label="正在写入" />}
          {note && <span className="changes-note">{note}</span>}
        </button>
        <span className="changes-file-actions staging-file-actions">
          <IconButton size="xs" icon={FileGlyph} label="打开文件" onClick={onOpenFile} />
          {!row.untracked && <IconButton size="xs" icon={HistoryGlyph} label="文件历史" onClick={onHistory} />}
          {!row.conflicted && (
            <Button
              size="xs"
              variant="ghost"
              disabled={!canWrite || busy}
              onClick={() => {
                void staging.writeWhole(view === 'unstaged' ? 'stage' : 'unstage', row.path)
              }}>
              {VERB[view]}文件
            </Button>
          )}
        </span>
      </div>
      <Collapse open={open} lazy>
        <div className="changes-file-body">
          {!open ? null : error ? (
            <p className="changes-body-note">{error}</p>
          ) : !diff ? (
            <p className="changes-body-note">正在读取…</p>
          ) : whole ? (
            <p className="changes-body-note">{wholeNote(whole, view)}</p>
          ) : (
            <PickableDiff
              diff={diff}
              view={view}
              busy={busy}
              canWrite={canWrite}
              onWrite={pick => staging.writeLines(view === 'unstaged' ? 'stage' : 'unstage', row.path, diff.base ?? {}, pick)}
            />
          )}
        </div>
      </Collapse>
    </section>
  )
}

/** The recovery controls stay on the changes panel while the user reads another scope. */
export function StagingFeedback({ staging, offline }: { staging: ReturnType<typeof useStaging>; offline: boolean }) {
  const { unknown, busy, note } = staging
  if (!unknown) return null
  return (
    <>
      <div className="changes-line staging-receipt" data-tone="muted">
        <UnknownGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        <span className="changes-line-text">
          <VisibleText text={unknown.path} /> · 暂存结果未知
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={offline}
          loading={busy === unknown.path}
          loadingLabel="重试中…"
          onClick={() => {
            void staging.retry()
          }}>
          重试同一请求
        </Button>
        <Button size="xs" variant="ghost" disabled={busy !== undefined} onClick={staging.abandon}>
          核对并放下
        </Button>
      </div>
      {note && (
        <div className="changes-line" data-tone="amber">
          <WarningGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          <span className="changes-line-text">{note.text}</span>
        </div>
      )}
    </>
  )
}

/**
 * 未暂存 and 已暂存, kept apart: each lists its files from the Host's status, and an open file shows its lines with a
 * box on every changed one. 「暂存所选」 or 「取消暂存所选」 is the one blue action; a file whose lines cannot be picked
 * says why in a few words and goes whole.
 */
export function StagingView({ staging, view, onView, canWrite, whyNot, onOpenFile, onHistory }: StagingViewProps) {
  const { read, revision, busy, note, unknown } = staging
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  if (read.kind === 'denied') return null
  const rows = read.kind === 'ready' ? stagingRows(read.state, view) : []
  const counts = read.kind === 'ready' ? viewCounts(read.state) : undefined
  const writable = canWrite && !busy && !unknown && !(read.kind === 'ready' && read.state.running)
  return (
    <>
      <div className="changes-line staging-bar">
        <SegmentedControl
          label="暂存"
          size="xs"
          value={view}
          options={[
            { value: 'unstaged', label: counts ? `未暂存 ${counts.unstaged}` : '未暂存' },
            { value: 'staged', label: counts ? `已暂存 ${counts.staged}` : '已暂存' },
          ]}
          onValueChange={onView}
        />
        {read.kind === 'ready' && read.state.more ? <span className="changes-why">还有 {read.state.more} 个</span> : null}
        {!canWrite && whyNot && <span className="changes-why">{whyNot}</span>}
      </div>
      {read.kind === 'loading' ? (
        <div className="changes-empty">
          <p className="changes-empty-title">正在读取…</p>
        </div>
      ) : read.kind === 'failed' ? (
        <div className="changes-empty">
          <div>
            <p className="changes-empty-title">读不到暂存状态</p>
            <p className="changes-empty-detail">{read.text}</p>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void staging.reload()
              }}>
              重试
            </Button>
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="changes-empty">
          <p className="changes-empty-title">{view === 'unstaged' ? '没有未暂存的改动' : '没有已暂存的改动'}</p>
        </div>
      ) : (
        <div className="changes-body">
          <div className="changes-list">
            {read.state.gitOperation && (
              <div className="changes-line" data-tone="amber">
                <AlertGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
                <span className="changes-line-text">合并进行中，在终端里完成</span>
              </div>
            )}
            {rows.map(row => (
              <StagingFile
                key={`${view}\n${row.path}`}
                row={row}
                view={view}
                open={opened.has(row.path)}
                revision={revision}
                busy={busy === row.path}
                canWrite={writable && !read.state.gitOperation}
                note={!unknown && note?.path === row.path ? note.text : undefined}
                staging={staging}
                onToggle={() => {
                  const next = new Set(opened)
                  if (next.has(row.path)) next.delete(row.path)
                  else next.add(row.path)
                  setOpened(next)
                }}
                onOpenFile={() => {
                  onOpenFile(row.path)
                }}
                onHistory={() => {
                  onHistory(row.path)
                }}
              />
            ))}
          </div>
        </div>
      )}
    </>
  )
}
