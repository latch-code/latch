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
import { defineCopy, formatNumber, plural } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    staging: '暂存中…',
    unstaging: '取消暂存中…',
    more: (count: number) => `还有 ${formatNumber(count)} 个`,
    stage: '暂存',
    unstage: '取消暂存',
    selected: (count: number) => `已选 ${formatNumber(count)} 行`,
    changed: (count: number) => `${formatNumber(count)} 行改动`,
    selectHunk: '选这一块',
    clear: '清除',
    all: '全选',
    selection: '所选',
    removed: (line: number) => `删除的第 ${formatNumber(line)} 行`,
    added: (line: number) => `新增的第 ${formatNumber(line)} 行`,
    conflict: '冲突',
    untracked: '未跟踪',
    writing: '正在写入',
    open: '打开文件',
    history: '文件历史',
    file: '文件',
    reading: '正在读取…',
    unknown: ' · 暂存结果未知',
    retrying: '重试中…',
    retrySame: '重试同一请求',
    verifyDismiss: '核对并放下',
    unstagedCount: (count: number) => `未暂存 ${formatNumber(count)}`,
    unstaged: '未暂存',
    stagedCount: (count: number) => `已暂存 ${formatNumber(count)}`,
    staged: '已暂存',
    readFailed: '读不到暂存状态',
    retry: '重试',
    noUnstaged: '没有未暂存的改动',
    noStaged: '没有已暂存的改动',
    merge: '合并进行中，在终端里完成',
  },
  {
    staging: 'Staging…',
    unstaging: 'Unstaging…',
    more: (count: number) => `${formatNumber(count)} more`,
    stage: 'Stage',
    unstage: 'Unstage',
    selected: (count: number) => `${plural(count, { one: '{n} line', other: '{n} lines' })} selected`,
    changed: (count: number) => `${formatNumber(count)} changed lines`,
    selectHunk: 'Select this hunk',
    clear: 'Clear',
    all: 'Select all',
    selection: ' selected',
    removed: (line: number) => `Deleted line ${formatNumber(line)}`,
    added: (line: number) => `Added line ${formatNumber(line)}`,
    conflict: 'Conflict',
    untracked: 'Untracked',
    writing: 'Writing',
    open: 'Open file',
    history: 'File history',
    file: ' file',
    reading: 'Reading…',
    unknown: ' · Staging outcome unknown',
    retrying: 'Retrying…',
    retrySame: 'Retry same request',
    verifyDismiss: 'Check and dismiss',
    unstagedCount: (count: number) => `Unstaged ${formatNumber(count)}`,
    unstaged: 'Unstaged',
    stagedCount: (count: number) => `Staged ${formatNumber(count)}`,
    staged: 'Staged',
    readFailed: 'Couldn’t read staging status',
    retry: 'Retry',
    noUnstaged: 'No unstaged changes',
    noStaged: 'No staged changes',
    merge: 'Merge in progress · Finish in Terminal',
  },
)

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

const VERB: Record<GitStagingView, string> = {
  get unstaged() {
    return COPY.stage
  },
  get staged() {
    return COPY.unstage
  },
}

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
        <span className="staging-count">{count ? COPY.selected(count) : COPY.changed(order.length)}</span>
        <span className="changes-scope-space" />
        <Button
          size="xs"
          variant="ghost"
          disabled={!pick.anchor}
          onClick={() => {
            if (pick.anchor) setPick(toggleBlock(pick, order, pick.anchor))
          }}>
          {COPY.selectHunk}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setPick(count === order.length ? EMPTY_PICK : pickAll(order))
          }}>
          {count === order.length ? COPY.clear : COPY.all}
        </Button>
        <Button
          size="xs"
          variant="primary"
          disabled={!count || !canWrite}
          loading={busy}
          loadingLabel={view === 'unstaged' ? COPY.staging : COPY.unstaging}
          onClick={() => {
            void onWrite(pick).then(end => {
              if (end === 'done' || end === 'stale') setPick(EMPTY_PICK)
            })
          }}>
          {VERB[view]}
          {COPY.selection}
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
          const number = line.kind === 'remove' ? line.oldLine : line.newLine
          if (!key || number === undefined) return null
          const checked = pick.lines.has(key)
          return (
            <button
              type="button"
              role="checkbox"
              aria-checked={checked}
              aria-label={line.kind === 'remove' ? COPY.removed(number) : COPY.added(number)}
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
  const word = row.conflicted ? COPY.conflict : row.untracked ? COPY.untracked : STATUS_WORD[row.status]
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
          {busy && <Spinner size={12} label={COPY.writing} />}
          {note && <span className="changes-note">{note}</span>}
        </button>
        <span className="changes-file-actions staging-file-actions">
          <IconButton size="xs" icon={FileGlyph} label={COPY.open} onClick={onOpenFile} />
          {!row.untracked && <IconButton size="xs" icon={HistoryGlyph} label={COPY.history} onClick={onHistory} />}
          {!row.conflicted && (
            <Button
              size="xs"
              variant="ghost"
              disabled={!canWrite || busy}
              onClick={() => {
                void staging.writeWhole(view === 'unstaged' ? 'stage' : 'unstage', row.path)
              }}>
              {VERB[view]}
              {COPY.file}
            </Button>
          )}
        </span>
      </div>
      <Collapse open={open} lazy>
        <div className="changes-file-body">
          {!open ? null : error ? (
            <p className="changes-body-note">{error}</p>
          ) : !diff ? (
            <p className="changes-body-note">{COPY.reading}</p>
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
          <VisibleText text={unknown.path} />
          {COPY.unknown}
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={offline}
          loading={busy === unknown.path}
          loadingLabel={COPY.retrying}
          onClick={() => {
            void staging.retry()
          }}>
          {COPY.retrySame}
        </Button>
        <Button size="xs" variant="ghost" disabled={busy !== undefined} onClick={staging.abandon}>
          {COPY.verifyDismiss}
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
          label={COPY.stage}
          size="xs"
          value={view}
          options={[
            { value: 'unstaged', label: counts ? COPY.unstagedCount(counts.unstaged) : COPY.unstaged },
            { value: 'staged', label: counts ? COPY.stagedCount(counts.staged) : COPY.staged },
          ]}
          onValueChange={onView}
        />
        {read.kind === 'ready' && read.state.more ? <span className="changes-why">{COPY.more(read.state.more)}</span> : null}
        {!canWrite && whyNot && <span className="changes-why">{whyNot}</span>}
      </div>
      {read.kind === 'loading' ? (
        <div className="changes-empty">
          <p className="changes-empty-title">{COPY.reading}</p>
        </div>
      ) : read.kind === 'failed' ? (
        <div className="changes-empty">
          <div>
            <p className="changes-empty-title">{COPY.readFailed}</p>
            <p className="changes-empty-detail">{read.text}</p>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void staging.reload()
              }}>
              {COPY.retry}
            </Button>
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="changes-empty">
          <p className="changes-empty-title">{view === 'unstaged' ? COPY.noUnstaged : COPY.noStaged}</p>
        </div>
      ) : (
        <div className="changes-body">
          <div className="changes-list">
            {read.state.gitOperation && (
              <div className="changes-line" data-tone="amber">
                <AlertGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
                <span className="changes-line-text">{COPY.merge}</span>
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
