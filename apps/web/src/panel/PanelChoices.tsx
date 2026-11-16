import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Icon, IconButton, Kbd, Menu, PlusGlyph } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import type { PanelChoice, PanelKey } from './panelTabs.ts'

/** The 「+」 at the end of the panel's tabs: everything that can be opened here, each with its letter. */
export function PanelAddMenu({
  choices,
  onChoose,
  trigger,
  shortcut,
}: {
  choices: readonly PanelChoice[]
  onChoose(key: PanelKey): void
  /** The workbench's key presses it. */
  trigger?: RefObject<HTMLButtonElement | null>
  shortcut?: string | null
}) {
  return (
    <Menu
      label="打开面板"
      size="xs"
      sections={[
        {
          id: 'open',
          items: choices.map(choice => ({
            id: choice.key,
            label: choice.label,
            icon: choice.icon,
            ...(choice.letter ? { accelerator: choice.letter } : {}),
            onSelect: () => onChoose(choice.key),
          })),
        },
      ]}
      trigger={props => (
        <IconButton
          {...props}
          ref={element => {
            props.ref.current = element
            if (trigger) trigger.current = element
          }}
          size="xs"
          icon={PlusGlyph}
          label="打开面板"
          {...(shortcut ? { shortcut } : {})}
        />
      )}
    />
  )
}

/** A panel with no tab open: the same choices as icons and names, and the same letters while it has focus. */
export function PanelEmpty({
  choices,
  onChoose,
  takesFocus,
  children,
}: {
  choices: readonly PanelChoice[]
  onChoose(key: PanelKey): void
  /** Whether the person just asked for the panel; anything else mounting it must not pull focus out of the composer. */
  takesFocus?: () => boolean
  children?: ReactNode
}) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (takesFocus?.()) list.current?.focus({ preventScroll: true })
  }, [])
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return
    const choice = choices.find(item => item.letter === event.key.toUpperCase())
    if (!choice) return
    event.preventDefault()
    onChoose(choice.key)
  }
  return (
    <div className="panel-empty" ref={list} tabIndex={-1} onKeyDown={keydown}>
      {choices.length > 0 && (
        <div className="panel-empty-choices" role="group" aria-label="打开面板">
          {choices.map(choice => (
            <button
              key={choice.key}
              type="button"
              className="panel-empty-choice"
              {...(choice.letter ? { 'aria-keyshortcuts': choice.letter } : {})}
              onClick={() => {
                onChoose(choice.key)
              }}>
              <Icon icon={choice.icon} size={16} />
              <span>
                <VisibleText text={choice.label} />
              </span>
              {choice.letter && <Kbd>{choice.letter}</Kbd>}
            </button>
          ))}
        </div>
      )}
      {children}
    </div>
  )
}
