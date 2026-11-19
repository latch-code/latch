import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ValuePicker as Picker, type ValuePickerProps } from '@latch/ui'

type ControlName = 'harness' | 'model' | 'thinking' | 'permission'
/** The part of the input's one entry a request opens it on: the models, the levels or the foot's permission. */
export type EntryPart = 'list' | 'levels' | 'foot'
const openers = new WeakMap<HTMLElement, (query?: string, part?: EntryPart) => void>()
const SearchRequest = createContext<{ query: string; revision: number } | undefined>(undefined)
const PartRequest = createContext<{ part: EntryPart | undefined; clear: () => void }>({ part: undefined, clear: () => {} })

/** 思考 and 权限 are set in the model's entry: one control, one panel, opened on their part. */
const PARTS: Partial<Record<ControlName, EntryPart>> = { thinking: 'levels', permission: 'foot' }

/**
 * The same control entry point serves shortcuts, slash actions and recovery buttons: 模型, 思考 and 权限 open the one
 * entry's panel on their part.
 */
export function openControlWhenShown(name: ControlName, frames = 10, newOnly = true, query?: string) {
  const part = PARTS[name]
  const shown = part ? 'model' : name
  requestAnimationFrame(() => {
    const control = [...document.querySelectorAll<HTMLElement>(`[data-composer-control="${shown}"]`)].find(
      element =>
        element.getClientRects().length > 0
        && !element.closest('[inert], [hidden], [aria-hidden="true"]')
        && (!newOnly || element.closest('.workbench-home')),
    )
    const trigger = control?.querySelector<HTMLButtonElement>('button')
    if (control && trigger && !trigger.disabled && trigger.getAttribute('aria-disabled') !== 'true') {
      const open = openers.get(control)
      if (open) open(query, part)
      else trigger.click()
    } else if (frames > 1) openControlWhenShown(name, frames - 1, newOnly, query)
  })
}

export function ComposerControl({ name, children }: { name: ControlName; children: ReactNode }) {
  const wrapper = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState<{ query: string; revision: number }>()
  const [part, setPart] = useState<EntryPart>()
  useLayoutEffect(() => {
    const element = wrapper.current
    if (!element) return undefined
    openers.set(element, (query, asked) => {
      if (name === 'model' && query !== undefined) setSearch(previous => ({ query, revision: (previous?.revision ?? 0) + 1 }))
      else {
        // Read when the panel opens, in the same render as the click that opens it. Already open, the panel moves focus
        // to the part asked for instead of closing.
        const trigger = element.querySelector<HTMLButtonElement>('button')
        if (asked) setPart(asked)
        if (!(asked && trigger?.getAttribute('aria-expanded') === 'true')) trigger?.click()
      }
    })
    return () => {
      openers.delete(element)
    }
  }, [name])
  return (
    <div ref={wrapper} className="composer-control" data-composer-control={name}>
      <SearchRequest.Provider value={search}>
        <PartRequest.Provider value={{ part, clear: () => setPart(undefined) }}>{children}</PartRequest.Provider>
      </SearchRequest.Provider>
    </div>
  )
}

/** The part a shortcut or slash action asked the entry to open on; cleared once the panel closes. */
export function usePartRequest(): { part: EntryPart | undefined; clear: () => void } {
  return useContext(PartRequest)
}

/** A slash argument's request to open the model panel on a search. */
export function useSearchRequest(): { query: string; revision: number } | undefined {
  return useContext(SearchRequest)
}

/** Model controls retain their own menu and sender; a slash argument only initializes its search. */
export function ValuePicker<T extends string>(props: ValuePickerProps<T>) {
  const searchRequest = useContext(SearchRequest)
  return <Picker {...props} {...(searchRequest ? { searchRequest, searchable: true } : {})} />
}
