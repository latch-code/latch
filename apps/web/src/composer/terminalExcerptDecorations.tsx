import { StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import { createRoot } from 'react-dom/client'
import { isolateHistory } from '@codemirror/commands'
import { X } from 'lucide-react'
import { Icon, TerminalGlyph } from '@latch/ui'
import { defineCopy } from '../core/i18n.ts'
import { terminalExcerpts } from './terminalExcerpt.ts'

class TerminalMark extends WidgetType {
  toDOM(): HTMLElement {
    const mark = document.createElement('span')
    mark.className = 'terminal-excerpt-icon'
    mark.setAttribute('aria-hidden', 'true')
    const root = createRoot(mark)
    root.render(<Icon icon={TerminalGlyph} size={14} />)
    this.roots.set(mark, root)
    return mark
  }

  private readonly roots = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>()

  override destroy(mark: HTMLElement) {
    const root = this.roots.get(mark)
    if (root) queueMicrotask(() => root.unmount())
  }
}

const terminalMark = Decoration.widget({ widget: new TerminalMark(), side: -1 })
const COPY = defineCopy({ remove: '移除终端引用' }, { remove: 'Remove terminal excerpt' })

class RemoveExcerpt extends WidgetType {
  private readonly roots = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>()

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'terminal-excerpt-remove'
    button.title = COPY.remove
    button.setAttribute('aria-label', COPY.remove)
    const root = createRoot(button)
    root.render(<Icon icon={X} size={14} />)
    this.roots.set(button, root)
    button.onmousedown = event => event.preventDefault()
    button.onclick = event => {
      event.preventDefault()
      if (view.state.readOnly || !view.contentDOM.contains(button)) return
      // Resolve the current heading, including when identical excerpts have moved after an edit.
      const line = view.state.doc.lineAt(view.posAtDOM(button))
      const block = view.state.field(terminalExcerptField).excerpts.find(item => item.from === line.from)
      if (!block) return
      const end = block.to < view.state.doc.length ? block.to + 1 : block.to
      view.dispatch({
        changes: { from: block.from, to: end },
        selection: { anchor: block.from },
        userEvent: 'delete',
        annotations: isolateHistory.of('full'),
      })
      view.focus()
    }
    return button
  }

  override destroy(button: HTMLElement) {
    const root = this.roots.get(button)
    if (root) queueMicrotask(() => root.unmount())
  }
}

const removeExcerpt = Decoration.widget({ widget: new RemoveExcerpt(), side: -1 })
const hideFence = Decoration.replace({})

function decorate(doc: EditorState['doc']) {
  const excerpts = terminalExcerpts(doc.toString())
  const lines: Range<Decoration>[] = []
  const fences: Range<Decoration>[] = []
  for (const { from, to, notes } of excerpts) {
    const header = doc.lineAt(from)
    const opening = doc.line(header.number + 1)
    const last = doc.line(doc.lineAt(to).number - 1)
    lines.push(
      Decoration.line({ class: 'terminal-excerpt terminal-excerpt-heading' }).range(from),
      terminalMark.range(from),
      removeExcerpt.range(header.to),
    )
    if (notes) lines.push(Decoration.mark({ class: 'terminal-excerpt-note' }).range(header.to - notes.length, header.to))
    // Hide the opening fence alongside the title and the closing fence alongside the last line of output.
    fences.push(hideFence.range(header.to, opening.to), hideFence.range(last.to, to))
    for (let n = opening.number + 1; n <= last.number; n++) {
      const line = doc.line(n)
      const classes = ['terminal-excerpt', 'terminal-excerpt-body']
      if (/^\s/u.test(line.text)) classes.push('terminal-excerpt-detail')
      if (n === last.number) classes.push('terminal-excerpt-end')
      lines.push(Decoration.line({ class: classes.join(' ') }).range(line.from))
    }
  }
  return { excerpts, lines: Decoration.set(lines, true), fences: Decoration.set(fences) }
}

/** Only delimiters are atomic. Native selection, typing and undo continue to work on the diagnostic itself. */
export const terminalExcerptField = StateField.define({
  create: state => decorate(state.doc),
  update: (value, transaction) => (transaction.docChanged ? decorate(transaction.newDoc) : value),
  provide: field => [
    EditorView.decorations.from(field, value => value.lines),
    EditorView.decorations.from(field, value => value.fences),
    EditorView.atomicRanges.of(view => view.state.field(field).fences),
  ],
})
