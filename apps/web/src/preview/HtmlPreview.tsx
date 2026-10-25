import { useCallback, useMemo, useState } from 'react'
import { Button, InlineNotice } from '@latch/ui'
import { currentShell } from '../core/shell.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { FileSandbox } from './FileSandbox.tsx'
import { TextPreview } from './TextPreview.tsx'
import { isFrameEvent } from './types.ts'

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
    [link, setLink] = useState(''),
    [error, setError] = useState(false)
  const enabled = available && scripts
  const bytes = useMemo(() => new TextEncoder().encode(text).buffer, [text])
  const message = useCallback((value: unknown) => {
    if (!isFrameEvent(value)) return
    if (value.type === 'html') setBlocked(value.blocked)
    if (value.type === 'error') setError(true)
    if (value.type === 'link') {
      try {
        const url = new URL(value.href)
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) setLink(url.href)
      } catch {
        /* Keep an invalid document URL inside the frame. */
      }
    }
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
              setLink('')
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
      </div>
      {!available && <p className="file-preview-caption">页面脚本只在运行 Latch 的电脑上的桌面端运行，这里显示的是静态内容。</p>}
      {blocked > 0 && <InlineNotice>页面引用了外部资源（至少 {blocked} 处），预览中不加载。</InlineNotice>}
      {link && (
        <InlineNotice
          action={
            <Button
              size="xs"
              onClick={() => {
                window.open(link, '_blank', 'noopener,noreferrer')
                setLink('')
              }}>
              打开链接
            </Button>
          }>
          文档请求打开：
          <VisibleText text={link} />
        </InlineNotice>
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
