import { useCallback, useState } from 'react'
import { ChevronDownGlyph, Icon, Tooltip } from '@latch/ui'
import { formatNumber, useLocale } from '../core/i18n.ts'
import { readFolded, writeFolded } from '../sessions.ts'
import { SESSION_LIST_COPY as COPY } from './sessionList.copy.ts'

/** The shelves, and the sessions whose members, this device has folded, remembered per device. */
export function useFoldedShelves(key: string) {
  const [folded, setFolded] = useState(() => readFolded(key))
  const toggle = useCallback(
    (id: string) => {
      setFolded(previous => {
        const next = new Set(previous)
        if (!next.delete(id)) next.add(id)
        writeFolded(key, next)
        return next
      })
    },
    [key],
  )
  return [folded, toggle] as const
}

/** On a session that has members under it: how many, and the way to fold them away or back. */
export function TeamFold({
  count,
  folded,
  onToggle,
  className,
}: {
  count: number
  folded: boolean
  onToggle: () => void
  className?: string
}) {
  useLocale()
  const label = folded ? COPY.unfoldMembers(count) : COPY.foldMembers(count)
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={className ? `team-fold ${className}` : 'team-fold'}
        aria-expanded={!folded}
        aria-label={label}
        onClick={event => {
          event.stopPropagation()
          onToggle()
        }}>
        <span className="team-fold-count">{formatNumber(count)}</span>
        <Icon icon={ChevronDownGlyph} size={12} className="team-fold-chevron" />
      </button>
    </Tooltip>
  )
}
