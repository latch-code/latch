/**
 * Puts `text` on the clipboard: the async Clipboard API where the page has it and may use it, else a hidden textarea and
 * `execCommand('copy')`. The API is missing in an insecure context (a browser on `http://<LAN IP>`). Call it straight
 * from the press, so the fallback still runs inside it. Rejects only when both ways fail.
 */
export async function writeClipboard(text: string): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard
  if (typeof clipboard?.writeText !== 'function') {
    if (!copyWithSelection(text)) throw new ClipboardError()
    return
  }
  try {
    await clipboard.writeText(text)
  } catch (cause) {
    if (!copyWithSelection(text)) throw new ClipboardError({ cause })
  }
}

/** Neither way could copy; the page says 「复制不可用」 rather than blaming the connection. */
export class ClipboardError extends Error {
  constructor(options?: ErrorOptions) {
    super('复制不可用，请手动选择', options)
    this.name = 'ClipboardError'
  }
}

/** The older way: select the text in an off-screen textarea and copy the selection; focus and selection come back. */
function copyWithSelection(text: string): boolean {
  const doc = globalThis.document as Document | undefined
  if (!doc?.body || typeof doc.execCommand !== 'function') return false
  const active = doc.activeElement as HTMLElement | null
  const selection = doc.getSelection?.() ?? null
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  const area = doc.createElement('textarea')
  area.value = text
  area.readOnly = true
  area.setAttribute('aria-hidden', 'true')
  area.tabIndex = -1
  Object.assign(area.style, { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' })
  // Inside an open modal the rest of the page is inert, so the textarea goes where the focus is.
  const parent = (typeof active?.closest === 'function' ? active.closest('dialog, [popover]') : null) ?? doc.body
  parent.append(area)
  try {
    area.select()
    return doc.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
    if (range && selection) {
      selection.removeAllRanges()
      selection.addRange(range)
    }
    if (typeof active?.focus === 'function') active.focus({ preventScroll: true })
  }
}
