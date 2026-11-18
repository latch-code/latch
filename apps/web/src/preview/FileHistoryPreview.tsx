import { useContext, useState } from 'react'
import { FileCode2 } from 'lucide-react'
import { Button, Icon, InlineNotice } from '@latch/ui'
import { DiffView } from '../components/DiffView.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { useWindowWidth } from '../breakpoints.ts'
import { setPreference, usePreferences } from '../preferences.ts'
import { FileOpenContext } from './fileContext.ts'
import type { FileHistory } from './fileHistory.ts'
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
  onPreview,
  onExpand,
}: {
  history?: FileHistory
  histories?: FileHistory[]
  name: string
  expanded?: boolean
  onPreview(): void
  onExpand(): void
}) {
  const preferences = usePreferences()
  const width = useWindowWidth()
  const openFile = useContext(FileOpenContext)
  const [limit, setLimit] = useState(5)
  const scope = preferences.diffScope
  const layout = width >= 1024 && expanded ? preferences.diffLayout : 'unified'
  const inScope = (entry: FileHistory['entries'][number], file: FileHistory) =>
    scope === 'history' || (file.currentTurnId !== undefined && entry.turnId === file.currentTurnId)
  const entries = history?.entries.filter(entry => inScope(entry, history)).toReversed() ?? []
  const files = histories.filter(file => file.entries.some(entry => inScope(entry, file)))
  return (
    <section className="file-preview file-history code-review" aria-label={HISTORY_COPY.label}>
      <header className="file-preview-head">
        <strong>
          <VisibleText text={name} />
        </strong>
      </header>
      <div className="file-preview-controls code-review-controls" role="group" aria-label={HISTORY_COPY.view}>
        <Button size="xs" variant="ghost" onClick={onPreview}>
          {HISTORY_COPY.preview}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          aria-pressed={scope === 'run'}
          onClick={() => {
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
            setPreference('diffScope', 'history')
            setLimit(5)
          }}>
          {HISTORY_COPY.history}
        </Button>
        {width >= 1024 && (
          <div className="code-review-layout" role="group" aria-label={HISTORY_COPY.layout}>
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
          </div>
        )}
      </div>
      {history ? (
        <>
          <p className="file-preview-caption">
            <VisibleText text={`${history.folder} / ${history.path}`} /> · {HISTORY_COPY.toolEdits(entries.length)}
          </p>
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
            <div className="file-preview-body code-review-entries">
              {entries.length === 0 && <InlineNotice>{HISTORY_COPY.noneThisRun}</InlineNotice>}
              {entries.slice(0, limit).map((entry, index) => {
                const number = history.entries.indexOf(entry) + 1
                return (
                  <section className="file-history-entry" key={entry.id} aria-label={HISTORY_COPY.edit(number)}>
                    <div className="file-history-entry-heading">
                      <h3>
                        {index === 0 ? HISTORY_COPY.latest : HISTORY_COPY.edit(number)} · <VisibleText text={entry.tool} />
                      </h3>
                      {entry.at && Number.isFinite(Date.parse(entry.at)) && (
                        <time className="file-preview-caption" dateTime={entry.at} title={absoluteTime(Date.parse(entry.at))}>
                          {clockTime(Date.parse(entry.at))}
                        </time>
                      )}
                    </div>
                    <DiffView diffs={[entry.diff]} layout={layout} initiallyOpen={index === 0} />
                  </section>
                )
              })}
              {entries.length > limit && (
                <Button size="sm" variant="ghost" onClick={() => setLimit(value => value + 5)}>
                  {HISTORY_COPY.earlier(entries.length - limit)}
                </Button>
              )}
            </div>
          </div>
        </>
      ) : (
        <InlineNotice>{HISTORY_COPY.none}</InlineNotice>
      )}
    </section>
  )
}
