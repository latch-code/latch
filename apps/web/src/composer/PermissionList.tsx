import { ChevronLeft, Eye, Shield, ShieldAlert } from 'lucide-react'
import { ChoiceList, IconButton, useLayerClose } from '@latch/ui'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import type { ModeIcon, PermissionRow } from './permission.ts'

export const MODE_ICONS: Record<ModeIcon, typeof Shield> = { eye: Eye, shield: Shield, 'shield-alert': ShieldAlert }

/** The agent's modes, strictest first. A wider row asks on the Mac; another device sees why it cannot. */
export function PermissionList({
  rows,
  onChoose,
  onBack,
}: {
  rows: PermissionRow[]
  onChoose: (value: string) => void
  onBack?: () => void
}) {
  const close = useLayerClose()
  return (
    <div className="permission-list">
      {onBack && (
        <header className="permission-list-head">
          <IconButton size="xs" icon={ChevronLeft} label="返回" onClick={onBack} />
          <span>权限</span>
        </header>
      )}
      <ChoiceList
        label="权限"
        value={rows.find(row => row.current)?.value}
        options={rows.map(row => {
          const Glyph = MODE_ICONS[row.icon]
          return {
            value: row.value,
            title: escapeHiddenCharacters(row.name),
            ...(row.line ? { description: escapeHiddenCharacters(row.line) } : {}),
            media: <Glyph size={16} aria-hidden="true" />,
            ...(row.disabledReason ? { disabledReason: row.disabledReason } : {}),
          }
        })}
        onValueChange={value => {
          close()
          onChoose(value)
        }}
      />
    </div>
  )
}
