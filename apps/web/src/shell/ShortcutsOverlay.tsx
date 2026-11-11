import { useState } from 'react'
import { Button, Dialog, Kbd, SearchField } from '@latch/ui'
import { currentShell } from '../core/shell.ts'
import { ShortcutCaps } from '../settings/ShortcutsSettings.tsx'
import { shortcutRows } from '../workbenchShortcuts.ts'

/**
 * ⌘/ (a browser's Alt /): this client's shortcuts over the session, which keeps running behind the scrim, in two
 * columns with a search that takes the focus. Esc, the scrim or ⌘/ again closes it; 设置 › 快捷键 is the same table
 * as a page. Flat, without groups: the group names are only a proposal so far.
 */
export function ShortcutsOverlay({ onClose, onSettings }: { onClose: () => void; onSettings?: (() => void) | undefined }) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLocaleLowerCase()
  const rows = shortcutRows(currentShell() !== null).filter(row => `${row.label} ${row.keys}`.toLocaleLowerCase().includes(needle))
  const half = Math.ceil(rows.length / 2)
  const columns = [rows.slice(0, half), rows.slice(half)].filter(column => column.length)
  return (
    <Dialog
      open
      size="wide"
      className="shortcuts-overlay"
      title="快捷键"
      onClose={onClose}
      note={
        <span className="shortcuts-overlay-hint">
          <Kbd keys="esc" />
          关闭
        </span>
      }
      footer={
        onSettings && (
          <Button variant="link" onClick={onSettings}>
            设置 › 快捷键
          </Button>
        )
      }>
      <SearchField className="shortcuts-overlay-search" label="搜索快捷键" value={query} onValueChange={setQuery} />
      {columns.length ? (
        <div className="shortcuts-overlay-columns">
          {columns.map(column => (
            <ul key={column[0]!.id} className="shortcuts-overlay-list">
              {column.map(row => (
                <li key={row.id} className="shortcuts-overlay-row">
                  <span className="shortcuts-overlay-label">{row.label}</span>
                  <ShortcutCaps keys={row.keys} />
                </li>
              ))}
            </ul>
          ))}
        </div>
      ) : (
        <p className="shortcuts-overlay-none">没有匹配的快捷键</p>
      )}
    </Dialog>
  )
}
