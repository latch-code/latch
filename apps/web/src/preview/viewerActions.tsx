import { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MenuItem } from '@latch/ui'

/** A renderer's source toggle, drawn as one button in the viewer's row. */
export interface ViewerSource {
  showing: boolean
  onToggle(): void
}

/** The quote a renderer can make right now; `ready` is false while a new version of the file is on its way. */
export interface ViewerQuote {
  ready: boolean
  run(): void
}

interface ViewerActionsValue {
  setMenu(owner: string, items: readonly MenuItem[] | null): void
  setSource(source: ViewerSource | null): void
  setQuote(quote: ViewerQuote | null): void
}

const ViewerActionsContext = createContext<ViewerActionsValue | null>(null)
export const ViewerActionsProvider = ViewerActionsContext.Provider

/** What the renderer inside offers: the viewer's row draws these, so a renderer keeps no chrome of its own. */
export function useViewerActionsHost(): {
  value: ViewerActionsValue
  menu: readonly MenuItem[]
  source: ViewerSource | null
  quote: ViewerQuote | null
} {
  const [menus, setMenus] = useState<ReadonlyArray<readonly [string, readonly MenuItem[]]>>([])
  const [source, setSource] = useState<ViewerSource | null>(null)
  const [quote, setQuote] = useState<ViewerQuote | null>(null)
  const value = useMemo<ViewerActionsValue>(
    () => ({
      // A renderer can hold another: the HTML source view is the text renderer inside the HTML one.
      setMenu: (owner, items) => {
        setMenus(previous => {
          const others = previous.filter(([id]) => id !== owner)
          return items ? [...others, [owner, items]] : others
        })
      },
      setSource,
      setQuote,
    }),
    [],
  )
  const menu = useMemo(() => menus.flatMap(([, items]) => items), [menus])
  return { value, menu, source, quote }
}

/**
 * Publishes a renderer's rows for the viewer's ⋯. The host re-renders only when what a row says changes, and a row always
 * runs the renderer's latest closure.
 */
export function useViewerMenu(items: readonly MenuItem[]): void {
  const host = useContext(ViewerActionsContext)
  const owner = useId()
  const latest = useRef(items)
  latest.current = items
  const shape = JSON.stringify(items.map(item => [item.id, item.label, item.checked === true, item.disabledReason ?? '']))
  useLayoutEffect(() => {
    if (!host) return undefined
    host.setMenu(
      owner,
      latest.current.map(item => ({
        ...item,
        onSelect: () => {
          latest.current.find(row => row.id === item.id)?.onSelect()
        },
      })),
    )
    return () => {
      host.setMenu(owner, null)
    }
  }, [host, owner, shape])
}

/** Publishes a renderer's source toggle; `undefined` while it has none. */
export function useViewerSource(showing: boolean | undefined, onToggle: () => void): void {
  const host = useContext(ViewerActionsContext)
  const latest = useRef(onToggle)
  latest.current = onToggle
  useLayoutEffect(() => {
    if (!host || showing === undefined) return undefined
    host.setSource({
      showing,
      onToggle: () => {
        latest.current()
      },
    })
    return () => {
      host.setSource(null)
    }
  }, [host, showing])
}

/** Publishes what 引用到对话 does in this renderer; `undefined` where it quotes nothing. */
export function useViewerQuote(ready: boolean | undefined, run: () => void): void {
  const host = useContext(ViewerActionsContext)
  const latest = useRef(run)
  latest.current = run
  useLayoutEffect(() => {
    if (!host || ready === undefined) return undefined
    host.setQuote({
      ready,
      run: () => {
        latest.current()
      },
    })
    return () => {
      host.setQuote(null)
    }
  }, [host, ready])
}
