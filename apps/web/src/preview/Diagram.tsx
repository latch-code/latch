import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, InlineNotice } from '@latch/ui'
import { HighlightedCode } from './HighlightedCode.tsx'
import { isFrameEvent, type FrameInput } from './types.ts'
import { isSafeDiagramSvg, validDiagramSource } from './diagram-svg.ts'
import { useShellTheme } from '../hooks/useShellTheme.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    source: '查看源码',
    diagram: '显示图表',
    fit: '适应',
    enlarge: '放大',
    unavailable: '图表暂时无法显示，可查看源码。',
    mermaid: 'Mermaid 图表',
  },
  {
    source: 'View source',
    diagram: 'Show diagram',
    fit: 'Fit',
    enlarge: 'Enlarge',
    unavailable: 'The diagram could not be shown. View the source instead.',
    mermaid: 'Mermaid diagram',
  },
)

export function Diagram({ source, renderFrame }: { source: string; renderFrame: (input: FrameInput) => ReactNode }) {
  const [show, setShow] = useState(false),
    [svg, setSvg] = useState(''),
    [failed, setFailed] = useState(false),
    [url, setUrl] = useState(''),
    [enlarged, setEnlarged] = useState(false)
  const bytes = useMemo(() => new TextEncoder().encode(source).buffer, [source])
  // A change of theme draws the diagram again in the new one.
  const theme = useShellTheme()
  const options = useMemo(() => ({ theme }), [theme])
  const manual =
    typeof window !== 'undefined'
    && (window.matchMedia('(pointer: coarse)').matches
      || (/AppleWebKit/u.test(navigator.userAgent) && !/Chrome|Chromium/u.test(navigator.userAgent)))
  useEffect(() => {
    setSvg('')
    setFailed(false)
    setShow(!manual)
  }, [source, manual])
  useEffect(() => {
    setSvg('')
  }, [theme])
  useEffect(() => {
    if (!show || svg || !validDiagramSource(source)) return
    const timer = setTimeout(() => setFailed(true), 5000)
    return () => clearTimeout(timer)
  }, [show, source, svg])
  useEffect(() => {
    if (!svg) return
    const blob = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    setUrl(blob)
    return () => URL.revokeObjectURL(blob)
  }, [svg])
  const message = (value: unknown) => {
    if (!isFrameEvent(value)) return
    if (value.type === 'diagram') {
      if (isSafeDiagramSvg(value.svg)) setSvg(value.svg)
      else setFailed(true)
    }
    if (value.type === 'error') setFailed(true)
  }
  if (!validDiagramSource(source))
    return (
      <pre>
        <code>
          <HighlightedCode code={source} language="mermaid" enabled={false} />
        </code>
      </pre>
    )
  return (
    <div className="message-diagram">
      <div className="message-diagram-controls">
        <Button size="sm" variant="ghost" aria-pressed={show} onClick={() => setShow(!show)}>
          {show ? COPY.source : COPY.diagram}
        </Button>
        {url && show && !failed && (
          <Button size="sm" variant="ghost" aria-pressed={enlarged} onClick={() => setEnlarged(!enlarged)}>
            {enlarged ? COPY.fit : COPY.enlarge}
          </Button>
        )}
      </div>
      {show && !failed && !svg && (
        <div className="document-parser-frame">
          {renderFrame({ kind: 'mermaid', data: bytes.slice(0), versionKey: `${source}\n${theme}`, options, onMessage: message })}
        </div>
      )}
      {failed && show && <InlineNotice>{COPY.unavailable}</InlineNotice>}
      {show && url && !failed && (
        <div className={`message-diagram-image${enlarged ? ' is-enlarged' : ''}`}>
          <img src={url} alt={COPY.mermaid} onError={() => setFailed(true)} />
        </div>
      )}
      {(!show || failed) && (
        <pre>
          <code>
            <HighlightedCode code={source} language="mermaid" enabled={false} />
          </code>
        </pre>
      )}
    </div>
  )
}
