import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronRight, ChevronsUpDown } from 'lucide-react'
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
import { Collapse, Icon, ICON_STROKE, StatusPill } from '@latch/ui'
import { escapeHiddenCharacters, hasHiddenCharacters, VisibleText } from './VisibleText.tsx'
import { useHighlightedTokens, SyntaxLine } from '../preview/HighlightedCode.tsx'
import { languageForPath, type SyntaxLines } from '../preview/highlight-protocol.ts'

/** Lines rendered before "显示全部"; long rewrites stay cheap until asked for. */
const VISIBLE_LINES = 400

const BINARY_TEXT = '二进制文件，没有可比较的文字'

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
          { key: 'before', label: '修改前', tokens: before },
          { key: 'after', label: '修改后', tokens: after },
        ] as const
      ).map(side => (
        <div className="diff-split-side" key={side.key} role="region" aria-label={`${side.label}代码`} tabIndex={0}>
          {titled ? <div className="diff-side-title">{side.label}</div> : <span className="sr-only">{side.label}</span>}
          {rows.map((row, index) => {
            const line = row[side.key]
            const number = side.key === 'before' ? line?.oldLine : line?.newLine
            return (
              <div
                className={`diff-side-row ${line ? `diff-${line.kind}` : 'diff-absent'}`}
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
      <div className={`diff-line diff-${line.kind}`} style={tools.indent ? indentOf(line.text) : undefined}>
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
          {line.kind === 'add' && <span className="sr-only">新增：</span>}
          {line.kind === 'remove' && <span className="sr-only">删除：</span>}
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
  const name = whole === 'new' ? '新文件' : '已删除'
  return (
    <span className="diff-whole-tag" data-tone={whole}>
      {binary ? name : `${name} · ${whole === 'new' ? view.added : view.removed} 行`}
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
        <Icon icon={ChevronsUpDown} size={12} />
        {hidden} 行未改动
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
function CompactDiff({ diff, fileActions }: { diff: DiffViewFile; fileActions?: (diff: DiffViewFile) => ReactNode }) {
  const view = useMemo(() => diffLines(diff.oldText, diff.newText), [diff.oldText, diff.newText])
  const previous = previousState(diff)
  const whole = wholeFile(diff, previous)
  const { lines, remaining } = useMemo(() => compactLines(view, whole === 'new'), [view, whole])
  const language = languageForPath(diff.path)
  const before = useHighlightedTokens(diff.oldText ?? '', language, true)
  const after = useHighlightedTokens(diff.newText, language, true)
  const marks = useMemo(() => (whole ? undefined : wordHighlights(lines)), [lines, whole])
  const actions = fileActions?.(diff)
  const note = whole ? undefined : PREVIOUS_NOTES[previous]
  return (
    <div className="diff-compact" data-whole={whole}>
      {note && <p className="diff-note">{note}</p>}
      {diff.binary ? (
        <p className="diff-empty">{BINARY_TEXT}</p>
      ) : lines.length === 0 ? (
        <p className="diff-empty">内容没有变化</p>
      ) : (
        <UnifiedRows lines={lines} tools={{ diff, marks, before, after }} />
      )}
      {((remaining > 0 && !diff.binary) || actions) && (
        <div className="diff-compact-foot">
          <span>{remaining > 0 && !diff.binary ? (whole === 'new' ? `还有 ${remaining} 行` : `还有 ${remaining} 行改动`) : ''}</span>
          {actions}
        </div>
      )}
    </div>
  )
}

export const PREVIOUS_UNAVAILABLE_LABEL = '原内容未显示'
export const PREVIOUS_UNAVAILABLE_TEXT = '该文件已存在，但原内容过大、是二进制或无法读取，没有显示：写入会覆盖它。'
export const PREVIOUS_UNKNOWN_LABEL = '原内容未知'
export const PREVIOUS_UNKNOWN_TEXT = '执行端没有说明原内容：这可能是新文件，也可能会覆盖过大、二进制或无法读取的现有文件。'

/** Warning lines for previous content the reviewer cannot see; a new file or included text needs none. */
export const PREVIOUS_NOTES: Partial<Record<PreviousState, string>> = {
  unavailable: PREVIOUS_UNAVAILABLE_TEXT,
  unknown: PREVIOUS_UNKNOWN_TEXT,
}

function PreviousBadge({ state }: { state: PreviousState }) {
  if (state === 'unavailable')
    return (
      <StatusPill tone="warn" title={PREVIOUS_UNAVAILABLE_TEXT}>
        {PREVIOUS_UNAVAILABLE_LABEL}
      </StatusPill>
    )
  if (state === 'unknown')
    return (
      <StatusPill tone="warn" title={PREVIOUS_UNKNOWN_TEXT}>
        {PREVIOUS_UNKNOWN_LABEL}
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
  initiallyOpen,
  fold,
  layout: wanted,
  mode,
  fileActions,
  gutter,
  annotation,
}: LineSlots & {
  diff: DiffViewFile
  initiallyOpen: boolean
  fold: number | undefined
  layout: 'unified' | 'split'
  mode: 'hunks' | 'full'
  fileActions?: (diff: DiffViewFile) => ReactNode
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
  const tools: RowTools = { diff, marks, before: oldTokens, after: newTokens, gutter, annotation }
  const gapBefore = (index: number) => (full ? view.gaps.find(gap => gap.before === index) : undefined)
  const trailing = gapBefore(view.hunks.length)
  const actions = fileActions?.(diff)
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
      <ChevronRight className="chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
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
          重命名自 <VisibleText text={diff.renamedFrom} />
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
          <div className="diff-body" role="region" tabIndex={0} aria-label={`${path} 的变更`}>
            {note && !whole && <p className="diff-note">{note}</p>}
            {diff.binary ? (
              <p className="diff-empty">{BINARY_TEXT}</p>
            ) : view.hunks.length === 0 ? (
              <p className="diff-empty">内容没有变化</p>
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
              展开其余 {lineCount - shownLines} 行
            </button>
          )}
          {!folded && !all && total > VISIBLE_LINES && (
            <button
              type="button"
              className="diff-more"
              onClick={() => {
                setAll(true)
              }}>
              展开其余 {lineCount - shownLines} 行
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
}: LineSlots & { diff: DiffViewFile; view: LineDiff; layout?: 'unified' | 'split' }) {
  const whole = wholeFile(diff, previousState(diff))
  const layout = whole ? 'unified' : wanted
  const language = languageForPath(diff.path)
  const before = useHighlightedTokens(diff.oldText ?? '', language, true)
  const after = useHighlightedTokens(diff.newText, language, true)
  const marks = useMemo(() => (whole ? undefined : wordHighlights(view.hunks.flatMap(hunk => hunk.lines))), [whole, view])
  const [all, setAll] = useState(false)
  const tools: RowTools = { diff, marks, before, after, gutter, annotation, indent: true }
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
          展开其余 {lineCount - VISIBLE_LINES} 行
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
  fileActions?: (diff: DiffViewFile) => ReactNode
}) {
  if (diffs.length === 0) return null
  return (
    <div className="diff-view" data-mode={mode}>
      {diffs.map((diff, index) =>
        mode === 'compact' ? (
          <CompactDiff key={`${diff.path}:${index}`} diff={diff} fileActions={fileActions} />
        ) : (
          <DiffFile
            key={`${diff.path}:${index}`}
            diff={diff}
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
