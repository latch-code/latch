import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, FileText } from 'lucide-react'
import type { FileDiff } from '@latch/protocol'
import { CONTENT_HASH_LABEL, contentHash, hashable, knownContentHash } from '../core/contentHash.ts'
import { diffLines, knowsOldSide, previousState, type PreviousState } from '../diff.ts'
import { middleEllipsis } from '../format.ts'
import { Collapse, ICON_STROKE, StatusPill } from '@latch/ui'
import { escapeHiddenCharacters, VisibleText } from './VisibleText.tsx'

/** Lines rendered before "显示全部"; long rewrites stay cheap until asked for. */
const VISIBLE_LINES = 400

export const NEW_FILE_LABEL = '新文件'
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
  if (state === 'none') return <StatusPill>{NEW_FILE_LABEL}</StatusPill>
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

export const CONTENT_HASH_PENDING = '计算中…'
export const CONTENT_HASH_TITLE = '新内容 SHA-256 的前 16 位，可与本机确认窗口中的「新内容哈希」逐字核对'

/**
 * The hash of `text` once WebCrypto has computed it, undefined while it runs, null when there is none to show. The
 * digest runs after rendering, so a long text never delays the diff.
 */
function useContentHash(text: string): string | null | undefined {
  const shown = hashable(text)
  const [computed, setComputed] = useState<{ text: string; hash: string | null } | null>(null)
  // Always keep this line's own result: the shared cache may evict a hash this line showed earlier.
  useEffect(() => {
    if (!shown) return
    let active = true
    void contentHash(text).then(hash => {
      if (active) setComputed({ text, hash: hash ?? null })
    })
    return () => {
      active = false
    }
  }, [text, shown])
  if (!shown) return null
  return knownContentHash(text) ?? (computed?.text === text ? computed.hash : undefined)
}

/** One line above the diff body; it keeps its height while the hash is computed. */
function ContentHashLine({ text }: { text: string }) {
  const hash = useContentHash(text)
  if (hash === null) return null
  return (
    <p className="diff-hash" title={CONTENT_HASH_TITLE}>
      <span>{CONTENT_HASH_LABEL}</span>
      {hash === undefined ? <span className="diff-hash-pending">{CONTENT_HASH_PENDING}</span> : <code>{hash}</code>}
    </p>
  )
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
function DiffFile({ diff, initiallyOpen, fold }: { diff: FileDiff; initiallyOpen: boolean; fold: number | undefined }) {
  const view = useMemo(() => diffLines(diff.oldText, diff.newText), [diff.oldText, diff.newText])
  const previous = previousState(diff)
  const oldSide = knowsOldSide(previous)
  const note = PREVIOUS_NOTES[previous]
  const [open, setOpen] = useState(initiallyOpen)
  const [unfolded, setUnfolded] = useState(false)
  const [all, setAll] = useState(false)
  const total = view.hunks.reduce((sum, hunk) => sum + hunk.lines.length + 1, 0)
  const folded = fold !== undefined && !unfolded && total > fold
  const path = escapeHiddenCharacters(diff.path)
  const shown = middleEllipsis(diff.path, 64)
  const { folder, name } = splitPath(shown)
  let budget = folded ? fold : all ? Infinity : VISIBLE_LINES
  let shownLines = 0
  return (
    <section className="diff-file" data-open={open ? '' : undefined}>
      <button
        type="button"
        className="diff-file-header"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
        }}>
        <FileText size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        <span className="diff-path" title={path}>
          <span className="diff-path-name">
            <VisibleText text={name} />
          </span>
          {folder && (
            <span className="diff-path-folder">
              <VisibleText text={folder} />
            </span>
          )}
        </span>
        <PreviousBadge state={previous} />
        <span className="diff-stat">
          <span className={view.added ? 'diff-stat-add' : 'diff-stat-zero'}>+{view.added}</span>
          {previous === 'text' && <span className={view.removed ? 'diff-stat-remove' : 'diff-stat-zero'}>−{view.removed}</span>}
        </span>
        <ChevronRight className="chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
      </button>
      <Collapse
        open={open}
        lazy
        onReveal={() => {
          setOpen(true)
        }}>
        <div className="diff-paper">
          <ContentHashLine text={diff.newText} />
          <div className="diff-body" role="region" tabIndex={0} aria-label={`${path} 的变更`}>
            {note && <p className="diff-note">{note}</p>}
            {view.hunks.length === 0 ? (
              <p className="diff-empty">内容没有变化</p>
            ) : (
              <div className="diff-table">
                {view.hunks.map((hunk, index) => {
                  if (budget <= 0) return null
                  budget--
                  const lines = hunk.lines.slice(0, Math.max(0, budget))
                  budget -= lines.length
                  shownLines += lines.length
                  return (
                    <div className="diff-hunk" key={index}>
                      <div className="diff-hunk-header">
                        {oldSide
                          ? `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
                          : `@@ +${hunk.newStart},${hunk.newLines} @@`}
                      </div>
                      {lines.map((line, row) => (
                        <div key={row} className={`diff-line diff-${line.kind}`}>
                          <span className="diff-ln diff-ln-old" aria-hidden="true">
                            {line.oldLine ?? ''}
                          </span>
                          <span className="diff-ln diff-ln-new" aria-hidden="true">
                            {line.newLine ?? ''}
                          </span>
                          <span className="diff-ln diff-ln-one" aria-hidden="true">
                            {line.newLine ?? line.oldLine ?? ''}
                          </span>
                          <span className="diff-sign" aria-hidden="true">
                            {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
                          </span>
                          <span className="diff-text">
                            {line.kind === 'add' && <span className="sr-only">新增：</span>}
                            {line.kind === 'remove' && <span className="sr-only">删除：</span>}
                            {line.text ? <VisibleText text={line.text} /> : ' '}
                          </span>
                        </div>
                      ))}
                    </div>
                  )
                })}
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
              展开其余 {view.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) - shownLines} 行
            </button>
          )}
          {!folded && !all && total > VISIBLE_LINES && (
            <button
              type="button"
              className="diff-more"
              onClick={() => {
                setAll(true)
              }}>
              展开其余 {total - VISIBLE_LINES} 行
            </button>
          )}
        </div>
      </Collapse>
    </section>
  )
}

/**
 * Unified, line-based diff of the files a tool changes or proposes to change. `fold`: the rows a file shows before a
 * fold bar 「展开其余 N 行」 (an approval's preview keeps its paper short); without it a file shows up to 400.
 */
export function DiffView({ diffs, fold }: { diffs: FileDiff[]; fold?: number }) {
  if (diffs.length === 0) return null
  return (
    <div className="diff-view">
      {diffs.map((diff, index) => (
        <DiffFile key={`${diff.path}:${index}`} diff={diff} initiallyOpen={diffs.length === 1} fold={fold} />
      ))}
    </div>
  )
}
