import { useEffect } from 'react'
import { currentShell } from '../core/shell.ts'

/** The field that owns ⌘Z while it has focus: the composer's text comes first. */
const editing = (target: EventTarget | null) =>
  target instanceof HTMLElement
  && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')

/** The line under the list after an archive: it says what happened and takes it back, by click or by ⌘Z. */
export function ArchiveUndo({ onUndo, onExpire }: { onUndo: () => void; onExpire: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onExpire, 8000)
    return () => {
      clearTimeout(timer)
    }
  }, [onExpire])
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.code !== 'KeyZ' || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
      if (editing(event.target) || document.querySelector('dialog[open]')) return
      event.preventDefault()
      onUndo()
    }
    window.addEventListener('keydown', handle)
    return () => {
      window.removeEventListener('keydown', handle)
    }
  }, [onUndo])
  return (
    <div className="archive-undo" role="status">
      <span>已归档</span>
      <button type="button" onClick={onUndo}>
        {currentShell() ? '⌘Z 撤销' : '撤销'}
      </button>
    </div>
  )
}
