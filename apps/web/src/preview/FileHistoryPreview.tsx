import { Maximize2, X } from 'lucide-react'
import { Button, IconButton, InlineNotice } from '@latch/ui'
import { DiffView } from '../components/DiffView.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import type { FileHistory } from './fileHistory.ts'
export function FileHistoryPreview({
  history,
  name,
  onPreview,
  onClose,
  onExpand,
}: {
  history?: FileHistory
  name: string
  onPreview(): void
  onClose(): void
  onExpand(): void
}) {
  return (
    <section className="file-preview file-history" aria-label="文件历史变更">
      <header className="file-preview-head">
        <strong>
          <VisibleText text={name} />
        </strong>
        <IconButton label="展开文件预览" icon={Maximize2} onClick={onExpand} />
        <IconButton label="关闭文件" icon={X} onClick={onClose} />
      </header>
      <div className="file-preview-controls" role="group" aria-label="文件视图">
        <Button size="xs" variant="ghost" onClick={onPreview}>
          预览
        </Button>
        <Button size="xs" variant="ghost" aria-pressed>
          变更
        </Button>
      </div>
      {history ? (
        <>
          <p className="file-preview-caption">
            <VisibleText text={`${history.folder} / ${history.path}`} /> · {history.entries.length} 次工具修改
          </p>
          <div className="file-preview-body">
            {history.entries.map((entry, index) => (
              <section className="file-history-entry" key={entry.id} aria-label={`第 ${index + 1} 次修改`}>
                <h3>
                  第 {index + 1} 次修改 · <VisibleText text={entry.tool} />
                </h3>
                {entry.at && Number.isFinite(Date.parse(entry.at)) && (
                  <time className="file-preview-caption" dateTime={entry.at}>
                    {new Date(entry.at).toLocaleString()}
                  </time>
                )}
                <DiffView diffs={[entry.diff]} />
              </section>
            ))}
          </div>
        </>
      ) : (
        <InlineNotice>这个文件还没有已记录的工具修改。</InlineNotice>
      )}
    </section>
  )
}
