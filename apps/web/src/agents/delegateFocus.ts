import { promptInputOf } from '../composer/PromptEditor.tsx'

/**
 * 委托… chosen from the sidebar or the list: the Agent's page opens on 委托 and its input takes the keys once it is drawn,
 * which may be a read later. Only the next 委托 page asks for it.
 */
let pending = false

export function askDelegateFocus(): void {
  pending = true
}

/** Focuses the delegation's input if one was asked for and it is drawn now; true once done. */
export function takeDelegateFocus(): boolean {
  if (!pending) return false
  const input = promptInputOf(document.querySelector('.agent-delegate .composer-input'))
  if (!input) return false
  pending = false
  input.focus({ preventScroll: true })
  return true
}
