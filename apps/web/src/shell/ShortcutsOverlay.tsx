import { useShortcutBindings } from '../core/shortcutBindings.ts'
import { useState } from 'react'
import { Button, Dialog, Kbd, SearchField } from '@latch/ui'
import { defineCopy } from '../core/i18n.ts'
import { currentShell } from '../core/shell.ts'
import { ShortcutCaps } from '../settings/ShortcutsSettings.tsx'
import { shortcutRows } from '../workbenchShortcuts.ts'
import { useCoarsePointer } from '../breakpoints.ts'
import { usePreferences } from '../preferences.ts'

const OVERLAY_COPY = defineCopy(
  { title: '快捷键', close: '关闭', settingsLink: '设置 › 快捷键', search: '搜索快捷键', none: '没有匹配的快捷键' },
  {
    title: 'Keyboard shortcuts',
    close: 'Close',
    settingsLink: 'Settings › Shortcuts',
    search: 'Search shortcuts',
    none: 'No matching shortcuts',
  },
)

/**
 * ⌘/ (a browser's Alt /): this client's shortcuts over the session, which keeps running behind the scrim, in two
 * columns with a search that takes the focus. Esc, the scrim or ⌘/ again closes it; 设置 › 快捷键 is the same table
 * as a page. Flat, without groups: the group names are only a proposal so far.
 */
export function ShortcutsOverlay({
  onClose,
  onSettings,
  spaces = true,
  delegate = true,
}: {
  onClose: () => void
  onSettings?: (() => void) | undefined
  /** The Host has 我的 Agent: the keys between the two places do something. */
  spaces?: boolean
  /** This device can delegate (it runs sessions and reads Agents): ⌘N is also 委托 in 我的 Agent. */
  delegate?: boolean
}) {
  useShortcutBindings()
  const { followUpDefault, sendKey } = usePreferences()
  const coarse = useCoarsePointer()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLocaleLowerCase()
  const rows = shortcutRows(currentShell() !== null, undefined, { spaces, delegate, followUpDefault, sendKey, coarse }).filter(row =>
    `${row.label} ${row.keys}`.toLocaleLowerCase().includes(needle),
  )
  const half = Math.ceil(rows.length / 2)
  const columns = [rows.slice(0, half), rows.slice(half)].filter(column => column.length)
  return (
    <Dialog
      open
      size="xl"
      className="shortcuts-overlay"
      title={OVERLAY_COPY.title}
      onClose={onClose}
      note={
        <span className="shortcuts-overlay-hint">
          <Kbd keys="esc" />
          {OVERLAY_COPY.close}
        </span>
      }
      footer={
        onSettings && (
          <Button variant="link" onClick={onSettings}>
            {OVERLAY_COPY.settingsLink}
          </Button>
        )
      }>
      <SearchField className="shortcuts-overlay-search" label={OVERLAY_COPY.search} value={query} onValueChange={setQuery} />
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
        <p className="shortcuts-overlay-none">{OVERLAY_COPY.none}</p>
      )}
    </Dialog>
  )
}
