import { ChartNoAxesColumn } from 'lucide-react'
import { Button, IconButton } from '@latch/ui'
import { currentShell } from '../core/shell.ts'
import { shortcutKeys } from '../workbenchShortcuts.ts'
import { openUsage, useUsageRequest } from './surface.ts'

/**
 * The one global way to 额度与用量 (every Harness's limits, every service's use), with its shortcut printed on it: a row in
 * the sidebar's foot beside 设置, or an icon where there is no sidebar (the top bar, a phone's home). Opened by a click,
 * never by hover.
 */
export function UsageEntry({ appearance = 'icon' }: { appearance?: 'icon' | 'row' }) {
  const open = useUsageRequest() !== null
  const keys = shortcutKeys('usage', currentShell() !== null) ?? undefined
  const show = () => {
    openUsage({ view: 'limits' })
  }
  if (appearance === 'row')
    return (
      <Button
        variant="ghost"
        className="sidebar-nav-row usage-entry"
        icon={ChartNoAxesColumn}
        shortcut={keys}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={show}>
        额度与用量
      </Button>
    )
  return (
    <IconButton
      className="usage-entry"
      label="额度与用量"
      icon={ChartNoAxesColumn}
      shortcut={keys}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={show}
    />
  )
}
