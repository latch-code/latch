import { PanelTop } from 'lucide-react'
import { Icon, PanelLeftGlyph, SegmentedControl } from '@latch/ui'
import { currentShell } from '../core/shell.ts'
import { LAYOUT_NAMES, switchWorkbenchLayout, type WorkbenchLayout } from '../preferences.ts'
import { shortcutKeys } from '../workbenchShortcuts.ts'

/**
 * 侧栏 | 顶栏: the two workbench layouts as two icon segments. The shell draws it once, at the end of the window's top
 * row in either layout, so the control (and the focus on it) stays where it is while everything around it changes.
 */
export function LayoutSwitch({ value, className }: { value: WorkbenchLayout; className?: string }) {
  const keys = shortcutKeys('layout', currentShell() !== null)
  const option = (layout: WorkbenchLayout) => ({
    value: layout,
    label: LAYOUT_NAMES[layout],
    icon: <Icon icon={layout === 'overview' ? PanelLeftGlyph : PanelTop} size={16} />,
    title: keys && layout !== value ? `${LAYOUT_NAMES[layout]} ${keys}` : LAYOUT_NAMES[layout],
  })
  return (
    <SegmentedControl
      className={className ? `layout-switch ${className}` : 'layout-switch'}
      label="布局"
      value={value}
      options={[option('overview'), option('triage')]}
      onValueChange={switchWorkbenchLayout}
    />
  )
}
