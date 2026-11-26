import { useContext, useEffect, useRef, useState } from 'react'
import { CornerUpLeft, FileCode2, WrapText } from 'lucide-react'
import { Button, Icon, IconButton, InlineNotice, motionAllowed } from '@latch/ui'
import { DiffView } from '../components/DiffView.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { useWindowWidth } from '../breakpoints.ts'
import { setPreference, usePreferences } from '../preferences.ts'
import { FileOpenContext } from './fileContext.ts'
import type { FileHistory } from './fileHistory.ts'
import type { FileDiffFocus } from './useFileTabs.ts'
import { defineCopy, plural } from '../core/i18n.ts'
import { absoluteTime, clockTime } from '../format.ts'

const HISTORY_COPY = defineCopy(
  {
    label: '文件历史改动',
    view: '代码审阅视图',
    preview: '预览',
    run: '本轮',
    history: '历史',
    layout: '差异布局',
    unified: '行内',
    split: '左右对照',
    wrap: '自动换行',
    locateInChat: '在对话中定位',
    toolEdits: (n: number) => `${n} 次工具修改`,
    files: '改动的文件',
    noneThisRun: '这个文件在本轮没有修改。可以切换历史查看之前的改动。',
    edit: (n: number) => `第 ${n} 次修改`,
    latest: '最新修改',
    earlier: (n: number) => `查看更早的修改（还有 ${n} 次）`,
    none: '这个文件还没有已记录的工具修改。',
  },
  {
    label: 'File history',
    view: 'Code review view',
    preview: 'Preview',
    run: 'This run',
    history: 'History',
    layout: 'Diff layout',
    unified: 'Inline',
    split: 'Side by side',
    wrap: 'Wrap lines',
    locateInChat: 'Locate in conversation',
    toolEdits: (n: number) => plural(n, { one: '1 tool edit', other: '{n} tool edits' }),
    files: 'Changed files',
    noneThisRun: 'No edits to this file in this run. Switch to History to see earlier changes.',
    edit: (n: number) => `Edit ${n}`,
    latest: 'Latest edit',
    earlier: (n: number) => plural(n, { one: 'Show 1 earlier edit', other: 'Show {n} earlier edits' }),
    none: 'No recorded tool edits for this file yet.',
  },
)
export function FileHistoryPreview({
  history,
  histories = [],
  name,
  expanded = false,
  focus,
  onPreview,
  onExpand,
  onRevealTool,
}: {
  history?: FileHistory
  histories?: FileHistory[]
  name: string
  expanded?: boolean
  focus?: FileDiffFocus
  onPreview?: (() => void) | undefined
  onExpand(): void
  onRevealTool?: ((messageId: string) => void) | undefined
}) {
  const preferences = usePreferences()
  const width = useWindowWidth()
  const openFile = useContext(FileOpenContext)
  const [limit, setLimit] = useState(5)
  const [scopeOverride, setScopeOverride] = useState<'history' | undefined>()
  const entriesRef = useRef<HTMLDivElement>(null)
  // Opening an older edit directly from the conversation keeps it visible even if the device prefers 本轮.
  useEffect(() => {
    if (!focus || !history) {
      setScopeOverride(undefined)
      return
    }
    const target = history.entries.find(entry => entry.id === focus.entryId)
    if (target && preferences.diffScope === 'run' && (history.currentTurnId === undefined || target.turnId !== history.currentTurnId))
      setScopeOverride('history')
    else setScopeOverride(undefined)
  }, [focus?.nonce, focus?.entryId, history?.path, history?.root])
  const scope = scopeOverride ?? preferences.diffScope
  const layout = width >= 1024 && expanded ? preferences.diffLayout : 'unified'
  const inScope = (entry: FileHistory['entries'][number], file: FileHistory) =>
    scope === 'history' || (file.currentTurnId !== undefined && entry.turnId === file.currentTurnId)
  const entries = history?.entries.filter(entry => inScope(entry, history)).toReversed() ?? []
  const files = histories.filter(file => file.entries.some(entry => inScope(entry, file)))
  const focusIndex = focus ? entries.findIndex(entry => entry.id === focus.entryId) : -1
  const focusedId = focusIndex >= 0 ? focus!.entryId : undefined
  const visibleLimit = focusIndex >= limit ? focusIndex + 1 : limit
  useEffect(() => {
    if (!focusedId || !entriesRef.current) return
    const target = entriesRef.current.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(focusedId)}"]`)
    target?.scrollIntoView({ block: 'start', behavior: motionAllowed() ? 'smooth' : 'auto' })
  }, [focus?.nonce, focusedId])
  const location = history ? (history.folder ? `${history.folder}/${history.path}` : history.path) : ''
  const cut = Math.max(location.lastIndexOf('/'), location.lastIndexOf('\\'))
  const locationFolder = cut >= 0 ? location.slice(0, cut + 1) : ''
  const locationName = cut >= 0 ? location.slice(cut + 1) : location || name
  return (
    <section
      className="file-preview file-history code-review"
      data-wrap={preferences.diffWrap ? '' : undefined}
      aria-label={HISTORY_COPY.label}>
      <header className="file-preview-head">
        <span className="code-review-path" title={location || name}>
          {locationFolder && (
            <span className="code-review-folder">
              <VisibleText text={locationFolder} />
            </span>
          )}
          <strong className="code-review-name">
            <VisibleText text={locationName} />
          </strong>
        </span>
        <span className="file-preview-actions">
          {history && <span className="file-preview-updated">{HISTORY_COPY.toolEdits(entries.length)}</span>}
          {onPreview && (
            <Button size="xs" variant="ghost" onClick={onPreview}>
              {HISTORY_COPY.preview}
            </Button>
          )}
        </span>
      </header>
      <div className="file-preview-controls code-review-controls" role="group" aria-label={HISTORY_COPY.view}>
        <Button
          size="xs"
          variant="ghost"
          aria-pressed={scope === 'run'}
          onClick={() => {
            setScopeOverride(undefined)
            setPreference('diffScope', 'run')
            setLimit(5)
          }}>
          {HISTORY_COPY.run}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          aria-pressed={scope === 'history'}
          onClick={() => {
            setScopeOverride(undefined)
            setPreference('diffScope', 'history')
            setLimit(5)
          }}>
          {HISTORY_COPY.history}
        </Button>
        <div className="code-review-layout" role="group" aria-label={HISTORY_COPY.layout}>
          <IconButton
            size="xs"
            icon={WrapText}
            label={HISTORY_COPY.wrap}
            pressed={preferences.diffWrap}
            onClick={() => {
              setPreference('diffWrap', !preferences.diffWrap)
            }}
          />
          {width >= 1024 && (
            <>
              <Button size="xs" variant="ghost" aria-pressed={layout === 'unified'} onClick={() => setPreference('diffLayout', 'unified')}>
                {HISTORY_COPY.unified}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                aria-pressed={layout === 'split'}
                onClick={() => {
                  setPreference('diffLayout', 'split')
                  if (!expanded) onExpand()
                }}>
                {HISTORY_COPY.split}
              </Button>
            </>
          )}
        </div>
      </div>
      {history ? (
        <div className="code-review-content" data-multiple={files.length > 1 ? '' : undefined}>
          {files.length > 1 && (
            <nav className="code-review-files" aria-label={HISTORY_COPY.files}>
              {files.map(file => (
                <Button
                  key={`${file.root}:${file.path}`}
                  variant="ghost"
                  size="sm"
                  aria-current={file.root === history.root && file.path === history.path ? 'true' : undefined}
                  title={`${file.folder} / ${file.path}`}
                  onClick={() => {
                    setLimit(5)
                    openFile?.(file.target)
                  }}>
                  <Icon icon={FileCode2} size={14} />
                  <span>
                    <strong>
                      <VisibleText text={file.path.split('/').at(-1) ?? file.path} />
                    </strong>
                    <small>
                      <VisibleText text={`${file.folder} / ${file.path}`} />
                    </small>
                  </span>
                </Button>
              ))}
            </nav>
          )}
          <div ref={entriesRef} className="file-preview-body code-review-entries">
            {entries.length === 0 && <InlineNotice>{HISTORY_COPY.noneThisRun}</InlineNotice>}
            {entries.slice(0, visibleLimit).map((entry, index) => {
              const number = history.entries.indexOf(entry) + 1
              const isFocused = focusedId === entry.id
              const initiallyOpen = focusedId !== undefined ? isFocused : index === 0
              return (
                <section
                  className="file-history-entry"
                  key={entry.id}
                  data-entry-id={entry.id}
                  data-focused={isFocused && entries.length > 1 ? '' : undefined}
                  aria-label={HISTORY_COPY.edit(number)}>
                  <div className="file-history-entry-heading">
                    <h3>
                      {index === 0 ? HISTORY_COPY.latest : HISTORY_COPY.edit(number)} · <VisibleText text={entry.tool} />
                    </h3>
                    <span className="file-history-entry-meta">
                      {entry.at && Number.isFinite(Date.parse(entry.at)) && (
                        <time className="file-preview-caption" dateTime={entry.at} title={absoluteTime(Date.parse(entry.at))}>
                          {clockTime(Date.parse(entry.at))}
                        </time>
                      )}
                      {onRevealTool && (
                        <IconButton
                          size="xs"
                          icon={CornerUpLeft}
                          label={HISTORY_COPY.locateInChat}
                          onClick={() => {
                            onRevealTool(entry.toolId)
                          }}
                        />
                      )}
                    </span>
                  </div>
                  <DiffView
                    key={`${entry.id}:${focus?.nonce ?? 0}`}
                    diffs={[entry.diff]}
                    mode="full"
                    layout={layout}
                    initiallyOpen={initiallyOpen}
                  />
                </section>
              )
            })}
            {entries.length > visibleLimit && (
              <Button size="sm" variant="ghost" className="file-history-earlier" onClick={() => setLimit(value => value + 5)}>
                {HISTORY_COPY.earlier(entries.length - visibleLimit)}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <InlineNotice>{HISTORY_COPY.none}</InlineNotice>
      )}
    </section>
  )
}
