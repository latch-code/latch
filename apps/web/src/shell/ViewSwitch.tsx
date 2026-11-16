import { Count, SegmentedControl, useLivePrevious } from '@latch/ui'
import { currentShell } from '../core/shell.ts'
import { switchWorkView, VIEW_NAMES, type WorkView } from '../preferences.ts'
import { shortcutKeys } from '../workbenchShortcuts.ts'

/**
 * 对话 | 看板: two word segments at the end of the window's top row (and in a phone's heading). The shell draws it once on
 * wide windows, over the end each title row keeps free for it, so the control and the focus on it stay through a switch.
 * In 对话 the 看板 segment carries how many cards wait on the person, amber, while there are any.
 */
export function ViewSwitch({ value, waiting, className }: { value: WorkView; waiting: number; className?: string }) {
  const keys = shortcutKeys('view', currentShell() !== null)
  const waitingBefore = useLivePrevious(waiting)
  const option = (view: WorkView) => ({
    value: view,
    label: VIEW_NAMES[view],
    title: keys && view !== value ? `${VIEW_NAMES[view]} ${keys}` : VIEW_NAMES[view],
    ...(view === 'board' && value === 'chat' && waiting > 0 ? { badge: <Count tone="warn" value={waiting} from={waitingBefore} /> } : {}),
  })
  return (
    <SegmentedControl
      className={className ? `view-switch ${className}` : 'view-switch'}
      label="视图"
      value={value}
      options={[option('chat'), option('board')]}
      onValueChange={switchWorkView}
    />
  )
}
