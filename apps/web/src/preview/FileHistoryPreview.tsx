import { useContext, useState } from 'react'
import { FileCode2, Maximize2, Minimize2, X } from 'lucide-react'
import { Button, Icon, IconButton, InlineNotice } from '@latch/ui'
import { DiffView } from '../components/DiffView.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { useWindowWidth } from '../breakpoints.ts'
import { setPreference, usePreferences } from '../preferences.ts'
import { FileOpenContext } from './fileContext.ts'
import type { FileHistory } from './fileHistory.ts'
export function FileHistoryPreview({
  history,
  histories = [],
  name,
  expanded = false,
  onPreview,
  onClose,
  onExpand,
}: {
  history?: FileHistory
  histories?: FileHistory[]
  name: string
  expanded?: boolean
  onPreview(): void
  onClose(): void
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
    <section className="file-preview file-history code-review" aria-label="文件历史变更">
      <header className="file-preview-head">
        <strong>
          <VisibleText text={name} />
        </strong>
        {width >= 1024 && (
          <IconButton label={expanded ? '收起文件预览' : '展开文件预览'} icon={expanded ? Minimize2 : Maximize2} onClick={onExpand} />
        )}
        <IconButton label="关闭文件" icon={X} onClick={onClose} />
      </header>
      <div className="file-preview-controls code-review-controls" role="group" aria-label="代码审阅视图">
        <Button size="xs" variant="ghost" onClick={onPreview}>
          预览
        </Button>
        <Button
          size="xs"
          variant="ghost"
          aria-pressed={scope === 'run'}
          onClick={() => {
            setPreference('diffScope', 'run')
            setLimit(5)
          }}>
          本轮
        </Button>
        <Button
          size="xs"
          variant="ghost"
          aria-pressed={scope === 'history'}
          onClick={() => {
            setPreference('diffScope', 'history')
            setLimit(5)
          }}>
          历史
        </Button>
        {width >= 1024 && (
          <div className="code-review-layout" role="group" aria-label="差异布局">
            <Button size="xs" variant="ghost" aria-pressed={layout === 'unified'} onClick={() => setPreference('diffLayout', 'unified')}>
              行内
            </Button>
            <Button
              size="xs"
              variant="ghost"
              aria-pressed={layout === 'split'}
              onClick={() => {
                setPreference('diffLayout', 'split')
                if (!expanded) onExpand()
              }}>
              左右对照
            </Button>
          </div>
        )}
      </div>
      {history ? (
        <>
          <p className="file-preview-caption">
            <VisibleText text={`${history.folder} / ${history.path}`} /> · {entries.length} 次工具修改
          </p>
          <div className="code-review-content" data-multiple={files.length > 1 ? '' : undefined}>
            {files.length > 1 && (
              <nav className="code-review-files" aria-label="变更文件">
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
              {entries.length === 0 && <InlineNotice>这个文件在本轮没有修改。可以切换历史查看之前的变更。</InlineNotice>}
              {entries.slice(0, limit).map((entry, index) => {
                const number = history.entries.indexOf(entry) + 1
                return (
                  <section className="file-history-entry" key={entry.id} aria-label={`第 ${number} 次修改`}>
                    <div className="file-history-entry-heading">
                      <h3>
                        {index === 0 ? '最新修改' : `第 ${number} 次修改`} · <VisibleText text={entry.tool} />
                      </h3>
                      {entry.at && Number.isFinite(Date.parse(entry.at)) && (
                        <time className="file-preview-caption" dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>
                          {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </time>
                      )}
                    </div>
                    <DiffView diffs={[entry.diff]} layout={layout} initiallyOpen={index === 0} />
                  </section>
                )
              })}
              {entries.length > limit && (
                <Button size="sm" variant="ghost" onClick={() => setLimit(value => value + 5)}>
                  查看更早的修改（还有 {entries.length - limit} 次）
                </Button>
              )}
            </div>
          </div>
        </>
      ) : (
        <InlineNotice>这个文件还没有已记录的工具修改。</InlineNotice>
      )}
    </section>
  )
}
