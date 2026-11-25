import { StateField, type Text, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import { createRoot, type Root } from 'react-dom/client'
import {
  ArrowLeftRight,
  FileText,
  GitPullRequest,
  History,
  ListChecks,
  MessagesSquare,
  MousePointer2,
  Network,
  NotebookText,
  SquareTerminal,
  Workflow,
} from 'lucide-react'
import { Icon } from '@latch/ui'
import { escapeSecurityText } from '@latch/protocol'
import { currentLocale } from '../core/i18n.ts'
import { referenceIcon } from '../fileReference.ts'
import { readReferenceExcerpts, type Heading } from './referenceExcerpts.ts'

const icons = {
  console: SquareTerminal,
  network: Network,
  element: MousePointer2,
  hook: Workflow,
  check: ListChecks,
  comment: GitPullRequest,
  file: FileText,
  handoff: ArrowLeftRight,
  board: NotebookText,
  side: MessagesSquare,
  carried: History,
}
const headingIcons = new WeakMap<HTMLElement, Root>()

class ReferenceHeading extends WidgetType {
  constructor(readonly value: Heading) {
    super()
  }
  override eq(other: ReferenceHeading) {
    return this.value.kind === other.value.kind && this.value.text === other.value.text && this.value.tip === other.value.tip
  }
  toDOM() {
    const label = document.createElement('span')
    label.className = 'reference-excerpt-heading'
    if (this.value.tip) label.title = escapeSecurityText(this.value.tip)
    const icon = document.createElement('span')
    icon.setAttribute('aria-hidden', 'true')
    const root = createRoot(icon)
    root.render(<Icon icon={this.value.filePath ? referenceIcon(this.value.filePath) : icons[this.value.kind]} size={14} />)
    headingIcons.set(label, root)
    label.append(icon, escapeSecurityText(this.value.text))
    return label
  }
  override destroy(dom: HTMLElement) {
    const root = headingIcons.get(dom)
    headingIcons.delete(dom)
    if (root) queueMicrotask(() => root.unmount())
  }
}

const conceal = Decoration.replace({})
function excerptDecorations(doc: Text) {
  const ranges: Range<Decoration>[] = [],
    atoms: Range<Decoration>[] = []
  const { excerpts, literal } = readReferenceExcerpts(doc)
  for (const { firstLine: index, lastLine: end, format, title } of excerpts) {
    const line = doc.line(index)
    if (format === 'quoted') {
      for (let n = index + 1; n <= end; n++) {
        const body = doc.line(n)
        if (title.kind === 'file' && n === end) {
          ranges.push(Decoration.line({ class: 'reference-excerpt-stamp' }).range(body.from))
        } else {
          atoms.push(conceal.range(body.from, body.from + (body.text === '>' ? 1 : 2)))
          ranges.push(Decoration.line({ class: 'reference-excerpt-body' }).range(body.from))
        }
      }
    } else if (format === 'fenced') {
      const opening = doc.line(index + 2),
        close = end
      atoms.push(conceal.range(line.to, opening.to), conceal.range(doc.line(close - 1).to, doc.line(close).to))
      for (let n = index + 3; n < end; n++) {
        ranges.push(
          Decoration.line({ class: title.kind === 'comment' ? 'reference-excerpt-body' : 'reference-excerpt-log' }).range(doc.line(n).from),
        )
      }
    }
    atoms.push(Decoration.replace({ widget: new ReferenceHeading(title) }).range(line.from, line.to))
    ranges.push(Decoration.line({ class: 'reference-excerpt-title', attributes: { 'data-source': title.kind } }).range(line.from))
  }
  return { excerpts, literal, ranges: Decoration.set(ranges, true), atoms: Decoration.set(atoms, true), locale: currentLocale() }
}

export const referenceExcerptField = StateField.define({
  create: state => excerptDecorations(state.doc),
  update: (value, transaction) =>
    transaction.docChanged || value.locale !== currentLocale() ? excerptDecorations(transaction.newDoc) : value,
  provide: field => [
    EditorView.decorations.from(field, value => value.ranges),
    EditorView.decorations.from(field, value => value.atoms),
    EditorView.atomicRanges.of(view => view.state.field(field).atoms),
  ],
})
