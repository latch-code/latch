import { escapeSecurityText, type FileMetadata } from '@latch/protocol'

export interface PreviewQuote {
  text: string
  page?: number
  cells?: { sheet: string; start: [number, number]; end: [number, number] }
}
export interface FileQuote {
  contextKey: string
  file: Pick<FileMetadata, 'root' | 'path' | 'name' | 'source' | 'size' | 'mtime' | 'etag'>
  excerpt: PreviewQuote
}
export const QUOTE_LIMIT = 2000
export function boundedQuoteText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim()
    .slice(0, QUOTE_LIMIT)
    .replace(/[\uD800-\uDBFF]$/u, '')
}
export function columnLabel(index: number): string {
  let n = index + 1,
    label = ''
  while (n > 0) {
    n--
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26)
  }
  return label
}
/** A textual excerpt is editable input, never an instruction or a grant to read another file. */
export function quoteDraft(value: FileQuote, reference?: string): { text: string; marker: string } {
  const { file, excerpt } = value
  const location = excerpt.cells
    ? escapeSecurityText(excerpt.cells.sheet)
      + '!'
      + columnLabel(excerpt.cells.start[1])
      + (excerpt.cells.start[0] + 1)
      + ':'
      + columnLabel(excerpt.cells.end[1])
      + (excerpt.cells.end[0] + 1)
    : excerpt.page === undefined
      ? '选中内容'
      : '第 ' + (excerpt.page + 1) + ' 页'
  const marker = '[引用 ' + (reference ?? escapeSecurityText(file.name)) + ' · ' + location + ']'
  const time = Number.isFinite(file.mtime) && Math.abs(file.mtime) <= 8.64e15 ? new Date(file.mtime).toISOString() : '时间未知'
  return {
    marker,
    text:
      marker
      + '\n'
      + boundedQuoteText(excerpt.text)
        .split('\n')
        .map(line => '> ' + line)
        .join('\n')
      + '\n（引用时文件：'
      + file.size
      + ' bytes，更新于 '
      + time
      + '）\n',
  }
}
/** Both endpoints must be in this preview; selection in a chat or another file is never reused. */
export function selectedQuote(container: HTMLElement | null): PreviewQuote | undefined {
  const selected = window.getSelection()
  if (
    !container
    || !selected?.rangeCount
    || !selected.anchorNode
    || !selected.focusNode
    || !container.contains(selected.anchorNode)
    || !container.contains(selected.focusNode)
  )
    return
  const range = selected.getRangeAt(0),
    fragment = range.cloneContents()
  fragment.querySelectorAll('[aria-hidden="true"],button,input,select,script,style').forEach(node => node.remove())
  const text = boundedQuoteText(fragment.textContent ?? '')
  if (!text) return
  const element = selected.anchorNode instanceof Element ? selected.anchorNode : selected.anchorNode.parentElement
  const index = element?.closest<HTMLElement>('.pdf-page-slot')?.dataset.index
  return { text, ...(index !== undefined && /^\d{1,4}$/u.test(index) ? { page: Number(index) } : {}) }
}
