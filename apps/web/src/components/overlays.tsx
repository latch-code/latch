export {
  Modal,
  ModalHeader,
  ConfirmDialog,
  PromptDialog,
  ActionMenu as Menu,
  ActionSheet,
  type ActionMenuSection as MenuSection,
} from '@latch/ui'

/** Only a scroll of a container holding the trigger moves a menu's anchor. */
export function scrollMovesAnchor(target: EventTarget | null, anchor: Node | null): boolean {
  return anchor !== null && target !== null && 'contains' in target && (target as Node).contains(anchor)
}

/** A menu's row found from its ⋯ trigger, so the row's context gesture opens the same menu (`Menu`'s `context`). */
export const rowOf =
  (selector: string) =>
  (trigger: HTMLElement | null): HTMLElement | null =>
    trigger?.closest<HTMLElement>(selector) ?? null
