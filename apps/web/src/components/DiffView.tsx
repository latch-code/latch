import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from 'react'

import type { FileDiff } from '@latch/protocol'
import {
  compactLines,
  diffLines,
  knowsOldSide,
  openedGap,
  previousState,
  sideBySideLines,
  wordHighlights,
  type DiffGap,
  type DiffLine,
  type LineDiff,
  type PreviousState,
  type TextRange,
} from '../diff.ts'
import { middleEllipsis } from '../format.ts'
import { Collapse, Icon, ICON_STROKE, StatusPill, ChevronRightGlyph, UpDownGlyph } from '@latch/ui'
import { escapeHiddenCharacters, hasHiddenCharacters, VisibleText } from './VisibleText.tsx'
import { useHighlightedTokens, SyntaxLine } from '../preview/HighlightedCode.tsx'
import { languageForPath, type SyntaxLines } from '../preview/highlight-protocol.ts'
import { defineCopy, plural, formatNumber } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    before: '修改前',
    after: '修改后',
    code: (value1: string) => `${value1}代码`,
    added: '新增：',
    removed: '删除：',
    newFile: '新文件',
    deleted: '已删除',
    lineCount: (value1: string, count: number) => `${value1} · ${formatNumber(count)} 行`,
    unchanged: ' 行未改动',
    noChange: '内容没有变化',
    moreLines: (count: number) => `还有 ${formatNumber(count)} 行`,
    moreChanged: (count: number) => `还有 ${formatNumber(count)} 行改动`,
    renamedFrom: '重命名自 ',
    changes: (value1: string) => `${value1} 的改动`,
    expand: (count: number) => plural(count, { other: '展开其余 {n} 行' }),
    binary: '二进制文件，没有可比较的文字',
  },
  {
    before: 'Before',
    after: 'After',
    code: (value1: string) => `${value1} code`,
    added: 'Added: ',
    removed: 'Removed: ',
    newFile: 'New file',
    deleted: 'Deleted',
    lineCount: (value1: string, count: number) => `${value1} · ${plural(count, { one: '{n} line', other: '{n} lines' })}`,
    unchanged: ' unchanged lines',
    noChange: 'No changes to the content',
    moreLines: (count: number) => `${formatNumber(count)} more lines`,
    moreChanged: (count: number) => `${formatNumber(count)} more changed lines`,
    renamedFrom: 'Renamed from ',
    changes: (value1: string) => `Changes to ${value1}`,
    expand: (count: number) => plural(count, { one: 'Show {n} more line', other: 'Show {n} more lines' }),
    binary: 'Binary file, no text to compare',
  },
)

/** Lines rendered before "显示全部"; long rewrites stay cheap until asked for. */
const VISIBLE_LINES = 400

/** A band of unchanged lines opens this many at a time. */
const GAP_STEP = 20

/**
 * hunks: every hunk under its @@ header, signs and two number columns, for what the reader must judge in full (an
 * approval's proposal). full: the review in the right panel, with words marked, 「N 行未改动」 bands and a new or deleted
 * file drawn as the file itself. compact: the conversation's preview of at most 12 changed lines (8 of a new file),
 * without a head, with `fileActions` in its foot.
 */
export type DiffMode = 'hunks' | 'full' | 'compact'

/** What the source of a change knows beyond a `FileDiff`, for the review; a diff alone never claims a deletion. */
export type DiffViewFile = FileDiff & {
  deleted?: boolean
  renamedFrom?: string
  /** No text to compare: one line says so in place of the lines. */
  binary?: boolean
}

interface LineSlots {
  /** The slot over a line's number, for adding a comment. */
  gutter?: (line: DiffLine, diff: DiffViewFile) => ReactNode
  /** Under a line, for a comment on it. */
  annotation?: (line: DiffLine, diff: DiffViewFile) => ReactNode
  /** Marks on a line's row (`selected`: picked for a comment; `noted`: a kept comment covers it). */
  lineMark?: (line: DiffLine) => 'selected' | 'noted' | undefined
}

function tokensOf(tokens: SyntaxLines[number] | undefined, start: number, end: number): SyntaxLines[number] | undefined {
  if (!tokens) return undefined
  const out: SyntaxLines[number] = []
  let at = 0
  for (const token of tokens) {
    const from = Math.max(start, at)
    const to = Math.min(end, at + token.text.length)
    if (from < to) out.push({ ...token, text: token.text.slice(from - at, to - at) })
    at += token.text.length
  }
  return out
}

/**
 * A line's text with its changed words marked. Cutting a line could split a run of marks that VisibleText must see
 * whole to escape it, so a line with anything hidden in it is shown unmarked.
 */
function LineText({ text, tokens, ranges }: { text: string; tokens: SyntaxLines[number] | undefined; ranges?: TextRange[] }) {
  if (!ranges?.length || hasHiddenCharacters(text) || tokens?.map(token => token.text).join('') !== (tokens ? text : undefined))
    return <SyntaxLine text={text} tokens={tokens} />
  const parts: ReactNode[] = []
  let at = 0
  const piece = (start: number, end: number) => <SyntaxLine text={text.slice(start, end)} tokens={tokensOf(tokens, start, end)} />
  for (const [start, end] of ranges) {
    if (start > at) parts.push(<Fragment key={at}>{piece(at, start)}</Fragment>)
    parts.push(
      <span className="diff-word" key={start}>
        {piece(start, end)}
      </span>,
    )
    at = end
  }
  if (at < text.length) parts.push(<Fragment key={at}>{piece(at, text.length)}</Fragment>)
  return <>{parts}</>
}

interface RowTools extends LineSlots {
  /** Each line carries its own indent, for a hanging indent when the owner wraps lines. */
  indent?: boolean
  diff: DiffViewFile
  marks?: Map<DiffLine, TextRange[]>
  before: ReturnType<typeof useHighlightedTokens>
  after: ReturnType<typeof useHighlightedTokens>
}

const lineTokens = (line: DiffLine, { before, after }: Pick<RowTools, 'before' | 'after'>) =>
  line.kind === 'remove' ? before?.[(line.oldLine ?? 1) - 1] : after?.[(line.newLine ?? 1) - 1]

type SplitRows = ReturnType<typeof sideBySideLines>

/** A line's own indent, for the hanging indent when lines wrap. */
const indentOf = (text: string) => ({ '--diff-indent': `${/^[ \t]*/u.exec(text)![0].length}ch` }) as CSSProperties

function SplitSides({ rows, tools, titled }: { rows: SplitRows; tools: RowTools; titled: boolean }) {
  const { before, after, marks, gutter, diff } = tools
  return (
    <div className="diff-split">
      {(
        [
          { key: 'before', label: COPY.before, tokens: before },
          { key: 'after', label: COPY.after, tokens: after },
        ] as const
      ).map(side => (
        <div className="diff-split-side" key={side.key} role="region" aria-label={COPY.code(side.label)} tabIndex={0}>
          {titled ? <div className="diff-side-title">{side.label}</div> : <span className="sr-only">{side.label}</span>}
          {rows.map((row, index) => {
            const line = row[side.key]
            const number = side.key === 'before' ? line?.oldLine : line?.newLine
            return (
              <div
                className={`diff-side-row ${line ? `diff-${line.kind}` : 'diff-absent'}`}
                data-mark={line ? tools.lineMark?.(line) : undefined}
                key={index}
                style={tools.indent ? indentOf(line?.text ?? '') : undefined}>
                <span className="diff-ln" aria-hidden="true">
                  {number ?? ''}
                </span>
                {line && line === (row.after ?? row.before) && gutter && <span className="diff-gutter">{gutter(line, diff)}</span>}
                <span className="diff-sign" aria-hidden="true">
                  {line?.kind === 'add' ? '+' : line?.kind === 'remove' ? '−' : ' '}
                </span>
                <span className="diff-text">
                  {line?.text ? (
                    <LineText text={line.text} tokens={number ? side.tokens?.[number - 1] : undefined} ranges={marks?.get(line)} />
                  ) : (
                    ' '
                  )}
                </span>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** A note on a line runs under both sides: each stretch between notes is its own pair of columns, so their rows stay in line. */
function SplitHunk({ lines, tools, titled = true }: { lines: DiffLine[]; tools: RowTools; titled?: boolean }) {
  const rows = useMemo(() => sideBySideLines(lines), [lines])
  const { annotation, diff } = tools
  const stretches: Array<{ rows: SplitRows; notes: ReactNode[] }> = []
  let stretch: SplitRows = []
  for (const row of rows) {
    stretch.push(row)
    const noted = row.before === row.after ? [row.after] : [row.before, row.after]
    const notes = annotation ? noted.flatMap(line => (line ? annotation(line, diff) || [] : [])) : []
    if (notes.length > 0) {
      stretches.push({ rows: stretch, notes })
      stretch = []
    }
  }
  if (stretch.length > 0) stretches.push({ rows: stretch, notes: [] })
  return stretches.map((part, index) => (
    <Fragment key={index}>
      <SplitSides rows={part.rows} tools={tools} titled={titled && index === 0} />
      {part.notes.map((note, at) => (
        <div className="diff-annotation" key={at}>
          {note}
        </div>
      ))}
    </Fragment>
  ))
}

function UnifiedRows({ lines, tools }: { lines: DiffLine[]; tools: RowTools }) {
  const { marks, gutter, annotation, diff } = tools
  return lines.map((line, row) => (
    <Fragment key={row}>
      <div
        className={`diff-line diff-${line.kind}`}
        data-mark={tools.lineMark?.(line)}
        style={tools.indent ? indentOf(line.text) : undefined}>
        <span className="diff-ln diff-ln-old" aria-hidden="true">
          {line.oldLine ?? ''}
        </span>
        <span className="diff-ln diff-ln-new" aria-hidden="true">
          {line.newLine ?? ''}
        </span>
        <span className="diff-ln diff-ln-one" aria-hidden="true">
          {line.newLine ?? line.oldLine ?? ''}
        </span>
        {gutter && <span className="diff-gutter">{gutter(line, diff)}</span>}
        <span className="diff-sign" aria-hidden="true">
          {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
        </span>
        <span className="diff-text">
          {line.kind === 'add' && <span className="sr-only">{COPY.added}</span>}
          {line.kind === 'remove' && <span className="sr-only">{COPY.removed}</span>}
          {line.text ? <LineText text={line.text} tokens={lineTokens(line, tools)} ranges={marks?.get(line)} /> : ' '}
        </span>
      </div>
      {annotation?.(line, diff) && <div className="diff-annotation">{annotation(line, diff)}</div>}
    </Fragment>
  ))
}

/** A new file or a deleted one is the file itself: one side would be empty, so it is never split or flooded. */
function wholeFile(diff: DiffViewFile, previous: PreviousState): 'new' | 'deleted' | undefined {
  if (diff.deleted) return 'deleted'
  return previous === 'none' ? 'new' : undefined
}

function WholeTag({ whole, view, binary }: { whole: 'new' | 'deleted'; view: LineDiff; binary?: boolean }) {
  const name = whole === 'new' ? COPY.newFile : COPY.deleted
  return (
    <span className="diff-whole-tag" data-tone={whole}>
      {binary ? name : COPY.lineCount(name, whole === 'new' ? view.added : view.removed)}
    </span>
  )
}

/** A band of unchanged lines; each press opens 20 more next to the change. */
function GapBand({ gap, hunks, tools, layout }: { gap: DiffGap; hunks: number; tools: RowTools; layout: 'unified' | 'split' }) {
  const [opened, setOpened] = useState(0)
  const { lines, hidden } = openedGap(gap, hunks, opened)
  const rows = layout === 'split' ? <SplitHunk lines={lines} tools={tools} titled={false} /> : <UnifiedRows lines={lines} tools={tools} />
  const band =
    hidden > 0 ? (
      <button
        type="button"
        className="diff-gap"
        onClick={() => {
          setOpened(opened + GAP_STEP)
        }}>
        <Icon icon={UpDownGlyph} size={12} />
        {hidden}
        {COPY.unchanged}
      </button>
    ) : null
  return gap.before === hunks ? (
    <>
      {lines.length > 0 && rows}
      {band}
    </>
  ) : (
    <>
      {band}
      {lines.length > 0 && rows}
    </>
  )
}

/** The conversation's preview: no head, one line each, and a foot with what is left and what the caller offers. */
function CompactDiff({
  diff,
  index,
  fileActions,
}: {
  diff: DiffViewFile
  index: number
  fileActions?: (diff: DiffViewFile, index: number) => ReactNode
}) {
  const view = useMemo(() => diffLines(diff.oldText, diff.newText), [diff.oldText, diff.newText])
  const previous = previousState(diff)
  const whole = wholeFile(diff, previous)
  const { lines, remaining } = useMemo(() => compactLines(view, whole === 'new'), [view, whole])
  const language = languageForPath(diff.path)
  const before = useHighlightedTokens(diff.oldText ?? '', language, true)
  const after = useHighlightedTokens(diff.newText, language, true)
  const marks = useMemo(() => (whole ? undefined : wordHighlights(lines)), [lines, whole])
  const actions = fileActions?.(diff, index)
  const note = whole ? undefined : PREVIOUS_NOTES[previous]
  return (
    <div className="diff-compact" data-whole={whole}>
      {note && <p className="diff-note">{note}</p>}
      {diff.binary ? (
        <p className="diff-empty">{COPY.binary}</p>
      ) : lines.length === 0 ? (
        <p className="diff-empty">{COPY.noChange}</p>
      ) : (
        <UnifiedRows lines={lines} tools={{ diff, marks, before, after }} />
      )}
      {((remaining > 0 && !diff.binary) || actions) && (
        <div className="diff-compact-foot">
          <span>{remaining > 0 && !diff.binary ? (whole === 'new' ? COPY.moreLines(remaining) : COPY.moreChanged(remaining)) : ''}</span>
          {actions}
        </div>
      )}
    </div>
  )
}

/** One file in a multi-file compact preview: a collapsible file row whose opened body stays compact rather than flooding chat. */
function CompactDiffFile({
  diff,
  index,
  initiallyOpen,
  fileActions,
}: {
  diff: DiffViewFile
  index: number
  initiallyOpen: boolean
  fileActions?: (diff: DiffViewFile, index: number) => ReactNode
}) {
  const view = useMemo(() => diffLines(diff.oldText, diff.newText), [diff.oldText, diff.newText])
  const previous = previousState(diff)
  const whole = wholeFile(diff, previous)
  const [open, setOpen] = useState(initiallyOpen)
  const path = escapeHiddenCharacters(diff.path)
  const shown = middleEllipsis(diff.path, 64)
  const { folder, name } = splitPath(shown)
  const actions = fileActions?.(diff, index)
  return (
    <section className="diff-file" data-open={open ? '' : undefined} data-whole={whole}>
      <div className="diff-file-head">
        <button
          type="button"
          className="diff-file-header"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open)
          }}>
          <ChevronRightGlyph className="chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
          <span className="diff-path" title={path}>
            {folder && (
              <span className="diff-path-folder">
                <VisibleText text={folder} />
              </span>
            )}
            <span className="diff-path-name">
              <VisibleText text={name} />
            </span>
          </span>
          <PreviousBadge state={whole ? 'none' : previous} />
          {whole ? (
            <WholeTag whole={whole} view={view} binary={diff.binary} />
          ) : diff.binary ? null : (
            <span className="diff-stat">
              <span className={view.added ? 'diff-stat-add' : 'diff-stat-zero'}>+{view.added}</span>
              {previous === 'text' && <span className={view.removed ? 'diff-stat-remove' : 'diff-stat-zero'}>−{view.removed}</span>}
            </span>
          )}
        </button>
        {actions && <span className="diff-file-actions">{actions}</span>}
      </div>
      <Collapse
        open={open}
        lazy
        onReveal={() => {
          setOpen(true)
        }}>
        <div className="diff-paper">
          <CompactDiff diff={diff} index={index} fileActions={fileActions} />
        </div>
      </Collapse>
    </section>
  )
}

const PREVIOUS_COPY = defineCopy(
  {
    unavailable: '原内容未显示',
    unavailableDetail: '该文件已存在，但原内容过大、是二进制或无法读取，没有显示：写入会覆盖它。',
    unknown: '原内容未知',
    unknownDetail: 'Harness 没有说明原内容：这可能是新文件，也可能会覆盖过大、二进制或无法读取的现有文件。',
  },
  {
    unavailable: 'Original not shown',
    unavailableDetail: 'The file exists. Its original content is too large, binary or unreadable. Writing will overwrite it.',
    unknown: 'Original content unknown',
    unknownDetail:
      'The Harness did not report the original content. The write may create a new file or overwrite an existing file that is too large, binary or unreadable.',
  },
)

/** Warning lines for previous content the reviewer cannot see; a new file or included text needs none. */
export const PREVIOUS_NOTES: Partial<Record<PreviousState, string>> = {
  get unavailable() {
    return PREVIOUS_COPY.unavailableDetail
  },
  get unknown() {
    return PREVIOUS_COPY.unknownDetail
  },
}

function PreviousBadge({ state }: { state: PreviousState }) {
  if (state === 'unavailable')
    return (
      <StatusPill tone="warn" title={PREVIOUS_COPY.unavailableDetail}>
        {PREVIOUS_COPY.unavailable}
      </StatusPill>
    )
  if (state === 'unknown')
    return (
      <StatusPill tone="warn" title={PREVIOUS_COPY.unknownDetail}>
        {PREVIOUS_COPY.unknown}
      </StatusPill>
    )
  return null
}

/** A path's folder (with its trailing slash) and its file name, so the name leads and the folder stays quiet. */
function splitPath(path: string): { folder: string; name: string } {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at < 0 ? { folder: '', name: path } : { folder: path.slice(0, at + 1), name: path.slice(at + 1) }
}

/** The rows (hunk headers and lines) a diff of `diff` has. */
export function diffRows(diff: FileDiff): number {
  return diffLines(diff.oldText, diff.newText).hunks.reduce((sum, hunk) => sum + hunk.lines.length + 1, 0)
}

/**
 * One file's change: a tray whose 32px head names the file (its folder quieter), what the Host said about the previous
 * file, and the added and removed line counts; the diff itself is a sheet of paper inside the tray that opens and
 * closes under the head.
 */
function DiffFile({
  diff,
  index,
  initiallyOpen,
  fold,
  layout: wanted,
  mode,
  fileActions,
  gutter,
  annotation,
}: LineSlots & {
  diff: DiffViewFile
  index: number
  initiallyOpen: boolean
  fold: number | undefined
  layout: 'unified' | 'split'
  mode: 'hunks' | 'full'
  fileActions?: (diff: DiffViewFile, index: number) => ReactNode
}) {
  const view = useMemo(() => diffLines(diff.oldText, diff.newText), [diff.oldText, diff.newText])
  const previous = previousState(diff)
  const oldSide = knowsOldSide(previous)
  const note = PREVIOUS_NOTES[previous]
  const [open, setOpen] = useState(initiallyOpen)
  const language = languageForPath(diff.path)
  const full = mode === 'full'
  const whole = full ? wholeFile(diff, previous) : undefined
  const layout = whole ? 'unified' : wanted
  const oldTokens = useHighlightedTokens(diff.oldText ?? '', language, open)
  const newTokens = useHighlightedTokens(diff.newText, language, open)
  const marks = useMemo(
    () => (full && open && !whole ? wordHighlights(view.hunks.flatMap(hunk => hunk.lines)) : undefined),
    [full, open, whole, view],
  )
  const [unfolded, setUnfolded] = useState(false)
  const [all, setAll] = useState(false)
  const lineCount = view.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  // A hunk's header takes a row of the budget, except in full mode, which draws none.
  const total = full ? lineCount : lineCount + view.hunks.length
  const folded = fold !== undefined && !unfolded && total > fold
  const path = escapeHiddenCharacters(diff.path)
  const shown = middleEllipsis(diff.path, 64)
  const { folder, name } = splitPath(shown)
  const tools: RowTools = { diff, marks, before: oldTokens, after: newTokens, gutter, annotation, indent: full }
  const gapBefore = (index: number) => (full ? view.gaps.find(gap => gap.before === index) : undefined)
  const trailing = gapBefore(view.hunks.length)
  const actions = fileActions?.(diff, index)
  let budget = folded ? fold : all ? Infinity : VISIBLE_LINES
  let shownLines = 0
  const header = (
    <button
      type="button"
      className="diff-file-header"
      aria-expanded={open}
      onClick={() => {
        setOpen(!open)
      }}>
      <ChevronRightGlyph className="chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
      <span className="diff-path" title={path}>
        {full && folder && (
          <span className="diff-path-folder">
            <VisibleText text={folder} />
          </span>
        )}
        <span className="diff-path-name">
          <VisibleText text={name} />
        </span>
      </span>
      {full && diff.renamedFrom && (
        <span className="diff-renamed">
          {COPY.renamedFrom}
          <VisibleText text={diff.renamedFrom} />
        </span>
      )}
      <PreviousBadge state={full && whole ? 'none' : previous} />
      {whole ? (
        <WholeTag whole={whole} view={view} binary={diff.binary} />
      ) : diff.binary ? null : (
        <span className="diff-stat">
          <span className={view.added ? 'diff-stat-add' : 'diff-stat-zero'}>+{view.added}</span>
          {previous === 'text' && <span className={view.removed ? 'diff-stat-remove' : 'diff-stat-zero'}>−{view.removed}</span>}
        </span>
      )}
    </button>
  )
  return (
    <section className="diff-file" data-open={open ? '' : undefined} data-layout={layout} data-whole={whole}>
      {actions || full ? (
        <div className="diff-file-head">
          {header}
          {actions && <span className="diff-file-actions">{actions}</span>}
        </div>
      ) : (
        header
      )}
      <Collapse
        open={open}
        lazy
        onReveal={() => {
          setOpen(true)
        }}>
        <div className="diff-paper">
          <div className="diff-body" role="region" tabIndex={0} aria-label={COPY.changes(path)}>
            {note && !whole && <p className="diff-note">{note}</p>}
            {diff.binary ? (
              <p className="diff-empty">{COPY.binary}</p>
            ) : view.hunks.length === 0 ? (
              <p className="diff-empty">{COPY.noChange}</p>
            ) : (
              <div className="diff-table">
                {view.hunks.map((hunk, index) => {
                  if (budget <= 0) return null
                  if (!full) budget--
                  const lines = hunk.lines.slice(0, Math.max(0, budget))
                  budget -= lines.length
                  shownLines += lines.length
                  const gap = gapBefore(index)
                  return (
                    <div className="diff-hunk" key={index}>
                      {gap && <GapBand gap={gap} hunks={view.hunks.length} tools={tools} layout={layout} />}
                      {!full && (
                        <div className="diff-hunk-header">
                          {oldSide
                            ? `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
                            : `@@ +${hunk.newStart},${hunk.newLines} @@`}
                        </div>
                      )}
                      {layout === 'split' ? (
                        <SplitHunk lines={lines} tools={tools} titled={!full || index === 0} />
                      ) : (
                        <UnifiedRows lines={lines} tools={tools} />
                      )}
                    </div>
                  )
                })}
                {trailing && budget > 0 && <GapBand gap={trailing} hunks={view.hunks.length} tools={tools} layout={layout} />}
              </div>
            )}
          </div>
          {folded && (
            <button
              type="button"
              className="diff-fold"
              onClick={() => {
                setUnfolded(true)
              }}>
              {COPY.expand(lineCount - shownLines)}
            </button>
          )}
          {!folded && !all && total > VISIBLE_LINES && (
            <button
              type="button"
              className="diff-more"
              onClick={() => {
                setAll(true)
              }}>
              {COPY.expand(lineCount - shownLines)}
            </button>
          )}
        </div>
      </Collapse>
    </section>
  )
}

/**
 * The lines of a review whose owner draws its own head and already holds the lines: a new or deleted file is the file
 * itself, unchanged stretches fold into bands, and each line can carry a comment slot.
 */
export function DiffLines({
  diff,
  view,
  layout: wanted = 'unified',
  gutter,
  annotation,
  lineMark,
}: LineSlots & { diff: DiffViewFile; view: LineDiff; layout?: 'unified' | 'split' }) {
  const whole = wholeFile(diff, previousState(diff))
  const layout = whole ? 'unified' : wanted
  const language = languageForPath(diff.path)
  const before = useHighlightedTokens(diff.oldText ?? '', language, true)
  const after = useHighlightedTokens(diff.newText, language, true)
  const marks = useMemo(() => (whole ? undefined : wordHighlights(view.hunks.flatMap(hunk => hunk.lines))), [whole, view])
  const [all, setAll] = useState(false)
  const tools: RowTools = { diff, marks, before, after, gutter, annotation, lineMark, indent: true }
  const lineCount = view.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  let budget = all ? Infinity : VISIBLE_LINES
  const trailing = view.gaps.find(gap => gap.before === view.hunks.length)
  return (
    <div className="diff-lines" data-layout={layout} data-whole={whole}>
      <div className="diff-table">
        {view.hunks.map((hunk, index) => {
          if (budget <= 0) return null
          const lines = hunk.lines.slice(0, budget)
          budget -= lines.length
          const gap = view.gaps.find(item => item.before === index)
          return (
            <div className="diff-hunk" key={index}>
              {gap && <GapBand gap={gap} hunks={view.hunks.length} tools={tools} layout={layout} />}
              {layout === 'split' ? <SplitHunk lines={lines} tools={tools} titled={false} /> : <UnifiedRows lines={lines} tools={tools} />}
            </div>
          )
        })}
        {trailing && budget > 0 && <GapBand gap={trailing} hunks={view.hunks.length} tools={tools} layout={layout} />}
      </div>
      {!all && lineCount > VISIBLE_LINES && (
        <button
          type="button"
          className="diff-more"
          onClick={() => {
            setAll(true)
          }}>
          {COPY.expand(lineCount - VISIBLE_LINES)}
        </button>
      )}
    </div>
  )
}

/**
 * The one diff renderer: line-based, of the files a tool changes or proposes to change. `fold`: the rows a file shows
 * before a fold bar 「展开其余 N 行」 (an approval's preview keeps its paper short); without it a file shows up to 400.
 * `layout`: the caller picks, by the width it has; a new or deleted file in `full` mode is never split.
 * `fileActions`: controls for a file, at the end of its head, or in the foot in `compact` mode.
 */
export function DiffView({
  diffs,
  fold,
  layout = 'unified',
  initiallyOpen,
  mode = 'hunks',
  fileActions,
  gutter,
  annotation,
}: LineSlots & {
  diffs: DiffViewFile[]
  fold?: number
  layout?: 'unified' | 'split'
  initiallyOpen?: boolean
  mode?: DiffMode
  fileActions?: (diff: DiffViewFile, index: number) => ReactNode
}) {
  if (diffs.length === 0) return null
  return (
    <div className="diff-view" data-mode={mode}>
      {diffs.map((diff, index) =>
        mode === 'compact' ? (
          diffs.length > 1 ? (
            <CompactDiffFile
              key={`${diff.path}:${index}`}
              diff={diff}
              index={index}
              initiallyOpen={initiallyOpen ?? false}
              fileActions={fileActions}
            />
          ) : (
            <CompactDiff key={`${diff.path}:${index}`} diff={diff} index={index} fileActions={fileActions} />
          )
        ) : (
          <DiffFile
            key={`${diff.path}:${index}`}
            diff={diff}
            index={index}
            initiallyOpen={initiallyOpen ?? diffs.length === 1}
            fold={fold}
            layout={layout}
            mode={mode}
            fileActions={fileActions}
            gutter={gutter}
            annotation={annotation}
          />
        ),
      )}
    </div>
  )
}
