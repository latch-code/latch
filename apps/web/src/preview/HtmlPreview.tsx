import { useCallback, useMemo, useState } from 'react'
import { Button, IconButton, InlineNotice } from '@latch/ui'
import { Info } from 'lucide-react'
import { currentShell } from '../core/shell.ts'
import { FileSandbox } from './FileSandbox.tsx'
import { TextPreview } from './TextPreview.tsx'
import { isFrameEvent } from './types.ts'
import { openDocumentLink } from './openLink.ts'

export function HtmlPreview({
  text,
  path,
  versionKey,
  preferenceKey,
  local,
}: {
  text: string
  path: string
  versionKey: string
  preferenceKey?: string
  local: boolean
}) {
  const available = local && currentShell()?.previews?.protocolVersion === 1 && currentShell()?.previews?.htmlScripts === true
  const [source, setSource] = useState(false)
  const [scripts, setScripts] = useState(() => {
    try {
      return !!preferenceKey && localStorage.getItem(preferenceKey) === '1'
    } catch {
      return false
    }
  })
  const [blocked, setBlocked] = useState(0),
    [info, setInfo] = useState(false),
    [error, setError] = useState(false)
  const enabled = available && scripts
  const bytes = useMemo(() => new TextEncoder().encode(text).buffer, [text])
  const message = useCallback((value: unknown) => {
    if (!isFrameEvent(value)) return
    if (value.type === 'html') setBlocked(value.blocked)
    if (value.type === 'error') setError(true)
    if (value.type === 'link') openDocumentLink(value.href)
  }, [])
  return (
    <div className="html-preview document-preview">
      <div className="file-preview-controls" role="group" aria-label="HTML 视图">
        <Button size="xs" variant="ghost" aria-pressed={!source} onClick={() => setSource(false)}>
          预览
        </Button>
        <Button size="xs" variant="ghost" aria-pressed={source} onClick={() => setSource(true)}>
          源码
        </Button>
        {available && (
          <Button
            size="xs"
            variant="ghost"
            aria-pressed={enabled}
            onClick={() => {
              const next = !enabled
              setScripts(next)
              setBlocked(0)
              setError(false)
              try {
                if (preferenceKey) localStorage.setItem(preferenceKey, next ? '1' : '0')
              } catch {
                /* Optional local preference. */
              }
            }}>
            运行页面脚本
          </Button>
        )}
        <IconButton icon={Info} size="xs" label="预览说明" aria-pressed={info} onClick={() => setInfo(!info)} />
      </div>
      {info && (
        <div className="file-preview-caption" role="note">
          {!available && <p>这里显示页面的静态预览。可以在这台电脑的桌面端运行页面脚本。</p>}
          {blocked > 0 && <p>部分外部图片或资源未加载（至少 {blocked} 处）。</p>}
          <p>文档链接会在默认浏览器打开。</p>
        </div>
      )}
      {source ? (
        <TextPreview text={text} path={path} />
      ) : error ? (
        <InlineNotice tone="error">无法显示这个页面，请切换源码查看。</InlineNotice>
      ) : (
        <FileSandbox
          key={`${versionKey}:${enabled}`}
          kind={enabled ? 'html-script' : 'html'}
          data={bytes}
          versionKey={versionKey}
          onMessage={message}
        />
      )}
    </div>
  )
}
