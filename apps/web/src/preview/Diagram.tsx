import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2 } from 'lucide-react'
import {
  Button,
  CodeGlyph,
  DownloadGlyph,
  EyeGlyph,
  IconButton,
  InlineNotice,
  Menu,
  Modal,
  ModalHeader,
  MoreGlyph,
  Spinner,
  UI_COPY,
  useCopy,
  type MenuItem,
} from '@latch/ui'
import { defineCopy } from '../core/i18n.ts'
import { useShellTheme } from '../hooks/useShellTheme.ts'
import { DiagramCanvas } from './DiagramCanvas.tsx'
import { HighlightedCode } from './HighlightedCode.tsx'
import { isSafeDiagramSvg, validDiagramSource } from './diagram-svg.ts'
import { isFrameEvent, type FrameInput } from './types.ts'

const COPY = defineCopy(
  {
    actions: '图表操作',
    source: '查看源码',
    diagram: '显示图表',
    expand: '展开图表',
    copy: '复制为代码',
    download: '下载图像',
    drawing: '正在绘制图表…',
    retry: '重试',
    unavailable: '图表暂时无法显示，可查看下方源码。',
    mermaid: 'Mermaid 图表',
  },
  {
    actions: 'Diagram actions',
    source: 'View source',
    diagram: 'Show diagram',
    expand: 'Expand diagram',
    copy: 'Copy as code',
    download: 'Download image',
    drawing: 'Rendering diagram…',
    retry: 'Retry',
    unavailable: 'The diagram could not be shown. Its source is below.',
    mermaid: 'Mermaid diagram',
  },
)

type DiagramProps = { source: string; renderFrame: (input: FrameInput) => ReactNode }

function DiagramSource({ source }: { source: string }) {
  return (
    <pre>
      <code>
        <HighlightedCode code={source} language="mermaid" enabled={false} />
      </code>
    </pre>
  )
}

export function Diagram(props: DiagramProps) {
  if (!validDiagramSource(props.source)) return <DiagramSource source={props.source} />
  return <DiagramPreview key={props.source} {...props} />
}

function DiagramPreview({ source, renderFrame }: DiagramProps) {
  const theme = useShellTheme()
  const [show, setShow] = useState(
    () =>
      typeof window !== 'undefined'
      && !window.matchMedia('(pointer: coarse)').matches
      && !(/AppleWebKit/u.test(navigator.userAgent) && !/Chrome|Chromium/u.test(navigator.userAgent)),
  )
  const [expanded, setExpanded] = useState(false)
  const [rendered, setRendered] = useState<{ theme: typeof theme; svg: string }>()
  const [url, setUrl] = useState('')
  const [failedTheme, setFailedTheme] = useState<typeof theme>()
  const { state: copyState, copy } = useCopy()
  const data = useMemo(() => new TextEncoder().encode(source).buffer, [source])
  const options = useMemo(() => ({ theme }), [theme])
  const failed = failedTheme === theme
  const rendering = show && !failed && rendered?.theme !== theme
  const visible = show && !failed && !!url
  useEffect(() => {
    if (!rendering) return
    const timer = setTimeout(() => {
      setFailedTheme(theme)
      setExpanded(false)
    }, 5000)
    return () => clearTimeout(timer)
  }, [rendering, theme])
  useEffect(() => {
    if (!rendered) return
    const blob = URL.createObjectURL(new Blob([rendered.svg], { type: 'image/svg+xml' }))
    setUrl(blob)
    return () => URL.revokeObjectURL(blob)
  }, [rendered])
  const fail = () => {
    setFailedTheme(theme)
    setExpanded(false)
  }
  const message = (value: unknown) => {
    if (!isFrameEvent(value)) return
    if (value.type === 'diagram') {
      if (isSafeDiagramSvg(value.svg)) setRendered({ theme, svg: value.svg })
      else fail()
    }
    if (value.type === 'error') fail()
  }
  const items: MenuItem[] = [{ id: 'copy', icon: CodeGlyph, label: COPY.copy, onSelect: () => void copy(source) }]
  if (visible)
    items.push({
      id: 'download',
      icon: DownloadGlyph,
      label: COPY.download,
      meta: 'SVG',
      onSelect: () => {
        const link = document.createElement('a')
        link.href = url
        link.download = 'diagram.svg'
        link.click()
      },
    })
  if (show && !failed) items.push({ id: 'source', icon: EyeGlyph, label: COPY.source, onSelect: () => setShow(false) })
  return (
    <div className="message-diagram">
      <div className="message-diagram-controls">
        {(!show || failed) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (failed) {
                setFailedTheme(undefined)
                setRendered(undefined)
                setUrl('')
              }
              setShow(true)
            }}>
            {failed ? COPY.retry : COPY.diagram}
          </Button>
        )}
        {show && !failed && !url && (
          <span className="diagram-render-status" role="status">
            <Spinner size={14} /> {COPY.drawing}
          </span>
        )}
        <span className="diagram-copy-status" role="status">
          {copyState === 'copied' ? UI_COPY.copied : copyState === 'failed' ? UI_COPY.copyUnavailable : ''}
        </span>
        <Menu
          label={COPY.actions}
          align="end"
          sections={[{ id: 'diagram', items }]}
          trigger={props => <IconButton {...props} round label={COPY.actions} icon={MoreGlyph} />}
        />
        {visible && (
          <IconButton
            round
            label={COPY.expand}
            icon={Maximize2}
            aria-haspopup="dialog"
            onClick={event => {
              event.currentTarget.focus({ preventScroll: true })
              setExpanded(true)
            }}
          />
        )}
      </div>
      {rendering && (
        <div className="document-parser-frame">
          {renderFrame({ kind: 'mermaid', data, versionKey: `${source}\n${theme}`, options, onMessage: message })}
        </div>
      )}
      {failed && <InlineNotice>{COPY.unavailable}</InlineNotice>}
      {visible && <DiagramCanvas url={url} onError={fail} />}
      {(!show || failed) && <DiagramSource source={source} />}
      {expanded
        && visible
        && createPortal(
          <Modal label={COPY.mermaid} onClose={() => setExpanded(false)} className="diagram-viewer">
            <ModalHeader title={COPY.mermaid} onClose={() => setExpanded(false)} />
            <DiagramCanvas expanded url={url} onError={fail} />
          </Modal>,
          document.body,
        )}
    </div>
  )
}
