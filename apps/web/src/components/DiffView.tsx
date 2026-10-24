import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, FileDiff as FileDiffIcon } from 'lucide-react'
import type { FileDiff } from '@latch/protocol'
import { CONTENT_HASH_LABEL, contentHash, hashable, knownContentHash } from '../core/contentHash.ts'
import { diffLines, knowsOldSide, previousState, type PreviousState } from '../diff.ts'
import { middleEllipsis } from '../format.ts'
import { ICON_STROKE } from '../icons.tsx'
import { Badge } from './ui.tsx'
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
  if (state === 'none') return <Badge>{NEW_FILE_LABEL}</Badge>
  if (state === 'unavailable')
    return (
      <Badge tone="warn" title={PREVIOUS_UNAVAILABLE_TEXT}>
        {PREVIOUS_UNAVAILABLE_LABEL}
      </Badge>
    )
  if (state === 'unknown')
    return (
      <Badge tone="warn" title={PREVIOUS_UNKNOWN_TEXT}>
        {PREVIOUS_UNKNOWN_LABEL}
      </Badge>
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

function DiffFile({ diff, initiallyOpen }: { diff: FileDiff; initiallyOpen: boolean }) {
  const view = useMemo(() => diffLines(diff.oldText, diff.newText), [diff.oldText, diff.newText])
  const previous = previousState(diff)
  const oldSide = knowsOldSide(previous)
  const note = PREVIOUS_NOTES[previous]
  const [open, setOpen] = useState(initiallyOpen)
  const [all, setAll] = useState(false)
  const total = view.hunks.reduce((sum, hunk) => sum + hunk.lines.length + 1, 0)
  const path = escapeHiddenCharacters(diff.path)
  let budget = all ? Infinity : VISIBLE_LINES
  return (
    <section className="diff-file">
      <button
        type="button"
        className="diff-file-header"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
        }}>
        <FileDiffIcon size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <span className="diff-path" title={path}>
          <VisibleText text={middleEllipsis(diff.path, 64)} />
        </span>
        <PreviousBadge state={previous} />
        <span className="diff-stat">
          <span className="diff-stat-add">+{view.added}</span>
          {previous === 'text' && <span className="diff-stat-remove">−{view.removed}</span>}
        </span>
        <ChevronRight className="chevron" size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </button>
      {open && <ContentHashLine text={diff.newText} />}
      {open && (
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
                        <span className="diff-ln" aria-hidden="true">
                          {line.newLine ?? ''}
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
          {!all && total > VISIBLE_LINES && (
            <button
              type="button"
              className="text-button diff-more"
              onClick={() => {
                setAll(true)
              }}>
              显示全部 {total} 行
            </button>
          )}
        </div>
      )}
    </section>
  )
}

/** Unified, line-based diff of the files a tool changes or proposes to change. */
export function DiffView({ diffs }: { diffs: FileDiff[] }) {
  if (diffs.length === 0) return null
  return (
    <div className="diff-view">
      {diffs.map((diff, index) => (
        <DiffFile key={`${diff.path}:${index}`} diff={diff} initiallyOpen={diffs.length === 1} />
      ))}
    </div>
  )
}
