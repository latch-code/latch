import {
  cloneElement,
  createContext,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from 'react'
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
import { drawableMedia, mediaTypeOf, resolveFileMedia, type ResolvedMedia } from './preview/fileImages.ts'
import { InlineMedia } from './components/InlineMedia.tsx'
import { KnownFilesContext, useKnownFiles } from './components/FileReferences.tsx'
import { ReplyFileIcon } from './components/ReplyFileIcon.tsx'
import { hasHiddenCharacters, VisibleText } from './components/VisibleText.tsx'
import { codePathCandidate, linkTarget, namesPath, referenceName, referenceText, urlScheme } from './fileReference.ts'
import { exceedsMarkdownNesting, MAX_TREE_DEPTH, treeDepth } from './markdownNesting.ts'
import { createStreamingMarkdown } from './markdown/renderBlocks.tsx'
import { TerminalFillButton } from './components/TerminalFillButton.tsx'
import { isShellLanguage } from './panel/terminal/fill.ts'
import { FillPlace } from './panel/terminal/fills.ts'
import { ICON_STROKE, CheckGlyph, ChevronDownGlyph, ChevronUpGlyph, CopyGlyph, writeClipboard } from '@latch/ui'
import { defineCopy, plural, useLocale } from './core/i18n.ts'

const COPY = defineCopy(
  {
    code: '代码',
    invisibleTip: '显示时已用 \\\\u{…} 标出；复制的内容保留原字符',
    invisible: '含不可见字符',
    copyCode: '复制代码',
    copied: '已复制',
    copy: '复制',
    foldedLines: (count: number) => `前 ${count} 行已收起`,
    namedCode: (language: string) => `${language} 代码`,
    codeContent: '代码内容',
    collapse: '收起代码',
    expand: (count: number) => `展开全部 ${count} 行`,
    copiedStatus: '代码已复制到剪贴板',
    copyFailed: '复制失败，请选中代码手动复制，或重试。',
    image: '图片',
    externalImage: '外部图片：',
    imagePrefix: '图片：',
    table: '表格，可横向滚动',
    footnotes: '注释',
    plainText: '结构过深，按纯文本显示',
  },
  {
    code: 'Code',
    invisibleTip: 'Shown as \\u{…}. Copies keep the original characters',
    invisible: 'Has invisible characters',
    copyCode: 'Copy code',
    copied: 'Copied',
    copy: 'Copy',
    foldedLines: (count: number) => plural(count, { one: 'First {n} line collapsed', other: 'First {n} lines collapsed' }),
    namedCode: (language: string) => `${language} code`,
    codeContent: 'Code',
    collapse: 'Collapse code',
    expand: (count: number) => `Show all ${count} lines`,
    copiedStatus: 'Code copied to the clipboard',
    copyFailed: 'Couldn’t copy. Select the code and copy it by hand, or try again.',
    image: 'Image',
    externalImage: 'External image: ',
    imagePrefix: 'Image: ',
    table: 'Table, scrolls sideways',
    footnotes: 'Footnotes',
    plainText: 'Nested too deep, shown as plain text',
  },
)

export interface MarkdownFiles {
  path?: string
  onOpenFile?: (reference: string) => void
  resolveImage?: (reference: string, signal: AbortSignal) => Promise<{ url: string; width?: number; height?: number }>
  /** A reference as a picture, video or sound the Host authorized; a reply's files have it, a document's do not. */
  resolveMedia?: (reference: string, signal: AbortSignal) => Promise<ResolvedMedia>
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
  position?: { start: { offset?: number }; end: { offset?: number } }
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

const REASONING_NODES = new Set(['root', 'paragraph', 'text', 'strong', 'emphasis', 'inlineCode', 'list', 'listItem', 'break'])

/**
 * Reasoning is drawn with paragraphs, lists, emphasis and inline code, and a fenced shell block as a code block, so its
 * command can be copied or typed in at a prompt (never run). Anything else Markdown would make of it (a link, an image,
 * a heading, a quote, other code blocks, HTML) reads as the characters it was written with: nothing in a thought
 * navigates, loads or runs. Runs after `limitDepth`, which bounds this walk.
 */
function reasoningOnly() {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    const source = String(file.value)
    const walk = (parent: MarkdownNode) => {
      if (!parent.children) return
      parent.children = parent.children.map(node => {
        if (REASONING_NODES.has(node.type)) {
          walk(node)
          return node
        }
        if (node.type === 'code' && BLOCK_PARENTS.has(parent.type) && isShellLanguage(node.lang ?? undefined)) return node
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        const written: MarkdownNode = { type: 'text', value: start === undefined || end === undefined ? '' : source.slice(start, end) }
        return BLOCK_PARENTS.has(parent.type) ? { type: 'paragraph', children: [written] } : written
      })
    }
    walk(tree)
  }
}

const markdownGuards = [restrictInlineMath, limitDepth]
const remarkPlugins = [remarkGfm, remarkMath, ...markdownGuards]
// No GFM and no math: a table, an address or a formula in a thought stays the text it is.
const reasoningPlugins = [limitDepth, reasoningOnly]
const REASONING_ELEMENTS = ['p', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'br']
const replyPlugins = [...remarkPlugins, literalHtml]
const replyPluginsWithoutMath = [remarkGfm, ...markdownGuards, literalHtml]
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

/** Direct replies share the transcript's scrollport. Other Markdown surfaces find their own. */
export const ReplyViewport = createContext<RefObject<Element | null> | undefined>(undefined)
/** A picture the turn's Harness generated, as its stored copy measures: bytes and pixels. */
export interface TurnPicture {
  size: number
  width?: number
  height?: number
}
/**
 * The pictures the reply's turn already shows as generated: a link or `![](…)` in the reply to the same file (the same
 * bytes and pixels, as the Host measures it) is that picture's 「下载原图」, and is not shown a second time.
 */
export const TurnPictured = createContext<readonly TurnPicture[]>([])
function samePicture(media: ResolvedMedia, picture: TurnPicture): boolean {
  return (
    media.kind === 'image'
    && media.size === picture.size
    && (picture.width === undefined || media.width === picture.width)
    && (picture.height === undefined || media.height === picture.height)
  )
}

const CodeBlock = memo(function CodeBlock({ code, language, closed = true }: { code: string; language?: string; closed?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [copyResult, setCopyResult] = useState<CopyResult>(null)
  const [copying, setCopying] = useState(false)
  const codeId = useId()
  const pre = useRef<HTMLPreElement>(null)
  const viewport = useContext(ReplyViewport)
  const seen = useSeen(pre, viewport)
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
        <span className="message-code-language">{language || COPY.code}</span>
        {hidden && (
          <span className="message-code-hidden" title={COPY.invisibleTip}>
            {COPY.invisible}
          </span>
        )}
        {isShellLanguage(language) && <TerminalFillButton command={code} streaming={!closed} look="code" />}
        <button
          type="button"
          className="message-code-copy"
          onClick={() => void copy()}
          disabled={copying || !code}
          aria-label={COPY.copyCode}
          title={copied ? COPY.copied : COPY.copy}>
          {copied ? (
            <CheckGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          ) : (
            <CopyGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          )}
        </button>
      </div>
      {tail && <p className="message-code-tail-note">{COPY.foldedLines(lines - TAIL_LINES)}</p>}
      <pre ref={pre} id={codeId} tabIndex={0} aria-label={language ? COPY.namedCode(language) : COPY.codeContent}>
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
          {expanded ? COPY.collapse : COPY.expand(lines)}
          {expanded ? (
            <ChevronUpGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          ) : (
            <ChevronDownGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          )}
        </button>
      )}
      <span className="message-copy-status" role="status" aria-live="polite">
        {copied ? COPY.copiedStatus : ''}
      </span>
      {failed && (
        <p className="message-copy-error" role="alert">
          {COPY.copyFailed}
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
  const delimited = start !== undefined && end !== undefined && codeClosed(source, start, end)
  const closed = settled || delimited
  if (language === 'mermaid' && delimited && renderFrame) return <Diagram key={code} source={code} renderFrame={renderFrame} />
  return <CodeBlock code={code} language={language} closed={closed} />
}

function ClosedMath({ code, start, end }: { code: string; start?: number; end?: number }) {
  const source = useContext(SourceText)
  const block = start === undefined || end === undefined ? '' : source.slice(start, end)
  const marker = /^\${2,}/u.exec(block)?.[0]
  const ending = /\n[^\S\n]*(?:>[^\S\n]*)*(\${2,})[^\S\n]*$/u.exec(block.trimEnd())?.[1]
  const closed = marker !== undefined && ending !== undefined && ending.length >= marker.length
  return closed ? <MathFormula tex={code.trimEnd()} block /> : <CodeBlock code={code} language="math" closed={false} />
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
/**
 * A local file a reply or document names. `![](…)` and a link (`fallback` given: a reply's path chip) draw the picture,
 * video or sound it names once the reply settled and the place nears the view, from a handle the Host authorized: a
 * picture alone, a video or sound above its chip. What the Host does not authorize as media stays the chip or link it
 * was. A picture the turn already shows as generated is not shown again; until that is known, a link to a picture in
 * such a turn holds no chip, so none appears and goes.
 */
function MarkdownFile({
  reference,
  children,
  image = false,
  alt,
  fallback,
}: {
  reference: string
  children?: ReactNode
  image?: boolean
  alt?: string
  fallback?: ReactNode
}) {
  const files = useContext(MarkdownFileContext),
    settled = useContext(ReplySettled),
    path = relativeFile(reference, files.path),
    anchor = useRef<HTMLSpanElement>(null),
    [value, setValue] = useState<{ key: string; media: ResolvedMedia }>(),
    // The Host answered and there is nothing to draw: the chip or link stays.
    [plainKey, setPlainKey] = useState<string>(),
    [failed, setFailed] = useState<string>(),
    // A handle idles out (15 minutes): the first failure asks the Host once more and resumes where playback stood.
    [retry, setRetry] = useState<{ key: string; at?: number }>()
  const resolve = useMemo(
    () =>
      files.resolveMedia
      ?? (image && files.resolveImage
        ? (target: string, signal: AbortSignal) => files.resolveImage!(target, signal).then(found => ({ kind: 'image' as const, ...found }))
        : undefined),
    [files.resolveMedia, files.resolveImage, image],
  )
  const pictured = useContext(TurnPictured)
  const linked = fallback !== undefined && path ? mediaTypeOf(path) : undefined
  const wanted = !!path && !!resolve && (image || linked !== undefined)
  const seen = useSeen(anchor)
  // A new resolver is a new session or root: what an older one answered is not shown for it.
  const key = `${path ?? ''}\n${image}`
  const ready = wanted && settled && seen
  useEffect(() => {
    if (!ready || !path || !resolve) return
    const controller = new AbortController()
    void resolve(path, controller.signal)
      .then(media => {
        if (controller.signal.aborted) return
        if (drawableMedia(media, location.href)) setValue({ key, media })
        else setPlainKey(key)
      })
      .catch(() => {
        if (!controller.signal.aborted) setPlainKey(key)
      })
    return () => {
      controller.abort()
      setValue(undefined)
    }
  }, [ready, path, key, resolve, retry])
  const shown = value?.key === key && failed !== key ? value.media : undefined
  if (shown && pictured.some(picture => samePicture(shown, picture))) return null
  if (path && shown) {
    const label = alt || (typeof children === 'string' ? children : '') || referenceName(path)
    const media = (
      <InlineMedia
        media={shown}
        label={label}
        onFail={at => (retry?.key === key ? setFailed(key) : setRetry({ key, ...(at ? { at } : {}) }))}
        {...(retry?.key === key && retry.at ? { startAt: retry.at } : {})}
        {...(files.onOpenFile && shown.kind === 'image' ? { openInFiles: () => files.onOpenFile?.(path) } : {})}
      />
    )
    if (image || shown.kind === 'image') return media
    return (
      <span className="message-media" data-kind={shown.kind}>
        {media}
        <span className="message-media-caption">{fallback}</span>
      </span>
    )
  }
  const plain =
    fallback !== undefined ? (
      fallback
    ) : (
      <MarkdownFileLink reference={reference} path={path} image={image} alt={alt}>
        {children}
      </MarkdownFileLink>
    )
  // In a turn with a generated picture, a link to a picture waits unseen for the Host's answer instead of showing a chip
  // that may then go.
  const holding = wanted && pictured.length > 0 && (image || linked === 'image') && plainKey !== key && failed !== key
  return wanted ? <span ref={anchor}>{holding ? null : plain}</span> : plain
}

function MarkdownFileLink({
  reference,
  path,
  children,
  image,
  alt,
}: {
  reference: string
  path: string | undefined
  children?: ReactNode
  image: boolean
  alt?: string | undefined
}) {
  const files = useContext(MarkdownFileContext)
  if (path && files.onOpenFile)
    return (
      <button type="button" className="message-local-link" onClick={() => files.onOpenFile?.(path)}>
        <ReplyFileIcon path={path} />
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
    const label = alt?.trim() || COPY.image
    if (src && /^https?:/i.test(src))
      return (
        <a className="message-image" href={src} target="_blank" rel="noopener noreferrer">
          {COPY.externalImage}
          {label}
        </a>
      )
    const path = src ? referenceText(src) : undefined
    return path ? (
      <MarkdownFile reference={path} image {...(alt?.trim() ? { alt: alt.trim() } : {})} />
    ) : (
      <span className="message-image">
        {COPY.imagePrefix}
        {label}
      </span>
    )
  },
  pre({ node, children }) {
    const codeNode = node?.children.find(child => child.type === 'element' && child.tagName === 'code')
    if (codeNode?.type !== 'element') return <pre>{children}</pre>
    const code = codeNode.children.map(child => (child.type === 'text' ? child.value : '')).join('')
    const classNames = Array.isArray(codeNode.properties.className) ? codeNode.properties.className.join(' ') : ''
    const language = /(?:^|\s)language-([a-z\d_+#.-]{1,32})(?=[\s,]|$)/i.exec(classNames)?.[1]
    if (classNames.includes('math-display'))
      return <ClosedMath code={code} start={node?.position?.start.offset} end={node?.position?.end.offset} />
    return <ClosedCode code={code} language={language} start={node?.position?.start.offset} end={node?.position?.end.offset} />
  },
  table({ node: _node, ...props }) {
    return (
      <div className="message-table-scroll" tabIndex={0} role="region" aria-label={COPY.table}>
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
  useLocale()
  const id = useId()
  const session = useContext(FileSession),
    rootId = useContext(FileRootContext),
    openFile = useContext(FileOpenContext)
  const inherited = useMemo<MarkdownFiles>(
    () =>
      openFile && session
        ? {
            onOpenFile: reference => openFile({ sessionId: session.id, reference, ...(rootId ? { rootId } : {}) }),
            resolveMedia: (reference, signal) => resolveFileMedia(session.id, reference, rootId, signal),
          }
        : {},
    [openFile, session?.id, rootId],
  )
  const effectiveOpenFile = onOpenFile ?? inherited.onOpenFile
  // A document given its own image resolver draws only its pictures, as before; a reply draws any media it names.
  const effectiveImage = resolveImage ?? inherited.resolveImage
  const effectiveMedia = resolveImage ? undefined : inherited.resolveMedia
  const normalized = useMemo(() => normalizeMathDelimiters(text), [text])
  // Footnote ids must be unique across messages in the same conversation.
  const footnoteLabel = COPY.footnotes
  const remarkRehypeOptions = useMemo(() => ({ clobberPrefix: `${id}-`, footnoteLabel }), [id, footnoteLabel])
  const messageComponents = useMemo<Components>(
    () => ({
      ...components,
      // Only web and mail addresses are links, and footnotes of this reply; a file reference is a path chip that never
      // navigates the page, and anything else is its text.
      a({ node, children, href, 'aria-describedby': describedBy, ...props }) {
        if (!href) return <span>{children}</span>
        const target = linkTarget(href, `${id}-`)
        if (target.kind === 'text') return <span>{children}</span>
        // An explicit link owns the click, including when its label contains a known filename in backticks.
        const label = children == null ? children : <KnownFilesContext.Provider value={null}>{children}</KnownFilesContext.Provider>
        if (target.kind === 'path') {
          if (onOpenFile) return <MarkdownFile reference={target.path}>{label}</MarkdownFile>
          const linkText = textOf(node).trim()
          // A label that is the path itself is drawn from its text, so its folders can give way to the file name.
          const chip = !linkText ? (
            <FileChip path={target.path} />
          ) : namesPath(linkText, target.path) ? (
            <FileChip path={target.path} label={linkText} />
          ) : (
            <FileChip path={target.path} label={label} mono={false} />
          )
          // A picture, video or sound the reply links to is drawn above its chip once the Host authorizes it.
          return mediaTypeOf(target.path) ? (
            <MarkdownFile reference={target.path} fallback={chip} {...(linkText ? { alt: linkText } : {})} />
          ) : (
            chip
          )
        }
        const external = target.kind === 'web'
        return (
          <a
            {...props}
            href={href}
            aria-describedby={describedBy === 'footnote-label' ? `${id}-footnote-label` : describedBy}
            target={external ? '_blank' : undefined}
            rel={external ? 'noopener noreferrer' : undefined}>
            {label}
          </a>
        )
      },
      h2({ node: _node, id: headingId, ...props }) {
        return <h2 {...props} id={headingId === 'footnote-label' ? `${id}-footnote-label` : headingId} />
      },
    }),
    [id, onOpenFile],
  )

  const renderer = useMemo(
    () =>
      createStreamingMarkdown(
        source => {
          // Math constructs start on a dollar sign, including TeX delimiters already converted during normalization.
          const plugins = path !== undefined ? remarkPlugins : source.includes('$') ? replyPlugins : replyPluginsWithoutMath
          return renderMarkdown({
            children: source,
            // A file's preview renders the document and has its source a press away; a reply has no other copy of its words.
            remarkPlugins: plugins,
            remarkRehypeOptions,
            components: messageComponents,
            urlTransform: safeUrl,
            skipHtml: true,
          })
        },
        (source, child, index) => (
          <SourceText.Provider key={index} value={source}>
            {isValidElement(child) ? cloneElement(child, { key: 'content' }) : child}
          </SourceText.Provider>
        ),
      ),
    [path, remarkRehypeOptions, messageComponents],
  )
  const rendered = useMemo(
    () => (exceedsMarkdownNesting(normalized) ? null : renderer(normalized, streaming && path === undefined)),
    [normalized, streaming, path, renderer],
  )
  const files = useMemo(
    () => ({ path, onOpenFile: effectiveOpenFile, resolveImage: effectiveImage, resolveMedia: effectiveMedia }),
    [path, effectiveOpenFile, effectiveImage, effectiveMedia],
  )
  const plain = <PlainText text={text} />
  const content = (
    <div className="message-content" aria-busy={streaming || undefined}>
      {rendered === null ? (
        plain
      ) : (
        <ErrorBoundary resetKey={text} fallback={plain}>
          <ReplySettled.Provider value={!streaming}>
            <FrameRenderer.Provider value={renderFrame ?? (openFile && session ? renderDocumentFrame : undefined)}>
              <MarkdownFileContext.Provider value={files}>{rendered}</MarkdownFileContext.Provider>
            </FrameRenderer.Provider>
          </ReplySettled.Provider>
        </ErrorBoundary>
      )}
    </div>
  )
  // A file's preview is a document, not a reply: its code blocks are never typed into a terminal.
  return path === undefined ? content : <FillPlace.Provider value={undefined}>{content}</FillPlace.Provider>
})

const reasoningComponents: Components = { pre: components.pre }
const renderReasoning = (source: string) =>
  renderMarkdown({
    children: source,
    remarkPlugins: reasoningPlugins,
    allowedElements: REASONING_ELEMENTS,
    components: reasoningComponents,
    unwrapDisallowed: true,
    urlTransform: safeUrl,
    skipHtml: true,
  })
const reasoningChild = (source: string, child: ReactNode, index: number) => (
  <SourceText.Provider key={index} value={source}>
    {isValidElement(child) ? cloneElement(child, { key: 'content' }) : child}
  </SourceText.Provider>
)

/**
 * A stretch of reported reasoning: the reply's Markdown pipeline (the same parser, depth limit, URL rule and, while it
 * arrives, the same block reuse and display-only closing of unfinished marks) restricted to paragraphs, lists,
 * emphasis and inline code. Text with hidden characters, or that nests too deeply, is shown plain with every
 * character visible.
 */
export const ReasoningContent = memo(function ReasoningContent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const renderer = useMemo(() => createStreamingMarkdown(renderReasoning, reasoningChild), [])
  const rendered = useMemo(
    () => (hasHiddenCharacters(text) || exceedsMarkdownNesting(text) ? null : renderer(text, streaming)),
    [text, streaming, renderer],
  )
  if (rendered === null)
    return (
      <p className="reasoning-text">
        <VisibleText text={text} />
      </p>
    )
  return (
    <div className="reasoning-content">
      <ReplySettled.Provider value={!streaming}>{rendered}</ReplySettled.Provider>
    </div>
  )
})

/** Read when shown, so it follows the page's language. */
export const plainTextNote = (): string => COPY.plainText

function PlainText({ text }: { text: string }) {
  return (
    <>
      <p className="message-plain-note">{plainTextNote()}</p>
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
