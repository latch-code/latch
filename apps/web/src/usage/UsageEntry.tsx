import { useShortcutBindings } from '../core/shortcutBindings.ts'
import { ChartNoAxesColumn } from 'lucide-react'
import { IconButton } from '@latch/ui'
import { currentShell } from '../core/shell.ts'
import { shortcutKeys } from '../workbenchShortcuts.ts'
import { openUsage, useUsageRequest } from './surface.ts'

/**
 * The one global way to 额度与用量 (every Harness's limits, every service's use), with its shortcut in its tooltip: an
 * icon in the sidebar's foot beside 设置, the rail, the top bar or a phone's home. Opened by a click, never by hover.
 */
export function UsageEntry() {
  useShortcutBindings()
  const open = useUsageRequest() !== null
  const keys = shortcutKeys('usage', currentShell() !== null) ?? undefined
  return (
    <IconButton
      className="usage-entry"
      label="额度与用量"
      icon={ChartNoAxesColumn}
      shortcut={keys}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => {
        openUsage({ view: 'limits' })
      }}
    />
  )
}
