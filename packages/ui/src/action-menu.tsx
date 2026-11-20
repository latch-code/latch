import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { Sheet } from './dialog.tsx'
import { Menu, MenuPanel, useLayerClose, type MenuChoiceItem, type MenuItem, type MenuSection, type MenuTriggerProps } from './menu.tsx'
import { UI_COPY } from './locale.ts'

export type ActionMenuItem = (Omit<MenuItem, 'media'> | Omit<MenuChoiceItem, 'media'>) & {
  leading?: ReactNode
  disabled?: boolean
}
export interface ActionMenuSection extends Omit<MenuSection, 'media' | 'items'> {
  leading?: ReactNode
  items: ActionMenuItem[]
}
const sectionsOf = (sections: ActionMenuSection[]): MenuSection[] =>
  sections.map(({ leading, items, ...section }) => ({
    ...section,
    media: leading,
    items: items.map(({ leading: media, disabled, disabledReason, ...item }) => ({
      ...item,
      media,
      ...(disabled ? { disabledReason: disabledReason ?? UI_COPY.unavailable } : {}),
    })),
  }))
function Footer({ render }: { render: (close: () => void) => ReactNode }) {
  return render(useLayerClose())
}

/** Compatibility shape for action menus; positioning, keyboard and focus all belong to Menu. */
export function ActionMenu({
  label,
  title,
  sections,
  trigger,
  context,
  placement = 'bottom-start',
  selection = false,
  frosted = false,
  footer,
  className,
}: {
  label: string
  title?: string
  sections: ActionMenuSection[]
  trigger?: (props: MenuTriggerProps) => ReactNode
  /** The row whose context gesture opens the same menu (see `Menu`). */
  context?: ComponentProps<typeof Menu>['context']
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'
  selection?: boolean
  frosted?: boolean
  footer?: (close: () => void) => ReactNode
  className?: string
}) {
  return (
    <Menu
      label={label}
      title={title}
      sections={sectionsOf(sections)}
      {...(trigger ? { trigger } : {})}
      {...(context ? { context } : {})}
      side={placement.startsWith('top') ? 'top' : 'bottom'}
      align={placement.endsWith('end') ? 'end' : 'start'}
      selection={selection}
      frosted={frosted}
      className={className}
      footer={footer ? <Footer render={footer} /> : undefined}
    />
  )
}

/** A context menu without an anchor, e.g. a phone row pressed and held. */
export function ActionSheet({ label, sections, onClose }: { label: string; sections: ActionMenuSection[] | null; onClose: () => void }) {
  const [shown, setShown] = useState<{ label: string; sections: ActionMenuSection[] } | null>(null)
  if (sections !== null && (shown?.sections !== sections || shown.label !== label)) setShown({ label, sections })
  const panel = useRef<HTMLDivElement>(null)
  const open = sections !== null
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true })
  }, [open])
  return (
    <Sheet open={open} title={shown?.label ?? label} onClose={onClose}>
      <MenuPanel
        label={shown?.label ?? label}
        sections={sectionsOf(shown?.sections ?? [])}
        panelRef={panel}
        open={open}
        onChoose={item => {
          onClose()
          item.onSelect()
        }}
        onDismiss={onClose}
      />
    </Sheet>
  )
}
