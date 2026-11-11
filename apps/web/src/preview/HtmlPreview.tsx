import { useCallback, useMemo, useRef, useState } from 'react'
import { Button, IconButton, InlineNotice } from '@latch/ui'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { currentShell } from '../core/shell.ts'
import { FileSandbox } from './FileSandbox.tsx'
import { TextPreview } from './TextPreview.tsx'
import { DESKTOP_CANVAS, isFrameEvent, type FrameCanvas, type FrameCommand } from './types.ts'
import { openDocumentLink } from './openLink.ts'
import { useViewerMenu, useViewerSource } from './viewerActions.tsx'

function readPreference(key: string | undefined): string | null {
  try {
    return key ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function writePreference(key: string | undefined, value: boolean) {
  try {
    if (key) localStorage.setItem(key, value ? '1' : '0')
  } catch {
    /* Optional local preference. */
  }
}

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
  const [scripts, setScripts] = useState(() => readPreference(preferenceKey) === '1')
  const sizeKey = preferenceKey && `${preferenceKey}.desktop-size`
  // Unset until someone chooses: then the page's own shape decides.
  const [desktopSize, setDesktopSize] = useState<boolean | undefined>(() => {
    const stored = readPreference(sizeKey)
    return stored === null ? undefined : stored === '1'
  })
  const [detected, setDetected] = useState<FrameCanvas>()
  const [scriptsLeftOut, setScriptsLeftOut] = useState(false)
  const [externalLeftOut, setExternalLeftOut] = useState(false)
  const [pages, setPages] = useState<{ index: number; count: number }>()
  const pageWanted = useRef(0)
  const channel = useRef<((command: FrameCommand) => void) | undefined>(undefined)
  const onChannel = useCallback((send: ((command: FrameCommand) => void) | undefined) => {
    channel.current = send
  }, [])
  const [focusFrame, setFocusFrame] = useState(false)
  const [error, setError] = useState(false)
  const enabled = available && scripts
  const scriptsOff = scriptsLeftOut && detected !== undefined && !enabled
  const bytes = useMemo(() => new TextEncoder().encode(text).buffer, [text])
  const message = useCallback((value: unknown) => {
    if (!isFrameEvent(value)) return
    if (value.type === 'error') setError(true)
    if (value.type === 'link') openDocumentLink(value.href)
    if (value.type === 'html') {
      const { canvas } = value
      // Every report describes the page as it is now: a rewritten file can stop being a deck.
      setDetected(previous => (previous?.width === canvas?.width && previous?.height === canvas?.height ? previous : canvas))
      setExternalLeftOut(value.external === true)
      setScriptsLeftOut(value.scripts === true)
      setPages(value.pages)
      // An update to the file stays on this slide.
      pageWanted.current = value.pages?.index ?? 0
      setFocusFrame(false)
    }
  }, [])
  const canvas = (desktopSize ?? detected !== undefined) ? (detected ?? DESKTOP_CANVAS) : undefined
  const runScripts = (next: boolean) => {
    setScripts(next)
    setError(false)
    setFocusFrame(next)
    writePreference(preferenceKey, next)
  }
  useViewerSource(source, () => {
    setSource(!source)
  })
  useViewerMenu([
    ...(available ? [{ id: 'scripts', label: '运行页面脚本', checked: enabled, onSelect: () => runScripts(!enabled) }] : []),
    ...(source
      ? []
      : [
          {
            id: 'desktop-size',
            label: '按桌面尺寸显示',
            checked: canvas !== undefined,
            onSelect: () => {
              const next = canvas === undefined
              setDesktopSize(next)
              writePreference(sizeKey, next)
            },
          },
        ]),
  ])
  return (
    <div className="html-preview document-preview">
      {source ? (
        <TextPreview text={text} path={path} />
      ) : error ? (
        <InlineNotice tone="error">无法显示这个页面，请切换源码查看。</InlineNotice>
      ) : (
        <>
          {(scriptsOff || externalLeftOut) && (
            <InlineNotice
              action={
                scriptsOff && available ? (
                  <Button size="xs" onClick={() => runScripts(true)}>
                    运行页面脚本
                  </Button>
                ) : undefined
              }>
              {scriptsOff && (pages ? '页面脚本没有运行，动画和交互不可用。' : '页面脚本没有运行，动画、交互和翻页可能不可用。')}
              {externalLeftOut && '页面引用的脚本或样式文件没有加载，显示可能不完整。'}
              {scriptsOff && !available && (local ? '这个版本的 Latch 不能运行页面脚本。' : '只能在 Mac 上的 Latch 里运行页面脚本。')}
            </InlineNotice>
          )}
          <FileSandbox
            // The choice is read as the page starts, so a change starts it again from a clean state.
            key={`${versionKey}:${enabled}:${String(desktopSize)}`}
            kind={enabled ? 'html-script' : 'html'}
            data={bytes}
            versionKey={versionKey}
            options={{ ...(desktopSize === false ? { fit: false } : {}), pageIndex: pageWanted.current }}
            onMessage={message}
            onChannel={onChannel}
            canvas={canvas}
            focusOnReady={focusFrame}
          />
          {pages && (
            <div className="html-deck-pager">
              <IconButton
                label="上一页"
                icon={ArrowLeft}
                size="sm"
                disabled={pages.index === 0}
                onClick={() => channel.current?.({ type: 'page', index: pages.index - 1 })}
              />
              <span role="status">
                {pages.index + 1} / {pages.count}
              </span>
              <IconButton
                label="下一页"
                icon={ArrowRight}
                size="sm"
                disabled={pages.index + 1 === pages.count}
                onClick={() => channel.current?.({ type: 'page', index: pages.index + 1 })}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
