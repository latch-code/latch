import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { LiveChanges, motionAllowed } from './changes.ts'
import { cx } from './internal.ts'
import { MOTION } from './motion.tsx'

/** Buttons of an arming drawer take nothing for this long after it appears (they arm after its arrival). */
const ARMING = 320

interface Place {
  capped: boolean
  front: boolean
  entering: boolean
  leaving: boolean
  onLeft: () => void
}
const StackPlace = createContext<Place | null>(null)

/**
 * Something that waits on the composer (an approval, a question, the queue), attached above its card inside a
 * `DrawerStack`. `arming` keeps what it holds inert for 320ms each time it comes to the front, so a click or a key meant
 * for what was there before cannot answer it; a capped drawer is inert too, until the stack opens.
 */
export function Drawer({
  tone = 'neutral',
  arming = false,
  secure = false,
  label,
  className,
  children,
}: {
  /** waiting: for what needs the person; the surface stays neutral and its contents say so in amber. */
  tone?: 'neutral' | 'waiting'
  arming?: boolean
  /** A security surface: the tokens are locked inside it (tokens.css). */
  secure?: boolean
  label?: string
  className?: string
  children: ReactNode
}) {
  const place = useContext(StackPlace)
  const capped = place?.capped ?? false
  const leaving = place?.leaving ?? false
  const front = place?.front ?? true
  const [armed, setArmed] = useState(!arming)
  const [arrival, setArrival] = useState(0)
  // The render before this effect runs must not take a press: an arrival lowers `armed` during render. In an open stack
  // a drawer behind the front one is not capped, so reaching the front is an arrival of its own.
  const [was, setWas] = useState({ capped, front })
  if (was.capped !== capped || was.front !== front) {
    setWas({ capped, front })
    if (arming && (was.capped !== capped || front)) {
      setArmed(false)
      setArrival(arrival + 1)
    }
  }
  useEffect(() => {
    if (!arming) {
      setArmed(true)
      return undefined
    }
    if (capped) return undefined
    const timer = setTimeout(() => {
      setArmed(true)
    }, ARMING)
    return () => {
      clearTimeout(timer)
    }
  }, [arming, capped, arrival])
  const inert = leaving || capped || !armed
  return (
    <div
      className={cx('ui-drawer', className)}
      role="group"
      aria-label={label}
      data-tone={tone}
      data-tint={tone === 'waiting' ? 'warn' : undefined}
      data-secure={secure ? '' : undefined}
      data-capped={capped ? '' : undefined}
      data-entering={place?.entering ? '' : undefined}
      data-leaving={leaving ? '' : undefined}
      onAnimationEnd={event => {
        if (event.target === event.currentTarget && leaving) place?.onLeft()
      }}>
      <div className="ui-drawer-body" inert={inert} data-arming={!armed ? '' : undefined}>
        {children}
      </div>
    </div>
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
 * The drawers attached to the composer: inset 20 and overlapping its card by 14 with a top radius of 16. Render it just
 * above the card and give the card a higher stacking order, so that drawers slide from behind it. The last child is the
 * front drawer; the others peek above it as 10px caps at 96% width, and the stack opens while the pointer or the focus
 * is inside it, or after a tap on a touch screen.
 *
 * A child that appears slides up over --m-panel and one that goes slides back over 70% of that, each only when the page
 * saw it happen (`LiveChanges`): a restore or a switch of session shows the stack at once, and reduced motion only
 * fades. Each child needs a stable key.
 */
export function DrawerStack({ className, children }: { className?: string; children: ReactNode }) {
  const epoch = useContext(LiveChanges)
  const elements = Children.toArray(children).filter((child): child is ReactElement => isValidElement(child))
  const keys = elements.map(element => String(element.key))
  const [shown, setShown] = useState<Shown[]>(() => keys.map(key => ({ key, leaving: false, entering: false })))
  const [seenEpoch, setSeenEpoch] = useState(epoch)
  const [open, setOpen] = useState(false)
  const stack = useRef<HTMLDivElement>(null)
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

  // Tapped open on a touch screen, it closes on the next press outside.
  useEffect(() => {
    if (!open) return undefined
    const press = (event: PointerEvent) => {
      if (event.pointerType === 'touch' && !(event.target instanceof Node && stack.current?.contains(event.target))) setOpen(false)
    }
    addEventListener('pointerdown', press)
    return () => {
      removeEventListener('pointerdown', press)
    }
  }, [open])

  const front = items.findLastIndex(item => !item.leaving)
  return (
    <div
      ref={stack}
      className={cx('ui-drawer-stack', className)}
      data-open={open ? '' : undefined}
      onPointerEnter={event => {
        if (event.pointerType !== 'touch') setOpen(true)
      }}
      onPointerLeave={event => {
        if (event.pointerType !== 'touch') setOpen(false)
      }}
      onPointerUp={event => {
        if (event.pointerType === 'touch') setOpen(true)
      }}
      onFocus={() => {
        setOpen(true)
      }}
      onBlur={event => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOpen(false)
      }}>
      {items.map((item, index) => (
        <StackPlace.Provider
          key={item.key}
          value={{
            capped: index !== front && !item.leaving && !open,
            front: index === front,
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
