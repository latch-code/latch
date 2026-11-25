import type { Text } from '@codemirror/state'
import { defineCopy } from '../core/i18n.ts'
import { quoteHeading } from './quotedExcerpt.ts'

const COPY = defineCopy(
  { handoff: '交回结果', board: '待办回复', side: '旁支回答', carried: '上次成果' },
  { handoff: 'Returned result', board: 'Work item reply', side: 'Side answer', carried: 'Previous result' },
)
type Kind = 'console' | 'network' | 'element' | 'hook' | 'check' | 'comment' | 'file' | 'handoff' | 'board' | 'side' | 'carried'
export interface Heading {
  kind: Kind
  text: string
  filePath?: string
  tip?: string
}

/** These titles are emitted by the insertion actions. An ordinary Markdown fence or blockquote stays editable prose. */
function heading(line: string): Heading | undefined {
  if (line === quoteHeading.handoff) return { kind: 'handoff', text: COPY.handoff }
  if (line === quoteHeading.board) return { kind: 'board', text: COPY.board }
  if (line === quoteHeading.side) return { kind: 'side', text: COPY.side }
  if (line.startsWith('> 上次成果「') && line.endsWith('」：')) return { kind: 'carried', text: COPY.carried + ' · ' + line.slice(7, -2) }
  if (line.startsWith('[引用 ') && line.endsWith(']') && line.includes(' · ')) {
    const source = line.slice(4, -1)
    const separator = source.indexOf(' · ')
    const filePath = source.slice(0, separator).replace(/^@[^:]+:/u, '')
    return { kind: 'file', text: filePath + source.slice(separator), filePath, tip: source }
  }
  if (line.endsWith('（页面提供的内容）')) {
    if (line.startsWith('浏览器控制台 · ')) return { kind: 'console', text: line }
    if (line.startsWith('浏览器网络 · ')) return { kind: 'network', text: line }
    if (line.startsWith('元素 · ')) return { kind: 'element', text: line }
  }
  if (/^(?:提交钩子 .+，没有生成提交|推送前的钩子 .+，没有推送)：$/u.test(line)) return { kind: 'hook', text: line.slice(0, -1) }
  if (/^PR #\d+ 的检查 .+ 失败(?:（[^）]+）)?：?$/u.test(line)) return { kind: 'check', text: line.replace(/：$/u, '') }
  if (/^PR #\d+ · .+ · .+：$/u.test(line)) return { kind: 'comment', text: line.slice(0, -1) }
  return undefined
}

const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/u
const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u

interface SourceExcerpt {
  from: number
  to: number
  firstLine: number
  lastLine: number
  format: 'quoted' | 'fenced' | 'title'
  title: Heading
}

/** Source ranges serve both the renderer and the decision about whom a message goes to. */
export function readReferenceExcerpts(doc: Text) {
  const excerpts: SourceExcerpt[] = []
  const literal: { from: number; to: number }[] = []
  let fence = '',
    fenceStart = 0
  for (let index = 1; index <= doc.lines; index++) {
    const line = doc.line(index)
    if (fence) {
      if (closer.exec(line.text)?.[1]?.startsWith(fence)) {
        literal.push({ from: fenceStart, to: line.to })
        fence = ''
      }
      continue
    }
    const open = opener.exec(line.text)
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      fence = open[1]!
      fenceStart = line.from
      continue
    }
    if (/^ {0,3}>/u.test(line.text)) literal.push({ from: line.from, to: line.to })
    const title = heading(line.text)
    if (!title) continue
    // A carried result starts after a blank line. The same words can occur inside a quoted reply.
    if (title.kind === 'carried' && index > 1 && doc.line(index - 1).text.trim()) continue
    const isQuote = ['file', 'handoff', 'board', 'side', 'carried'].includes(title.kind)
    let end = index
    let format: SourceExcerpt['format'] = 'title'
    if (isQuote) {
      format = 'quoted'
      while (end < doc.lines && /^>(?: |$)/u.test(doc.line(end + 1).text)) end++
      if (end === index) continue
      if (title.kind === 'file') {
        if (end >= doc.lines || !/^（引用时文件：\d+ bytes，更新于 .+）$/u.test(doc.line(end + 1).text)) continue
        end++
      }
    } else if (title.kind !== 'check' || line.text.endsWith('：')) {
      if (index + 3 > doc.lines || doc.line(index + 1).text !== '') continue
      const opening = doc.line(index + 2)
      const delimiter = /^(`{3,})text$/u.exec(opening.text)?.[1]
      if (!delimiter) continue
      let close = index + 3
      while (close <= doc.lines && !doc.line(close).text.includes(delimiter)) close++
      if (close <= index + 3 || close > doc.lines || doc.line(close).text !== delimiter) continue
      end = close
      format = 'fenced'
    }
    const excerpt = { from: line.from, to: doc.line(end).to, firstLine: index, lastLine: end, format, title }
    excerpts.push(excerpt)
    literal.push(excerpt)
    index = end
  }
  if (fence) literal.push({ from: fenceStart, to: doc.length })
  return { excerpts, literal }
}
