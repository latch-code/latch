import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore, type RefObject } from 'react'

/**
 * Which waiting approval cards show in the conversation's scroller right now. The bar above the input says
 * 「N 项待批准」 in amber only while none does, because a card in view already says so itself.
 */
export interface ApprovalVisibility {
  /** A card reports whether it shows (by at least a pixel), and forgets itself as it goes. */
  report: (id: string, shown: boolean) => void
  forget: (id: string) => void
  subscribe: (listener: () => void) => () => void
  /** Whether any reported card shows; undefined while none has reported. */
  inView: () => boolean | undefined
}

export function createApprovalVisibility(): ApprovalVisibility {
  const cards = new Map<string, boolean>()
  const listeners = new Set<() => void>()
  let value: boolean | undefined
  const update = () => {
    const next = cards.size === 0 ? undefined : [...cards.values()].some(Boolean)
    if (next === value) return
    value = next
    for (const listener of listeners) listener()
  }
  return {
    report: (id, shown) => {
      cards.set(id, shown)
      update()
    },
    forget: id => {
      cards.delete(id)
      update()
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    inView: () => value,
  }
}

export const ApprovalVisibilityContext = createContext<ApprovalVisibility | null>(null)

/** The page's store of which waiting cards show, made once. */
export function useApprovalVisibility(): ApprovalVisibility {
  const [store] = useState(createApprovalVisibility)
  return store
}

/** Whether any waiting approval card shows; undefined while none has reported (none is rendered yet). */
export function useApprovalsInView(store: ApprovalVisibility): boolean | undefined {
  return useSyncExternalStore(store.subscribe, store.inView, store.inView)
}

/**
 * For a waiting approval's card: reports whether it shows in the scroller around it, first from where it is as it
 * appears (before the page paints) and then as the observer sees it move in and out.
 */
export function useReportApprovalVisibility(card: RefObject<HTMLElement | null>, id: string | undefined): void {
  const store = useContext(ApprovalVisibilityContext)
  useLayoutEffect(() => {
    const element = card.current
    if (!store || id === undefined || !element) return undefined
    const root = element.closest<HTMLElement>('.transcript')
    const box = element.getBoundingClientRect()
    const frame = root?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight)
    store.report(id, box.bottom > frame.top && box.top < frame.bottom && box.right > frame.left && box.left < frame.right)
    if (typeof IntersectionObserver !== 'function')
      return () => {
        store.forget(id)
      }
    const observer = new IntersectionObserver(
      entries => {
        const entry = entries.at(-1)
        if (entry) store.report(id, entry.isIntersecting)
      },
      { root },
    )
    observer.observe(element)
    return () => {
      observer.disconnect()
      store.forget(id)
    }
  }, [store, id, card])
}
