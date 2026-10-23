import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import Markdown, { type Components, type Options, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, ChevronDown, ChevronUp, Copy } from 'lucide-react'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { hasHiddenCharacters, VisibleText } from './components/VisibleText.tsx'
import { exceedsMarkdownNesting, MAX_TREE_DEPTH, treeDepth } from './markdownNesting.ts'

export interface MessageContentProps {
  text: string
  streaming?: boolean
}

class TooDeep extends Error {}

/** Runs after parsing, before the recursive Markdown-to-HTML step. */
function limitDepth() {
  return (tree: Parameters<typeof treeDepth>[0]) => {
    if (treeDepth(tree) > MAX_TREE_DEPTH) throw new TooDeep()
  }
}

const remarkPlugins = [remarkGfm, limitDepth]
const relativeBase = 'https://markdown.invalid/'
const relativeOrigin = new URL(relativeBase).origin

/** Keep navigation within ordinary web links; never pass executable URL schemes. */
const safeUrl: UrlTransform = (value, key) => {
  const url = value.trim()
  if (!url || /[\u0000-\u001f\u007f\\]/.test(url) || url.startsWith('//')) return undefined

  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(url)?.[1]?.toLowerCase()
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

const CodeBlock = memo(function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [expanded, setExpanded] = useState(false)
  const [copyResult, setCopyResult] = useState<CopyResult>(null)
  const [copying, setCopying] = useState(false)
  const codeId = useId()
  const mounted = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout>>()
  const lines = useMemo(() => (code ? code.split('\n').length - (code.endsWith('\n') ? 1 : 0) : 0), [code])
  const hidden = useMemo(() => hasHiddenCharacters(code), [code])
  const isLong = lines > 18
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
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(code)
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
    <div className={`message-code${isLong && !expanded ? ' is-collapsed' : ''}`}>
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
          {copied ? <Check size={14} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
        </button>
      </div>
      <pre id={codeId} tabIndex={0} aria-label={language ? `${language} 代码` : '代码内容'}>
        <code>
          <VisibleText text={code} />
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
            <ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
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

// Component identities stay stable as tokens arrive, preserving code-block focus,
// expanded state, and the reader's scroll position.
const components: Components = {
  // Images are never loaded: a URL the model chose would be fetched as soon as the reply renders, carrying whatever
  // it encodes. A web image stays reachable as an ordinary link the reader opens.
  img({ node: _node, src, alt }) {
    const label = alt?.trim() || '图片'
    return src && /^https?:/i.test(src) ? (
      <a className="message-image" href={src} target="_blank" rel="noopener noreferrer">
        外部图片：{label}
      </a>
    ) : (
      <span className="message-image">图片：{label}</span>
    )
  },
  pre({ node, children }) {
    const codeNode = node?.children.find(child => child.type === 'element' && child.tagName === 'code')
    if (codeNode?.type !== 'element') return <pre>{children}</pre>
    const code = codeNode.children.map(child => (child.type === 'text' ? child.value : '')).join('')
    const classNames = Array.isArray(codeNode.properties.className) ? codeNode.properties.className.join(' ') : ''
    const language = /(?:^|\s)language-([a-z\d_+#.-]{1,32})(?=\s|$)/i.exec(classNames)?.[1]
    return <CodeBlock code={code} language={language} />
  },
  table({ node: _node, ...props }) {
    return (
      <div className="message-table-scroll" tabIndex={0} role="region" aria-label="表格，可横向滚动">
        <table {...props} />
      </div>
    )
  },
}

export const MessageContent = memo(function MessageContent({ text, streaming = false }: MessageContentProps) {
  const id = useId()
  // Footnote ids must be unique across messages in the same conversation.
  const remarkRehypeOptions = useMemo(() => ({ clobberPrefix: `${id}-`, footnoteLabel: '注释' }), [id])
  const messageComponents = useMemo<Components>(
    () => ({
      ...components,
      a({ node: _node, children, href, 'aria-describedby': describedBy, ...props }) {
        if (!href) return <span>{children}</span>
        const external = /^https?:/i.test(href)
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
    [id],
  )

  const rendered = useMemo(
    () =>
      renderMarkdown({
        children: text,
        remarkPlugins,
        remarkRehypeOptions,
        components: messageComponents,
        urlTransform: safeUrl,
        skipHtml: true,
      }),
    [text, remarkRehypeOptions, messageComponents],
  )
  const plain = <PlainText text={text} />
  return (
    <div className="message-content" aria-busy={streaming || undefined}>
      {rendered === null ? (
        plain
      ) : (
        <ErrorBoundary resetKey={text} fallback={plain}>
          {rendered}
        </ErrorBoundary>
      )}
    </div>
  )
})

export const PLAIN_TEXT_NOTE = '内容结构过深，已按纯文本显示。'

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
