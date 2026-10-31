import { Icon } from '@latch/ui'
import { RAIL_ICONS, RAIL_LABELS } from './Rail.tsx'
import type { ShellState } from './useShellLayout.tsx'

/** Phones have no rail: the root pages share a bottom bar of 会话, Agent and 设置. A pushed page covers it. */
export function PhoneTabBar({ shell }: { shell: ShellState }) {
  const { entries, route, goEntry } = shell
  return (
    <nav className="phone-tabs" aria-label="主导航">
      {entries.map(entry => (
        <button
          key={entry}
          type="button"
          className="phone-tab"
          aria-current={route.entry === entry ? 'page' : undefined}
          onClick={() => {
            goEntry(entry)
          }}>
          <Icon icon={RAIL_ICONS[entry]} size={20} />
          <span>{RAIL_LABELS[entry]}</span>
        </button>
      ))}
    </nav>
  )
}
