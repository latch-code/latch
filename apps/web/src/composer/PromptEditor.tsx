import { useLayoutEffect, useRef, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  Compartment,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  Annotation,
  type ChangeSpec,
  type Extension,
} from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap, placeholder as placeholderText, type DecorationSet } from '@codemirror/view'
import { history, historyKeymap, insertNewline, isolateHistory, standardKeymap } from '@codemirror/commands'
import type { FileMention } from '@latch/protocol'
import { escapeSecurityText } from '@latch/protocol'
import { fencedParts } from '../conversation/fencedParts.ts'
import { webLinks } from '../webLinks.ts'
import { chipIcon, chipLabel, chipSpokenText, chipTip } from './PromptChip.tsx'
import { promptChips, type PromptCatalogue, type PromptChip } from './prompt-tokens.ts'
import { terminalExcerptField } from './terminalExcerptDecorations.tsx'
import { referenceExcerptField } from './referenceExcerptDecorations.tsx'

/**
 * The message input as the rest of the page holds it: the draft, its selection in text offsets, focus, and an edit that
 * is one step of the input's own undo (what the @ and slash menus put in).
 */
export interface PromptInput {
  readonly element: HTMLElement
  readonly value: string
  readonly selectionStart: number
  readonly selectionEnd: number
  readonly disabled: boolean
  focus(options?: FocusOptions): void
  setSelectionRange(start: number, end: number): void
  edit(value: string, selection?: { start: number; end: number }): void
  insertText(text: string): boolean
}

const inputs = new WeakMap<EditorView, PromptInput>()
/** Each chip's React root for its glyph; a widget equal to an earlier one keeps that one's DOM, so this is by element. */
const glyphs = new WeakMap<HTMLElement, Root>()

/** The prompt input drawn at or inside `element`, for code that finds the input in the page rather than by its ref. */
export function promptInputOf(element: Element | null | undefined): PromptInput | undefined {
  if (!element) return undefined
  const editor = element.closest('.cm-editor') ?? element.querySelector('.cm-editor')
  const view = editor instanceof HTMLElement ? EditorView.findFromDOM(editor) : null
  return view ? inputs.get(view) : undefined
}

interface ChipSource {
  catalogue: PromptCatalogue
  refs: readonly FileMention[]
  /** What a command takes, shown after it while nothing follows. */
  hint?: string | undefined
}

const setSource = StateEffect.define<ChipSource>()
const sourceField = StateField.define<ChipSource>({
  create: () => ({ catalogue: {}, refs: [] }),
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setSource)) return effect.value
    return value
  },
})

/** A change that came from the draft outside the input (a restore, a send, another device's words), not from typing. */
const outside = Annotation.define<boolean>()

class ChipWidget extends WidgetType {
  constructor(
    readonly chip: PromptChip,
    readonly token: string,
    readonly selected: boolean,
  ) {
    super()
  }
  override eq(other: ChipWidget): boolean {
    return (
      other.token === this.token
      && other.selected === this.selected
      && other.chip.kind === this.chip.kind
      && chipLabel(other.chip) === chipLabel(this.chip)
      && chipTip(other.chip) === chipTip(this.chip)
    )
  }
  toDOM(): HTMLElement {
    const chip = document.createElement('span')
    chip.className = 'prompt-chip'
    chip.dataset.kind = this.chip.kind
    if (this.selected) chip.dataset.selected = ''
    chip.title = chipTip(this.chip)
    const icon = document.createElement('span')
    icon.className = 'prompt-chip-icon'
    icon.setAttribute('aria-hidden', 'true')
    const label = document.createElement('span')
    label.className = 'prompt-chip-label'
    label.setAttribute('aria-hidden', 'true')
    label.textContent = chipLabel(this.chip)
    const spoken = document.createElement('span')
    spoken.className = 'prompt-chip-token'
    spoken.textContent = chipSpokenText(this.chip, this.token)
    chip.append(icon, label, spoken)
    // The glyph box keeps its 14px from the start, so the line does not move when React draws into it.
    const root = createRoot(icon)
    root.render(chipIcon(this.chip))
    glyphs.set(chip, root)
    return chip
  }
  override destroy(dom: HTMLElement): void {
    const root = glyphs.get(dom)
    glyphs.delete(dom)
    if (root) queueMicrotask(() => root.unmount())
  }
  /** A press on a chip puts the caret beside it, as on text. */
  override ignoreEvent(): boolean {
    return false
  }
}

class HintWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  override eq(other: HintWidget): boolean {
    return other.text === this.text
  }
  toDOM(): HTMLElement {
    const hint = document.createElement('span')
    hint.className = 'composer-command-hint'
    hint.setAttribute('aria-hidden', 'true')
    hint.textContent = escapeSecurityText(this.text)
    return hint
  }
}

/** A word still being typed can grow past an exact catalogue match such as @name or /short. */
const typingToken = StateField.define<{ start: number; end: number } | null>({
  create: () => null,
  update(previous, transaction) {
    const { head, empty } = transaction.newSelection.main
    if (!empty) return null
    if (!transaction.docChanged) return head === previous?.end ? previous : null
    const deleting = transaction.isUserEvent('delete')
    if (!transaction.isUserEvent('input.type') && !(deleting && previous)) return null
    const line = transaction.newDoc.lineAt(head)
    const word = /(?:^|\s)([@$/／]\S*)$/u.exec(line.text.slice(0, head - line.from))?.[1]
    if (!word) return null
    const start = head - word.length
    // Removing the pending query and its separator can leave the caret against an earlier, committed chip.
    if (deleting && previous && start !== transaction.changes.mapPos(previous.start)) return null
    return { start, end: head }
  },
})

/** The draft's chips: one replaced range per token, which the same set makes atomic for the caret and deletion. */
function chipDecorations(state: EditorState): DecorationSet {
  const { catalogue, refs } = state.field(sourceField)
  const text = state.doc.toString()
  const { from, to } = state.selection.main
  const typing = state.field(typingToken)
  const excerpts = [...state.field(terminalExcerptField).excerpts, ...state.field(referenceExcerptField).excerpts]
  return Decoration.set(
    promptChips(text, catalogue, refs, state.field(referenceExcerptField).literal)
      .filter(chip => chip.end !== typing?.end || chip.start !== typing.start || chip.kind === 'quote' || chip.kind === 'conversation')
      .filter(chip => !excerpts.some(block => chip.start < block.to && chip.end > block.from))
      .map(chip =>
        Decoration.replace({
          widget: new ChipWidget(chip, text.slice(chip.start, chip.end), from < to && from <= chip.start && to >= chip.end),
        }).range(chip.start, chip.end),
      ),
  )
}

const chipField = StateField.define<DecorationSet>({
  create: chipDecorations,
  update(value, transaction) {
    if (transaction.docChanged || transaction.effects.some(effect => effect.is(setSource))) return chipDecorations(transaction.state)
    if (transaction.selection && (value.size || transaction.startState.field(typingToken) !== transaction.state.field(typingToken)))
      return chipDecorations(transaction.state)
    return value
  },
  provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field))],
})

/** Add the separator the wire format needs when a person's edit would attach new prose to an intact reference. */
const keepChipBoundaries = EditorState.transactionFilter.of(transaction => {
  if (
    !transaction.docChanged
    || transaction.isUserEvent('input.complete')
    || !(transaction.isUserEvent('input') || transaction.isUserEvent('delete'))
  )
    return transaction
  const chips = transaction.startState.field(chipField)
  const separators: ChangeSpec[] = []
  transaction.changes.iterChangedRanges((from, to, newFrom, newTo) => {
    let before = '',
      after = ''
    chips.between(from, to, (start, end, decoration) => {
      const widget = decoration.spec.widget
      if (!(widget instanceof ChipWidget)) return
      const quote = widget.chip.kind === 'quote'
      if (end === from) {
        const next = transaction.newDoc.sliceString(newFrom, newFrom + 3)
        if (quote) {
          if (!widget.token.endsWith('\n\n') && next && (!next.startsWith('\n') || next.startsWith('\n> '))) before = '\n\n'
        } else if (/^\S/u.test(next)) before = ' '
      }
      if (start === to && newTo > 0) {
        const previous = transaction.newDoc.sliceString(newTo - 1, newTo)
        if (quote && previous !== '\n') after = '\n'
        // Harness commands and /skill:name only have meaning at the head of a message.
        else if (!quote && !/^[/／]/u.test(widget.token) && /\S/u.test(previous)) after = ' '
      }
    })
    if (before && after && newFrom === newTo) {
      separators.push({ from: newFrom, insert: before === ' ' ? after : before })
    } else {
      if (before) separators.push({ from: newFrom, insert: before })
      if (after) separators.push({ from: newTo, insert: after })
    }
  })
  return separators.length ? [transaction, { changes: separators, sequential: true }] : transaction
})

/** Completion reads editable text at a single caret, outside already-rendered chips and source excerpts. */
function completionCaret(state: EditorState): number | null {
  const { head, empty } = state.selection.main
  if (!empty) return null
  const quoted = (excerpt: { from: number; to: number }) => excerpt.from < head && head <= excerpt.to
  if (state.field(terminalExcerptField).excerpts.some(quoted) || state.field(referenceExcerptField).literal.some(quoted)) return null
  let caret: number | null = head
  state.field(chipField).between(head, head, (from, to) => {
    if (from < head && head <= to) caret = null
  })
  return caret
}

const urlMark = Decoration.mark({ class: 'prompt-url' })
const urlHighlights = EditorView.decorations.compute(['doc'], state => {
  const text = state.doc.toString()
  if (!text.includes('://')) return Decoration.none
  const prose = text.includes('```') ? fencedParts(text).filter(part => part.kind === 'text') : [{ text, from: 0 }]
  return Decoration.set(prose.flatMap(part => webLinks(part.text).map(link => urlMark.range(part.from + link.start, part.from + link.end))))
})

const hintField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(_value, transaction) {
    const hint = transaction.state.field(sourceField).hint
    const length = transaction.state.doc.length
    return hint ? Decoration.set(Decoration.widget({ widget: new HintWidget(hint), side: 1 }).range(length)) : Decoration.none
  },
  provide: field => EditorView.decorations.from(field),
})

/**
 * CodeMirror's own look stands down: the page's type, colours and padding (set as custom properties on
 * `.composer-input` in composer.css) and the platform's caret and selection, since no selection layer is drawn.
 */
const look = EditorView.theme({
  '&': { color: 'inherit', fontSize: 'inherit', lineHeight: 'inherit' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: 'inherit',
    overflowX: 'hidden',
    overflowY: 'auto',
    maxHeight: 'var(--prompt-max-height, 232px)',
  },
  '.cm-content': {
    padding: 'var(--prompt-padding, 16px 16px 8px)',
    minHeight: 'var(--prompt-min-height, auto)',
    caretColor: 'var(--ink)',
  },
  '.cm-line': { padding: 'var(--prompt-line-padding, 0)' },
  '.cm-placeholder': { color: 'var(--muted)' },
})

const keys = keymap.of([
  { key: 'Enter', run: insertNewline, shift: insertNewline },
  { key: 'Alt-Enter', run: insertNewline },
  ...historyKeymap,
  ...standardKeymap.filter(binding => binding.key !== 'Enter'),
])

/**
 * The input grows with its lines up to its maximum and then scrolls. The scroller's height is set from the content's,
 * so it can move over the motion token (composer.css) instead of jumping; under reduced motion it jumps.
 */
function fitHeight(view: EditorView) {
  view.requestMeasure({
    key: fitHeight,
    read: () => {
      const max = parseFloat(getComputedStyle(view.scrollDOM).maxHeight)
      const height = view.contentDOM.getBoundingClientRect().height
      return Number.isFinite(max) ? Math.min(height, max) : height
    },
    write: height => {
      const next = `${height}px`
      if (height > 0 && view.scrollDOM.style.height !== next) view.scrollDOM.style.height = next
    },
  })
}

/** The smallest change that turns `from` into `to`, so the caret outside it stays where it was. */
function difference(from: string, to: string) {
  let start = 0
  while (start < from.length && start < to.length && from[start] === to[start]) start++
  let end = 0
  while (end < from.length - start && end < to.length - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) }
}

function insertText(view: EditorView, text: string): boolean {
  if (view.state.readOnly) return false
  if (text) {
    view.dispatch(view.state.replaceSelection(text), {
      scrollIntoView: true,
      userEvent: 'input.paste',
      annotations: isolateHistory.of('full'),
    })
  }
  return true
}

interface Attributes {
  label: string
  autocomplete?: 'list' | undefined
  controls?: string | undefined
  activeDescendant?: string | undefined
}

export interface PromptEditorProps {
  inputRef: RefObject<PromptInput | null>
  value: string
  /** Every change the person makes, with the caret after it. */
  onChange(value: string, completionCaret: number | null): void
  /** Completion eligibility at mount, on selection changes and when the reference catalogue changes. */
  onCaret?(completionCaret: number | null, value: string): void
  catalogue: PromptCatalogue
  refs?: readonly FileMention[] | undefined
  hint?: string | undefined
  attributes: Attributes
  placeholder: string
  disabled: boolean
  /** Runs before the editor's own keys (menus, send, Esc); true when it took the key. */
  onKeyDown?(event: KeyboardEvent): boolean
  /** Runs before the editor's own paste; true when it took the clipboard (files go to attachments). */
  onPaste?(event: ClipboardEvent): boolean
}

/**
 * The message input: a CodeMirror view whose document is the draft itself. Known tokens are drawn as chips (replaced
 * ranges computed from the text, never stored), and the same ranges are atomic, so arrows, Backspace, Delete and a
 * selection take a chip whole while the draft stays the text the Host reads.
 */
export function PromptEditor(props: PromptEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(props)
  latest.current = props
  const compartments = useRef({
    attributes: new Compartment(),
    editable: new Compartment(),
    placeholder: new Compartment(),
    history: new Compartment(),
  })
  const applied = useRef({ attributes: '', disabled: props.disabled, placeholder: props.placeholder, source: '' })

  useLayoutEffect(() => {
    const parent = host.current
    if (!parent) return undefined
    const { attributes, editable, placeholder, history: undo } = compartments.current
    const initial = latest.current
    // The ClipboardEvent has the text but no modifiers. A keyboard paste arrives before the keys are released.
    let plainPaste = false
    let desktopPasteUntil = 0
    const clearPlainPaste = () => {
      plainPaste = false
    }
    const clearPaste = () => {
      clearPlainPaste()
      desktopPasteUntil = 0
    }
    const editor: EditorView = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial.value,
        selection: { anchor: initial.value.length },
        extensions: [
          sourceField.init(() => ({ catalogue: initial.catalogue, refs: initial.refs ?? [], hint: initial.hint })),
          terminalExcerptField,
          referenceExcerptField,
          typingToken,
          chipField,
          keepChipBoundaries,
          urlHighlights,
          hintField,
          undo.of(history()),
          EditorView.lineWrapping,
          look,
          attributes.of(contentAttributes(initial.attributes)),
          editable.of(editability(initial.disabled)),
          placeholder.of(placeholderText(initial.placeholder)),
          EditorView.domEventObservers({ keyup: clearPlainPaste, blur: clearPaste, contextmenu: clearPaste, pointerdown: clearPaste }),
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: event => {
                clearPaste()
                const handled = latest.current.onKeyDown?.(event) ?? false
                plainPaste =
                  !handled
                  && !event.isComposing
                  && event.keyCode !== 229
                  && (event.key.toLowerCase() === 'v' || (event.altKey && event.metaKey && event.code === 'KeyV'))
                  && event.shiftKey
                  && event.metaKey !== event.ctrlKey
                  && (!event.altKey || event.metaKey)
                return handled
              },
              paste: (event, activeView) => {
                const text = plainPaste || desktopPasteUntil > performance.now() ? event.clipboardData?.getData('text/plain') : undefined
                clearPaste()
                if (activeView.state.readOnly) return true
                return text ? insertText(activeView, text) : (latest.current.onPaste?.(event) ?? false)
              },
              // Files dropped here go to the attachments (the form's own drop handler); their bytes never become text.
              drop: event => {
                if (![...(event.dataTransfer?.types ?? [])].includes('Files')) return false
                event.preventDefault()
                return true
              },
            }),
          ),
          keys,
          EditorView.updateListener.of(update => {
            if (update.heightChanged || update.geometryChanged) fitHeight(update.view)
            const external = update.transactions.some(transaction => transaction.annotation(outside))
            if (update.docChanged && !external) latest.current.onChange(update.state.doc.toString(), completionCaret(update.state))
            else if (update.docChanged || update.selectionSet || update.state.field(chipField) !== update.startState.field(chipField)) {
              latest.current.onCaret?.(completionCaret(update.state), update.state.doc.toString())
            }
          }),
        ],
      }),
    })
    editor.contentDOM.addEventListener('latch:plain-paste', () => {
      // Expire the menu's intent if native paste does not produce an event (for example, with an empty clipboard).
      desktopPasteUntil = performance.now() + 500
    })
    applied.current = {
      attributes: JSON.stringify(initial.attributes),
      disabled: initial.disabled,
      placeholder: initial.placeholder,
      source: sourceKey(initial),
    }
    const input: PromptInput = {
      get element() {
        return editor.contentDOM
      },
      get value() {
        return editor.state.doc.toString()
      },
      get selectionStart() {
        return editor.state.selection.main.from
      },
      get selectionEnd() {
        return editor.state.selection.main.to
      },
      get disabled() {
        return editor.state.readOnly
      },
      focus: () => editor.focus(),
      setSelectionRange(start, end) {
        const length = editor.state.doc.length
        editor.dispatch({ selection: { anchor: Math.min(start, length), head: Math.min(end, length) }, scrollIntoView: true })
      },
      edit(value, selection) {
        const change = difference(editor.state.doc.toString(), value)
        const caret = selection ?? { start: change.from + change.insert.length, end: change.from + change.insert.length }
        editor.dispatch({
          changes: change,
          selection: { anchor: Math.min(caret.start, value.length), head: Math.min(caret.end, value.length) },
          scrollIntoView: true,
          userEvent: 'input.complete',
          // Its own step of undo: never joined with the typing just before it or the deleting just after.
          annotations: isolateHistory.of('full'),
        })
      },
      insertText: text => insertText(editor, text),
    }
    fitHeight(editor)
    // Once the face has loaded the lines may wrap elsewhere. (A test DOM may have no font set.)
    void document.fonts?.ready.then(() => fitHeight(editor))
    inputs.set(editor, input)
    view.current = editor
    latest.current.inputRef.current = input
    latest.current.onCaret?.(completionCaret(editor.state), editor.state.doc.toString())
    return () => {
      if (latest.current.inputRef.current === input) latest.current.inputRef.current = null
      view.current = null
      editor.destroy()
    }
  }, [])

  // The draft changed outside the input: the change is applied where it differs, so a caret elsewhere stays, and the
  // input's undo starts again, so ⌘Z never brings back a sent message or another session's draft.
  useLayoutEffect(() => {
    const editor = view.current
    if (!editor || editor.state.doc.toString() === props.value) return
    const { history: undo } = compartments.current
    // Into an empty input (a recalled or restored message) the caret goes to the end, as a textarea's would; text put in
    // where the caret stands (a Latch action completing its own word) leaves the caret after it. Elsewhere it stays.
    const change = difference(editor.state.doc.toString(), props.value)
    const { main } = editor.state.selection
    const caret =
      editor.state.doc.length === 0
        ? props.value.length
        : main.empty && main.head >= change.from && main.head <= change.to
          ? change.from + change.insert.length
          : undefined
    editor.dispatch({
      changes: change,
      ...(caret === undefined ? {} : { selection: { anchor: caret } }),
      annotations: [outside.of(true), Transaction.addToHistory.of(false)],
    })
    editor.dispatch({ effects: undo.reconfigure([]), annotations: outside.of(true) })
    editor.dispatch({ effects: undo.reconfigure(history()), annotations: outside.of(true) })
  }, [props.value])

  useLayoutEffect(() => {
    const editor = view.current
    if (!editor) return
    const { attributes, editable, placeholder } = compartments.current
    const done = applied.current
    const effects: StateEffect<unknown>[] = []
    const attributeKey = JSON.stringify(props.attributes)
    if (attributeKey !== done.attributes) effects.push(attributes.reconfigure(contentAttributes(props.attributes)))
    if (props.disabled !== done.disabled) effects.push(editable.reconfigure(editability(props.disabled)))
    if (props.placeholder !== done.placeholder) effects.push(placeholder.reconfigure(placeholderText(props.placeholder)))
    const source = sourceKey(props)
    if (source !== done.source) effects.push(setSource.of({ catalogue: props.catalogue, refs: props.refs ?? [], hint: props.hint }))
    if (!effects.length) return
    applied.current = { attributes: attributeKey, disabled: props.disabled, placeholder: props.placeholder, source }
    editor.dispatch({ effects })
  })

  return <div ref={host} className="prompt-editor" />
}

/** What decides the chips, without the members' marks (new elements on every render) beyond what they say. */
function sourceKey({ catalogue, refs, hint }: Pick<PromptEditorProps, 'catalogue' | 'refs' | 'hint'>): string {
  return JSON.stringify([
    catalogue.commands?.map(item => [item.name, item.description]),
    catalogue.skills?.map(item => [item.invocation, item.name, item.description]),
    catalogue.actions?.map(item => [item.name, item.description]),
    catalogue.members?.map(item => [item.token, item.name, item.title]),
    refs?.map(ref => [ref.root, ref.path]),
    hint,
  ])
}

/**
 * A prose field, not a code editor: spelling, autocorrect and capitalisation as a textarea has them, and the combobox
 * attributes of the @ and slash lists.
 */
function contentAttributes(attributes: Attributes): Extension {
  return EditorView.contentAttributes.of({
    'aria-label': attributes.label,
    'aria-multiline': 'true',
    spellcheck: 'true',
    autocorrect: 'on',
    autocapitalize: 'sentences',
    translate: 'yes',
    ...(attributes.autocomplete ? { 'aria-autocomplete': attributes.autocomplete } : {}),
    ...(attributes.controls ? { 'aria-controls': attributes.controls } : {}),
    ...(attributes.activeDescendant ? { 'aria-activedescendant': attributes.activeDescendant } : {}),
  })
}

function editability(disabled: boolean): Extension {
  return [
    EditorView.editable.of(!disabled),
    EditorState.readOnly.of(disabled),
    ...(disabled ? [EditorView.contentAttributes.of({ 'aria-disabled': 'true' })] : []),
  ]
}
