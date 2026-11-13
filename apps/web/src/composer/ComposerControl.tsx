import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ValuePicker as Picker, type ValuePickerProps } from '@latch/ui'

type ControlName = 'harness' | 'model' | 'thinking' | 'permission'
const openers = new WeakMap<HTMLElement, (query?: string) => void>()
const SearchRequest = createContext<{ query: string; revision: number } | undefined>(undefined)

/** The same control entry point serves shortcuts, slash actions and recovery buttons. */
export function openControlWhenShown(name: ControlName, frames = 10, newOnly = true, query?: string) {
  requestAnimationFrame(() => {
    const control = [...document.querySelectorAll<HTMLElement>(`[data-composer-control="${name}"]`)].find(
      element =>
        element.getClientRects().length > 0
        && !element.closest('[inert], [hidden], [aria-hidden="true"]')
        && (!newOnly || element.closest('.workspace.is-new')),
    )
    const trigger = control?.querySelector<HTMLButtonElement>('button')
    if (control && trigger && !trigger.disabled && trigger.getAttribute('aria-disabled') !== 'true') {
      const open = openers.get(control)
      if (open) open(query)
      else trigger.click()
    } else if (frames > 1) openControlWhenShown(name, frames - 1, newOnly, query)
  })
}

export function ComposerControl({ name, children }: { name: ControlName; children: ReactNode }) {
  const wrapper = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState<{ query: string; revision: number }>()
  useLayoutEffect(() => {
    const element = wrapper.current
    if (!element) return undefined
    openers.set(element, query => {
      if (name === 'model' && query !== undefined) setSearch(previous => ({ query, revision: (previous?.revision ?? 0) + 1 }))
      else element.querySelector<HTMLButtonElement>('button')?.click()
    })
    return () => {
      openers.delete(element)
    }
  }, [name])
  return (
    <div ref={wrapper} className="composer-control" data-composer-control={name}>
      <SearchRequest.Provider value={search}>{children}</SearchRequest.Provider>
    </div>
  )
}

/** Model controls retain their own menu and sender; a slash argument only initializes its search. */
export function ValuePicker<T extends string>(props: ValuePickerProps<T>) {
  const searchRequest = useContext(SearchRequest)
  return <Picker {...props} {...(searchRequest ? { searchRequest, searchable: true } : {})} />
}
