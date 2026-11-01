import { useState } from 'react'
import { Kbd, SearchField } from '@latch/ui'
import { currentShell } from '../core/shell.ts'
import { shortcutCaps, shortcutRows } from '../workbenchShortcuts.ts'
import { SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'

function ShortcutCaps({ keys }: { keys: string }) {
  return (
    <span className="shortcut-caps" data-keys={keys}>
      {shortcutCaps(keys).map((caps, alternative) => (
        <span key={caps.join(' ')} className="shortcut-alternative">
          {alternative > 0 && <span className="shortcut-or">或</span>}
          {caps.map((cap, at) => (
            <Kbd key={`${cap}-${String(at)}`}>{cap}</Kbd>
          ))}
        </span>
      ))}
    </span>
  )
}

/** The shortcuts of this kind of client, and no other's. */
export function ShortcutsSettings() {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLocaleLowerCase()
  const rows = shortcutRows(currentShell() !== null).filter(row => `${row.label} ${row.keys}`.toLocaleLowerCase().includes(needle))
  return (
    <>
      <SectionHeading
        title="快捷键"
        action={<SearchField className="shortcuts-search" label="搜索快捷键" value={query} onValueChange={setQuery} />}
      />
      <SettingsGroup>
        {rows.map(row => (
          <SettingsRow key={row.id} className="shortcut-row" title={row.label} trailing={<ShortcutCaps keys={row.keys} />} />
        ))}
        {!rows.length && <SettingsRow title="没有匹配的快捷键" dim />}
      </SettingsGroup>
    </>
  )
}
