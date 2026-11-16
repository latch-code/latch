import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react'
import { LiveChanges, motionAllowed } from './changes.ts'
import { cx } from './internal.ts'
import { MOTION } from './motion.tsx'

interface Place {
  entering: boolean
  leaving: boolean
  onLeft: () => void
}
const StackPlace = createContext<Place | null>(null)

/**
 * Something that waits on the composer (an approval, a question, the queue, a note about the next message): a card
 * docked above the composer's card, in a `DrawerStack`. It has the modal radius and the composer's own lift. It slides
 * up when the page saw it arrive and back down as it goes; a security surface (`secure`) only appears and goes, never
 * moving or fading, and what waits keeps its own words and glyph in amber. Whether its buttons take a press yet (they
 * arm after it arrives) is the page's to say. The rest of the props go on the card itself.
 */
export function Drawer({
  secure = false,
  label,
  className,
  children,
  ...props
}: Omit<ComponentProps<'section'>, 'aria-label'> & {
  /** A security surface: the tokens are locked inside it (tokens.css) and its look is pinned (the page's security layer). */
  secure?: boolean
  label: string
  children: ReactNode
}) {
  const place = useContext(StackPlace)
  const leaving = place?.leaving ?? false
  // A security surface is taken away at once: nothing of it stays behind to fade.
  useLayoutEffect(() => {
    if (secure && leaving) place?.onLeft()
  }, [secure, leaving, place])
  return (
    <section
      {...props}
      className={cx('ui-drawer', className)}
      aria-label={label}
      data-secure={secure ? '' : undefined}
      data-entering={place?.entering && !secure ? '' : undefined}
      data-leaving={leaving && !secure ? '' : undefined}
      inert={leaving || props.inert}
      onAnimationEnd={event => {
        props.onAnimationEnd?.(event)
        if (event.target === event.currentTarget && leaving) place?.onLeft()
      }}>
      {children}
    </section>
  )
}

type Shown = { key: string; leaving: boolean; entering: boolean }

/** The next list after the children changed; the same list when nothing about it did. */
function reconcile(shown: Shown[], keys: string[], live: boolean): Shown[] {
  const next: Shown[] = keys.map(key => shown.find(item => item.key === key && !item.leaving) ?? { key, leaving: false, entering: live })
  // What has gone stays where it stood until its exit has played; a change the page did not see just takes it away.
  if (live) {
    shown.forEach((item, index) => {
      if (!keys.includes(item.key))
        next.splice(Math.min(index, next.length), 0, item.leaving ? item : { ...item, leaving: true, entering: false })
    })
  }
  return next.length === shown.length && next.every((item, index) => item === shown[index]) ? shown : next
}

/**
 * The drawers docked above the composer, in order, the last nearest the card, 8px apart and 8px above it. Render it
 * just above the card. Every drawer is shown whole: nothing peeks, and nothing opens on hover. A child that appears
 * slides up over --m-panel and one that goes slides back over 70% of that, each only when the page saw it happen
 * (`LiveChanges`): a restore or a switch of session shows the stack at once, and reduced motion only fades. Each child
 * needs a stable key.
 */
export function DrawerStack({ className, children }: { className?: string; children: ReactNode }) {
  const epoch = useContext(LiveChanges)
  const elements = Children.toArray(children).filter((child): child is ReactElement => isValidElement(child))
  const keys = elements.map(element => String(element.key))
  const [shown, setShown] = useState<Shown[]>(() => keys.map(key => ({ key, leaving: false, entering: false })))
  const [seenEpoch, setSeenEpoch] = useState(epoch)
  // The last element of each child, which is what a child that has gone still shows while it leaves.
  const last = useRef(new Map<string, ReactElement>())
  useLayoutEffect(() => {
    for (const element of elements) last.current.set(String(element.key), element)
    for (const key of last.current.keys()) if (!shown.some(item => item.key === key) && !keys.includes(key)) last.current.delete(key)
  })

  const live = epoch !== null && seenEpoch === epoch && motionAllowed()
  if (seenEpoch !== epoch) setSeenEpoch(epoch)
  const items = reconcile(shown, keys, live)
  if (items !== shown) setShown(items)

  const leaving = items
    .filter(item => item.leaving)
    .map(item => item.key)
    .join(' ')
  // An exit that never reports its end (the stack hidden, an animation overridden) still completes.
  useEffect(() => {
    if (!leaving) return undefined
    const timer = setTimeout(() => {
      setShown(list => list.filter(item => !item.leaving))
    }, MOTION.panelExit + 200)
    return () => {
      clearTimeout(timer)
    }
  }, [leaving])

  return (
    <div className={cx('ui-drawer-stack', className)} data-empty={items.length === 0 ? '' : undefined}>
      {items.map(item => (
        <StackPlace.Provider
          key={item.key}
          value={{
            entering: item.entering,
            leaving: item.leaving,
            onLeft: () => {
              setShown(list => list.filter(other => other.key !== item.key || !other.leaving))
            },
          }}>
          {elements.find(element => String(element.key) === item.key) ?? last.current.get(item.key)}
        </StackPlace.Provider>
      ))}
    </div>
  )
}
