import { useLayoutEffect, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { BookOpen, Users } from 'lucide-react'
import { CodeGlyph, Icon } from '@latch/ui'
import { escapeSecurityText } from '@latch/protocol'
import { markBeforeCaret, promptMarks, type PromptCatalogue, type PromptMark } from './prompt-tokens.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    skill: '技能 · ',
    command: '命令 · ',
    member: '成员 · ',
  },
  {
    skill: 'Skill · ',
    command: 'Command · ',
    member: 'Member · ',
  },
)

/** What the mirror copies from the input, so its lines break where the input's do on every surface and at every zoom. */
const METRICS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontStretch',
  'fontFeatureSettings',
  'fontVariationSettings',
  'fontKerning',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
  'textIndent',
  'textTransform',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
] as const

/**
 * Lays the mirror exactly over the input: the same box, the same type, the same padding plus the width of a classic
 * scroll bar on the input (the mirror has none), and the same scroll offset.
 */
function alignMirror(input: HTMLTextAreaElement, mirror: HTMLElement) {
  const style = getComputedStyle(input)
  for (const key of METRICS) mirror.style[key] = style[key]
  const gutter = input.offsetWidth - input.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
  mirror.style.paddingRight = `calc(${style.paddingRight} + ${Math.max(0, gutter)}px)`
  mirror.style.borderStyle = 'solid'
  mirror.style.borderColor = 'transparent'
  mirror.style.borderWidth = style.borderWidth
  mirror.style.top = `${input.offsetTop}px`
  mirror.style.left = `${input.offsetLeft}px`
  mirror.style.width = `${input.offsetWidth}px`
  mirror.style.height = input.style.height || `${input.offsetHeight}px`
  mirror.scrollTop = input.scrollTop
}

/**
 * Skill and command tokens of the draft drawn as marks. The draft stays text: the input keeps its own value, caret,
 * selection, undo and IME, and only its ink is hidden while a mark is shown; a mirror under it paints the same text with
 * the same metrics, the marks in link blue on a tint, each sigil (`$`, `/`) painted over by the glyph the slash menu uses
 * for that kind, so no glyph changes width. Composition shows the input's own text until it ends.
 */
export function usePromptMarks({
  draft,
  catalogue,
  textareaRef,
  mirrorRef,
}: {
  draft: string
  catalogue: PromptCatalogue
  textareaRef: RefObject<HTMLTextAreaElement | null>
  mirrorRef: RefObject<HTMLDivElement | null>
}) {
  const { commands, skills, actions, members } = catalogue
  const marks = useMemo(() => promptMarks(draft, { commands, skills, actions, members }), [draft, commands, skills, actions, members])
  const [composing, setComposing] = useState(false)
  const shown = marks.length > 0 && !composing
  useLayoutEffect(() => {
    const input = textareaRef.current
    const mirror = mirrorRef.current
    if (!input || !mirror) return undefined
    const align = () => alignMirror(input, mirror)
    align()
    const observer = new ResizeObserver(align)
    observer.observe(input)
    return () => observer.disconnect()
  })
  return {
    marks,
    shown,
    keydown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (event.key !== 'Backspace' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
      const input = event.currentTarget
      const mark = markBeforeCaret(marks, input.selectionStart, input.selectionEnd)
      if (!mark) return false
      event.preventDefault()
      deleteText(input, mark.start, mark.end)
      return true
    },
    inputProps: {
      onCompositionStart: () => setComposing(true),
      onCompositionEnd: () => setComposing(false),
      onMouseMove: (event: MouseEvent<HTMLTextAreaElement>) => {
        const tip = shown ? markTip(mirrorRef.current, marks, event.clientX, event.clientY) : ''
        if (event.currentTarget.title !== tip) event.currentTarget.title = tip
      },
    },
  }
}

/** A native edit, so one undo brings the whole token back. */
export function deleteText(input: HTMLTextAreaElement, start: number, end: number) {
  input.focus({ preventScroll: true })
  input.setSelectionRange(start, end)
  if (document.execCommand('delete')) return
  input.setRangeText('', start, end, 'end')
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function markTip(mirror: HTMLElement | null, marks: readonly PromptMark[], x: number, y: number): string {
  const element = Array.from(mirror?.querySelectorAll<HTMLElement>('.prompt-mark') ?? []).find(item =>
    Array.from(item.getClientRects()).some(rect => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom),
  )
  const mark = element && marks.find(item => String(item.start) === element.dataset.start)
  if (!mark) return ''
  const head = (mark.kind === 'skill' ? COPY.skill : mark.kind === 'member' ? COPY.member : COPY.command) + mark.name
  return escapeSecurityText(mark.description ? `${head}\n${mark.description}` : head)
}

/** The draft as the mirror paints it; `hint` follows the text, and a last empty line keeps its height. */
export function PromptMirrorText({ text, marks, hint }: { text: string; marks: readonly PromptMark[]; hint?: ReactNode }) {
  const parts: ReactNode[] = []
  let at = 0
  for (const mark of [...marks].sort((a, b) => a.start - b.start)) {
    if (mark.start < at) continue
    parts.push(
      text.slice(at, mark.start),
      <span key={mark.start} className="prompt-mark" data-kind={mark.kind} data-start={mark.start}>
        <span className="prompt-mark-sigil">
          {text[mark.start]}
          <Icon icon={mark.kind === 'skill' ? BookOpen : mark.kind === 'member' ? Users : CodeGlyph} size={14} />
        </span>
        <span className="prompt-mark-name">{text.slice(mark.start + 1, mark.end)}</span>
      </span>,
    )
    at = mark.end
  }
  parts.push(text.slice(at))
  return (
    <>
      {parts}
      {hint ?? (text.endsWith('\n') ? '​' : null)}
    </>
  )
}
