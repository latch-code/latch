import { createContext, memo, useContext, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import Markdown, { type Components, type Options, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { HighlightedCode } from './preview/HighlightedCode.tsx'
import { MathFormula } from './preview/MathFormula.tsx'
import { useSeen } from './preview/viewportGate.ts'
import { Diagram } from './preview/Diagram.tsx'
import type { FrameInput } from './preview/types.ts'
import { normalizeMathDelimiters, restrictInlineMath } from './preview/math.ts'

import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { FileChip, FileRootContext, FileSession } from './components/FileChip.tsx'
import { FileOpenContext } from './preview/fileContext.ts'
import { FileSandbox } from './preview/FileSandbox.tsx'
import { resolveFileImage } from './preview/fileImages.ts'
import { useKnownFiles } from './components/FileReferences.tsx'
import { hasHiddenCharacters, VisibleText } from './components/VisibleText.tsx'
import { codePathCandidate, linkTarget, namesPath, referenceText, urlScheme } from './fileReference.ts'
import { exceedsMarkdownNesting, MAX_TREE_DEPTH, treeDepth } from './markdownNesting.ts'
import { ICON_STROKE, CheckGlyph, ChevronDownGlyph, ChevronUpGlyph, CopyGlyph, writeClipboard } from '@latch/ui'

export interface MarkdownFiles {
  path?: string
  onOpenFile?: (reference: string) => void
  resolveImage?: (reference: string, signal: AbortSignal) => Promise<{ url: string; width?: number; height?: number }>
}
export interface MessageContentProps extends MarkdownFiles {
  text: string
  streaming?: boolean
  renderFrame?: (input: FrameInput) => ReactNode
}

class TooDeep extends Error {}

/** Runs after parsing, before the recursive Markdown-to-HTML step. */
function limitDepth() {
  return (tree: Parameters<typeof treeDepth>[0]) => {
    if (treeDepth(tree) > MAX_TREE_DEPTH) throw new TooDeep()
  }
}

interface MarkdownNode {
  type: string
  value?: string
  lang?: string
  children?: MarkdownNode[]
}
const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])
const LINE_BREAK = /^<br\s*\/?>$/iu
const COMMENT = /^<!--(?:(?!-->)[\s\S])*-->\s*$/u
const DISCLOSURE_TAG = /<\/?(?:details|summary)(?:\s[^<>]*)?>/giu

/**
 * What a reply's raw HTML reads as. A line break breaks the line and a comment says nothing to the reader; a disclosure
 * is its words, all shown. Anything else reads as the code it is, or as the text it is in a sentence.
 */
function literalNode(node: MarkdownNode, block: boolean): MarkdownNode[] {
  const value = node.value ?? ''
  if (COMMENT.test(value)) return []
  if (LINE_BREAK.test(value.trim())) return block ? [] : [{ type: 'break' }]
  if (!block) return [{ ...node, type: 'text' }]
  const words = value.replace(DISCLOSURE_TAG, '').trim()
  if (words !== value.trim() && !words.includes('<'))
    return words ? [{ type: 'paragraph', children: [{ type: 'text', value: words }] }] : []
  return [{ ...node, type: 'code', lang: 'html' }]
}

/** Raw HTML never becomes elements, and a reply's words must not vanish with it. Runs after `limitDepth`, which bounds this walk. */
function literalHtml() {
  const walk = (parent: MarkdownNode) => {
    if (!parent.children) return
    parent.children = parent.children.flatMap(node => {
      if (node.type === 'html') return literalNode(node, BLOCK_PARENTS.has(parent.type))
      walk(node)
      return [node]
    })
  }
  return walk
}

const remarkPlugins = [remarkGfm, remarkMath, restrictInlineMath, limitDepth]
const replyPlugins = [...remarkPlugins, literalHtml]
const MarkdownFileContext = createContext<MarkdownFiles>({})
const relativeBase = 'https://markdown.invalid/'
const relativeOrigin = new URL(relativeBase).origin
const renderDocumentFrame = (input: FrameInput) => <FileSandbox {...input} />

/**
 * Keep navigation within ordinary web links; never pass executable URL schemes. A `file:` URI, and a file name with a
 * line number that only looks like a scheme (`report.md:12`), pass only to become a path chip, which never navigates.
 */
const safeUrl: UrlTransform = (value, key) => {
  const url = value.trim()
  if (!url || /[\u0000-\u001f\u007f\\]/.test(url) || url.startsWith('//')) return undefined

  const scheme = urlScheme(url)
  if (scheme === 'file' || (scheme === undefined && /^[^/?#]*:/u.test(url))) return url
  if (scheme && scheme !== 'http' && scheme !== 'https' && !(scheme === 'mailto' && key === 'href')) return undefined

  try {
    const parsed = new URL(url, relativeBase)
    if (!scheme && parsed.origin !== relativeOrigin) return undefined
    return url
  } catch {
    return undefined
  }
}

type CopyResult = { status: 'copied' | 'failed'; value: string } | null

/** Lines a long block shows: its first ones once closed, its newest ones while they arrive, with a line saying so. */
const COLLAPSED_LINES = 18
const TAIL_LINES = COLLAPSED_LINES - 1

const CodeBlock = memo(function CodeBlock({ code, language, closed = true }: { code: string; language?: string; closed?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [copyResult, setCopyResult] = useState<CopyResult>(null)
  const [copying, setCopying] = useState(false)
  const codeId = useId()
  const pre = useRef<HTMLPreElement>(null)
  const seen = useSeen(pre)
  const mounted = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const lines = useMemo(() => (code ? code.split('\n').length - (code.endsWith('\n') ? 1 : 0) : 0), [code])
  const hidden = useMemo(() => hasHiddenCharacters(code), [code])
  const isLong = lines > COLLAPSED_LINES
  const collapsed = isLong && !expanded
  const tail = collapsed && !closed
  const copied = copyResult?.status === 'copied' && copyResult.value === code
  const failed = copyResult?.status === 'failed'

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimeout(resetTimer.current)
    }
  }, [])

  async function copy() {
    setCopying(true)
    setCopyResult(null)
    clearTimeout(resetTimer.current)
    try {
      await writeClipboard(code)
      if (!mounted.current) return
      setCopyResult({ status: 'copied', value: code })
      resetTimer.current = setTimeout(() => setCopyResult(null), 2500)
    } catch {
      if (mounted.current) setCopyResult({ status: 'failed', value: code })
    } finally {
      if (mounted.current) setCopying(false)
    }
  }

  return (
    <div className={`message-code${collapsed ? ' is-collapsed' : ''}${closed ? '' : ' is-open'}${tail ? ' is-tail' : ''}`}>
      <div className="message-code-toolbar">
        <span className="message-code-language">{language || '代码'}</span>
        {hidden && (
          <span className="message-code-hidden" title="显示时已用 \\u{…} 标出；复制的内容保留原字符">
            含不可见字符
          </span>
        )}
        <button
          type="button"
          className="message-code-copy"
          onClick={() => void copy()}
          disabled={copying || !code}
          aria-label="复制代码"
          title={copied ? '已复制' : '复制'}>
          {copied ? (
            <CheckGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          ) : (
            <CopyGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          )}
        </button>
      </div>
      {tail && <p className="message-code-tail-note">前 {lines - TAIL_LINES} 行已收起</p>}
      <pre ref={pre} id={codeId} tabIndex={0} aria-label={language ? `${language} 代码` : '代码内容'}>
        <code>
          <HighlightedCode
            code={code}
            language={language}
            enabled={seen}
            streaming={!closed}
            {...(tail ? { tail: TAIL_LINES } : collapsed ? { colourLines: COLLAPSED_LINES + 1 } : {})}
          />
        </code>
      </pre>
      {isLong && (
        <button
          type="button"
          className="message-code-expand"
          aria-expanded={expanded}
          aria-controls={codeId}
          onClick={() => setExpanded(value => !value)}>
          {expanded ? '收起代码' : `展开全部 ${lines} 行`}
          {expanded ? (
            <ChevronUpGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          ) : (
            <ChevronDownGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          )}
        </button>
      )}
      <span className="message-copy-status" role="status" aria-live="polite">
        {copied ? '代码已复制到剪贴板' : ''}
      </span>
      {failed && (
        <p className="message-copy-error" role="alert">
          复制失败，请选中代码手动复制，或重试。
        </p>
      )}
    </div>
  )
})

/** The plain text of a rendered element, to tell a link whose text is its own path. */
function textOf(node: { type: string; value?: string; children?: unknown[] } | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(child => textOf(child as Parameters<typeof textOf>[0])).join('')
}

/** Whether the reply stopped streaming: only then is its inline code asked about. */
const ReplySettled = createContext(true)
const SourceText = createContext('')
const FrameRenderer = createContext<((input: FrameInput) => ReactNode) | undefined>(undefined)
/**
 * Whether the code block at `start` has closed while the reply still arrives. A block with no fence has ended once
 * anything follows it. Inside a list item or a quote, every line of a fence carries that container's prefix.
 */
function codeClosed(source: string, start: number, end: number): boolean {
  const block = source.slice(start)
  const marker = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/u.exec(block)?.[1]
  if (!marker) return source.slice(end).trim() !== ''
  const container = source
    .slice(source.lastIndexOf('\n', start - 1) + 1, start)
    .replace(/[^>\s]/gu, ' ')
    .replace(/> /gu, '> ?')
  return new RegExp(`\\n${container} {0,3}${marker[0]}{${marker.length},}[^\\S\\n]*(?:\\n|$)`, 'u').test(block)
}
function ClosedCode({ code, language, start, end }: { code: string; language?: string; start?: number; end?: number }) {
  const renderFrame = useContext(FrameRenderer)
  const source = useContext(SourceText),
    settled = useContext(ReplySettled)
  const closed = settled || (start !== undefined && end !== undefined && codeClosed(source, start, end))
  if (language === 'mermaid' && closed && renderFrame) return <Diagram key={code} source={code} renderFrame={renderFrame} />
  return <CodeBlock code={code} language={language} closed={closed} />
}

/**
 * Inline code. In the desktop app, code that looks like a path (`deck.pptx`, `src/app.ts:12`) becomes a path chip
 * once the reply settled and the Host said it names a file; everything else stays code.
 */
function InlineCode({ children, ...props }: ComponentProps<'code'>) {
  const settled = useContext(ReplySettled)
  const text = typeof children === 'string' ? children : undefined
  const candidate = text === undefined ? undefined : codePathCandidate(text)
  const files = useKnownFiles(candidate === undefined ? [] : [candidate], settled)
  return candidate !== undefined && files.length > 0 ? <FileChip path={candidate} label={text} /> : <code {...props}>{children}</code>
}

function relativeFile(reference: string, path?: string): string | undefined {
  if (!path || /^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(reference)) return reference
  const parts = path.split('/').slice(0, -1)
  for (const part of reference.split('/')) {
    if (part === '..') {
      if (!parts.length) return undefined
      parts.pop()
    } else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/')
}
function MarkdownFile({
  reference,
  children,
  image = false,
  alt,
}: {
  reference: string
  children?: ReactNode
  image?: boolean
  alt?: string
}) {
  const files = useContext(MarkdownFileContext),
    path = relativeFile(reference, files.path),
    [value, setValue] = useState<{ path: string; url: string; width?: number; height?: number }>()
  useEffect(() => {
    if (!image || !path || !files.resolveImage) return
    const controller = new AbortController()
    void files
      .resolveImage(path, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return
        if (result.url.length > 4096) return
        const url = new URL(result.url, location.href)
        const here = new URL(location.href)
        if (
          !(url.protocol === 'blob:' && url.origin === location.origin)
          && !(
            url.protocol === here.protocol
            && url.host === here.host
            && /^\/link\/api\/files\/[A-Za-z0-9_-]{22}$/u.test(url.pathname)
            && (!url.search || /^\?v=[a-f0-9]{32}$/u.test(url.search))
            && !url.hash
          )
        )
          return
        if ([result.width, result.height].some(n => n !== undefined && (!Number.isFinite(n) || n <= 0 || n > 40_000))) return
        setValue({ path, ...result })
      })
      .catch(() => {})
    return () => controller.abort()
  }, [image, path, files.resolveImage])
  if (image && path && value?.path === path) {
    const picture = (
      <img className="message-local-image" src={value.url} alt={alt || '图片'} width={value.width} height={value.height} loading="lazy" />
    )
    return files.onOpenFile ? (
      <button
        type="button"
        className="message-local-image-button"
        aria-label={`预览图片：${alt || reference}`}
        onClick={() => files.onOpenFile?.(path)}>
        {picture}
      </button>
    ) : (
      picture
    )
  }
  if (path && files.onOpenFile)
    return (
      <button type="button" className="message-local-link" onClick={() => files.onOpenFile?.(path)}>
        {children ?? alt ?? reference}
      </button>
    )
  return <FileChip path={reference} label={children} image={image} alt={alt} />
}

// Component identities stay stable as tokens arrive, preserving code-block focus,
// expanded state, and the reader's scroll position.
const components: Components = {
  code({ node: _node, ...props }) {
    if (props.className?.includes('math-inline')) return <MathFormula tex={String(props.children)} />
    return <InlineCode {...props} />
  },
  // Network images stay explicit links. Only the parent can resolve a local reference to authorized bytes.
  img({ node: _node, src, alt }) {
    const label = alt?.trim() || '图片'
    if (src && /^https?:/i.test(src))
      return (
        <a className="message-image" href={src} target="_blank" rel="noopener noreferrer">
          外部图片：{label}
        </a>
      )
    const path = src ? referenceText(src) : undefined
    return path ? (
      <MarkdownFile reference={path} image {...(alt?.trim() ? { alt: alt.trim() } : {})} />
    ) : (
      <span className="message-image">图片：{label}</span>
    )
  },
  pre({ node, children }) {
    const codeNode = node?.children.find(child => child.type === 'element' && child.tagName === 'code')
    if (codeNode?.type !== 'element') return <pre>{children}</pre>
    const code = codeNode.children.map(child => (child.type === 'text' ? child.value : '')).join('')
    const classNames = Array.isArray(codeNode.properties.className) ? codeNode.properties.className.join(' ') : ''
    const language = /(?:^|\s)language-([a-z\d_+#.-]{1,32})(?=[\s,]|$)/i.exec(classNames)?.[1]
    if (classNames.includes('math-display')) return <MathFormula tex={code.trimEnd()} block />
    return <ClosedCode code={code} language={language} start={node?.position?.start.offset} end={node?.position?.end.offset} />
  },
  table({ node: _node, ...props }) {
    return (
      <div className="message-table-scroll" tabIndex={0} role="region" aria-label="表格，可横向滚动">
        <table {...props} />
      </div>
    )
  },
}

export const MessageContent = memo(function MessageContent({
  text,
  streaming = false,
  renderFrame,
  path,
  onOpenFile,
  resolveImage,
}: MessageContentProps) {
  const id = useId()
  const session = useContext(FileSession),
    rootId = useContext(FileRootContext),
    openFile = useContext(FileOpenContext)
  const inherited = useMemo<MarkdownFiles>(
    () =>
      openFile && session
        ? {
            onOpenFile: reference => openFile({ sessionId: session.id, reference, ...(rootId ? { rootId } : {}) }),
            resolveImage: (reference, signal) => resolveFileImage(session.id, reference, rootId, signal),
          }
        : {},
    [openFile, session?.id, rootId],
  )
  const effectiveOpenFile = onOpenFile ?? inherited.onOpenFile
  const effectiveImage = resolveImage ?? inherited.resolveImage
  const normalized = useMemo(() => normalizeMathDelimiters(text), [text])
  // Footnote ids must be unique across messages in the same conversation.
  const remarkRehypeOptions = useMemo(() => ({ clobberPrefix: `${id}-`, footnoteLabel: '注释' }), [id])
  const messageComponents = useMemo<Components>(
    () => ({
      ...components,
      // Only web and mail addresses are links, and footnotes of this reply; a file reference is a path chip that never
      // navigates the page, and anything else is its text.
      a({ node, children, href, 'aria-describedby': describedBy, ...props }) {
        if (!href) return <span>{children}</span>
        const target = linkTarget(href, `${id}-`)
        if (target.kind === 'path') {
          if (onOpenFile) return <MarkdownFile reference={target.path}>{children}</MarkdownFile>
          const linkText = textOf(node).trim()
          if (!linkText) return <FileChip path={target.path} />
          // A label that is the path itself is drawn from its text, so its folders can give way to the file name.
          return namesPath(linkText, target.path) ? (
            <FileChip path={target.path} label={linkText} />
          ) : (
            <FileChip path={target.path} label={children} mono={false} />
          )
        }
        if (target.kind === 'text') return <span>{children}</span>
        const external = target.kind === 'web'
        return (
          <a
            {...props}
            href={href}
            aria-describedby={describedBy === 'footnote-label' ? `${id}-footnote-label` : describedBy}
            target={external ? '_blank' : undefined}
            rel={external ? 'noopener noreferrer' : undefined}>
            {children}
          </a>
        )
      },
      h2({ node: _node, id: headingId, ...props }) {
        return <h2 {...props} id={headingId === 'footnote-label' ? `${id}-footnote-label` : headingId} />
      },
    }),
    [id, onOpenFile],
  )

  const rendered = useMemo(
    () =>
      renderMarkdown({
        children: normalized,
        // A file's preview renders the document and has its source a press away; a reply has no other copy of its words.
        remarkPlugins: path === undefined ? replyPlugins : remarkPlugins,
        remarkRehypeOptions,
        components: messageComponents,
        urlTransform: safeUrl,
        skipHtml: true,
      }),
    [normalized, path, remarkRehypeOptions, messageComponents],
  )
  const plain = <PlainText text={text} />
  return (
    <div className="message-content" aria-busy={streaming || undefined}>
      {rendered === null ? (
        plain
      ) : (
        <ErrorBoundary resetKey={text} fallback={plain}>
          <ReplySettled.Provider value={!streaming}>
            <SourceText.Provider value={normalized}>
              <FrameRenderer.Provider value={renderFrame ?? (openFile && session ? renderDocumentFrame : undefined)}>
                <MarkdownFileContext.Provider value={{ path, onOpenFile: effectiveOpenFile, resolveImage: effectiveImage }}>
                  {rendered}
                </MarkdownFileContext.Provider>
              </FrameRenderer.Provider>
            </SourceText.Provider>
          </ReplySettled.Provider>
        </ErrorBoundary>
      )}
    </div>
  )
})

export const PLAIN_TEXT_NOTE = '结构过深，按纯文本显示'

function PlainText({ text }: { text: string }) {
  return (
    <>
      <p className="message-plain-note">{PLAIN_TEXT_NOTE}</p>
      <pre className="message-plain">
        <VisibleText text={text} />
      </pre>
    </>
  )
}

/** Markdown elements, or null when the text nests too deeply (or the pipeline fails) and must be shown plain. */
export function renderMarkdown(options: Options): ReactNode | null {
  if (exceedsMarkdownNesting(options.children ?? '')) return null
  // `Markdown` is synchronous and uses no hooks, so its parse and conversion errors can be caught here.
  try {
    return Markdown(options)
  } catch {
    return null
  }
}
