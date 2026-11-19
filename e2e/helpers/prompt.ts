import type { Locator } from '@playwright/test'

/** CodeMirror's view as its content element holds it: the message input is one, and its document is the draft. */
interface PromptView {
  state: { doc: { toString(): string; length: number }; selection: { main: { from: number; to: number; head: number } } }
  dispatch(spec: { selection: { anchor: number; head: number } }): void
  focus(): void
}

/**
 * The draft in a message input (`getByRole('textbox', …)`): the editor's document, never the element's visible text,
 * where a chip shows a name in place of its token.
 */
export function promptValue(input: Locator): Promise<string> {
  return input.evaluate(element => {
    const view = (element as unknown as { cmTile?: { root?: { view?: PromptView } } }).cmTile?.root?.view
    if (!view) throw new Error('not a message input')
    return view.state.doc.toString()
  })
}

/** The input's selection in text offsets. */
export function promptSelection(input: Locator): Promise<{ from: number; to: number; head: number }> {
  return input.evaluate(element => {
    const view = (element as unknown as { cmTile?: { root?: { view?: PromptView } } }).cmTile?.root?.view
    if (!view) throw new Error('not a message input')
    const { from, to, head } = view.state.selection.main
    return { from, to, head }
  })
}

/** Puts the caret (or a selection from `anchor`) at text offsets, focused, as a click there would. */
export function setPromptSelection(input: Locator, anchor: number, head = anchor): Promise<void> {
  return input.evaluate(
    (element, [from, to]) => {
      const view = (element as unknown as { cmTile?: { root?: { view?: PromptView } } }).cmTile?.root?.view
      if (!view) throw new Error('not a message input')
      view.focus()
      view.dispatch({ selection: { anchor: from!, head: to! } })
    },
    [anchor, head],
  )
}
