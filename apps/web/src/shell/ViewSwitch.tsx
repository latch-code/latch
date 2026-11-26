import { useShortcutBindings } from '../core/shortcutBindings.ts'
import { MessagesSquare, SquareKanban } from 'lucide-react'
import { Count, Icon, SegmentedControl, useLivePrevious } from '@latch/ui'
import { defineCopy } from '../core/i18n.ts'
import { currentShell } from '../core/shell.ts'
import { switchWorkView, VIEW_NAMES, type WorkView } from '../preferences.ts'
import { shortcutKeys } from '../workbenchShortcuts.ts'

const VIEW_GLYPHS = { chat: MessagesSquare, board: SquareKanban } as const
const COPY = defineCopy({ views: '视图' }, { views: 'View' })

/**
 * 对话 | 看板: compact view switch at the start of the window's top row (vertical icons in a tablet's rail, full width
 * in a phone's heading). Wide windows keep one instance inside `.titlebar-lead` across 对话 ⇄ 看板, so the control and
 * the focus on it stay through a switch. In 对话 the 看板 segment carries how many cards wait on the person, amber,
 * while there are any. `icons`: the shell's switch also carries each view's glyph, shown in place of the words whenever
 * the left slot is too narrow for the text form (workbench.css); the words stay its name and tooltip.
 */
export function ViewSwitch({
  value,
  waiting,
  className,
  icons = false,
}: {
  value: WorkView
  waiting: number
  className?: string
  icons?: boolean
}) {
  useShortcutBindings()
  const keys = shortcutKeys('view', currentShell() !== null)
  const waitingBefore = useLivePrevious(waiting)
  const option = (view: WorkView) => ({
    value: view,
    label: VIEW_NAMES[view],
    title: keys && view !== value ? `${VIEW_NAMES[view]} ${keys}` : VIEW_NAMES[view],
    ...(icons ? { icon: <Icon icon={VIEW_GLYPHS[view]} size={16} /> } : {}),
    ...(view === 'board' && value === 'chat' && waiting > 0 ? { badge: <Count tone="warn" value={waiting} from={waitingBefore} /> } : {}),
  })
  return (
    <SegmentedControl
      className={className ? `view-switch ${className}` : 'view-switch'}
      label={COPY.views}
      value={value}
      options={[option('chat'), option('board')]}
      onValueChange={switchWorkView}
    />
  )
}
