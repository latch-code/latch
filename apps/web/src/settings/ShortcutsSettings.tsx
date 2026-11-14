import { useState } from 'react'
import { Kbd, SearchField } from '@latch/ui'
import { currentShell } from '../core/shell.ts'
import { capsText, shortcutCaps, shortcutRows } from '../workbenchShortcuts.ts'
import { SettingsGroup, SettingsRow } from './common.tsx'

/** A shortcut's keys as quiet text: alternatives apart with 「或」, the ends of a range with 「…」. */
export function ShortcutCaps({ keys }: { keys: string }) {
  return (
    <span className="shortcut-caps" data-keys={keys}>
      {shortcutCaps(keys).map(({ join, caps }) => (
        <span key={caps.join(' ')} className="shortcut-alternative">
          {join && <span className="shortcut-or">{join}</span>}
          <Kbd>{capsText(caps)}</Kbd>
        </span>
      ))}
    </span>
  )
}

/** The shortcuts of this kind of client, and no other's. The page's name heads the section; the search stands under it. */
export function ShortcutsSettings({ spaces = true, delegate = true }: { spaces?: boolean; delegate?: boolean }) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLocaleLowerCase()
  const rows = shortcutRows(currentShell() !== null, undefined, { spaces, delegate }).filter(row =>
    `${row.label} ${row.keys}`.toLocaleLowerCase().includes(needle),
  )
  return (
    <>
      <SearchField className="shortcuts-search" label="搜索快捷键" value={query} onValueChange={setQuery} />
      <SettingsGroup>
        {rows.map(row => (
          <SettingsRow key={row.id} className="shortcut-row" title={row.label} trailing={<ShortcutCaps keys={row.keys} />} />
        ))}
        {!rows.length && <SettingsRow title="没有匹配的快捷键" dim />}
      </SettingsGroup>
    </>
  )
}
