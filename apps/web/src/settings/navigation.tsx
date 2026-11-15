import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { IconButton, MOTION, ChevronLeftGlyph } from '@latch/ui'
import { useBackLayer } from '../hooks/backStack.ts'
import { BackLink } from './common.tsx'

/**
 * How a section shows the pages inside it (an agent's page, a list of the projects other devices may use). From
 * 768px a page replaces the section's content in place, with a way back above it. On phones each page is a level of
 * its own that slides in over the section with its own bar, exactly as a section slides in over the section list.
 */
export interface SettingsNavigation {
  phone: boolean
  /** The open section's name: the way back from its first page names it. */
  section: string
  /** Where phone pages are drawn, over the section. */
  layers: HTMLElement | null
  /**
   * How many pages the section has open, and the way back from the top one (on a phone, the bar's back and Escape). A
   * wide window names the section above its content only while none is open: a page names itself under its way back.
   */
  setDepth: (depth: number, back: (() => void) | undefined) => void
}

export const NavigationContext = createContext<SettingsNavigation>({
  phone: false,
  section: '',
  layers: null,
  setDepth: () => {},
})
export const SettingsNavigationProvider = NavigationContext.Provider

/** One page inside a section: its title (the phone bar's, and the next page's way back) and the way back from it. */
export interface SettingsLevel {
  key: string
  title: string
  content: ReactNode
  onBack: () => void
}

/** A phone page's place in the browser's history: going back there returns one level. */
function LevelEntry({ onBack }: { onBack: () => void }) {
  useBackLayer(true, onBack)
  return null
}

/** How long a phone page takes to slide away before it is dropped: --m-push, plus a frame. */
const LEAVE_MS = MOTION.push + 20

/**
 * A section's main content and the pages open inside it, the last one on top. Going back to the main content plays the
 * page entrance again, the same as opening a page does.
 */
export function SettingsPages({ main, levels }: { main: ReactNode; levels: SettingsLevel[] }) {
  const navigation = useContext(NavigationContext)
  const top = levels.at(-1)
  // A return to the main content draws it again, so it fades in as a page that was just opened.
  const [returns, setReturns] = useState(0)
  const [depth, setSeenDepth] = useState(levels.length)
  if (depth !== levels.length) {
    setSeenDepth(levels.length)
    if (levels.length === 0) setReturns(count => count + 1)
  }
  const { phone, setDepth } = navigation
  const back = top?.onBack
  useLayoutEffect(() => {
    setDepth(levels.length, back)
  }, [setDepth, levels.length, back])
  useLayoutEffect(
    () => () => {
      setDepth(0, undefined)
    },
    [setDepth],
  )

  if (!phone)
    return top ? (
      <div key={top.key} className="settings-subpage settings-enter">
        <BackLink label={levels.at(-2)?.title ?? navigation.section} onClick={top.onBack} />
        {top.content}
      </div>
    ) : (
      <div key={`main-${returns}`} className={returns > 0 ? 'settings-subpage settings-enter' : 'settings-subpage'}>
        {main}
      </div>
    )
  return (
    <>
      <div className="settings-subpage">{main}</div>
      {navigation.layers && (
        <>
          {levels.map(level => (
            <LevelEntry key={level.key} onBack={level.onBack} />
          ))}
          {createPortal(<PhoneLevels levels={levels} section={navigation.section} />, navigation.layers)}
        </>
      )}
    </>
  )
}

/**
 * The phone pages: the top one in place, the ones under it moved 24% left and hidden once covered, and one that was just
 * left sliding back out to the right before it goes. A new page slides in from the right (240ms); the bar's back
 * button returns one level. Focus goes to the new page's back button and, on the way back, to what opened the page.
 */
function PhoneLevels({ levels, section }: { levels: SettingsLevel[]; section: string }) {
  const [leaving, setLeaving] = useState<Array<{ level: SettingsLevel; index: number }>>([])
  const [shown, setShown] = useState(levels)
  if (shown !== levels) {
    const keys = new Set(levels.map(level => level.key))
    const gone = shown.flatMap((level, index) => (keys.has(level.key) ? [] : [{ level, index }]))
    setShown(levels)
    setLeaving(previous => [...previous.filter(entry => !keys.has(entry.level.key)), ...gone])
  }
  useEffect(() => {
    if (leaving.length === 0) return undefined
    const timer = setTimeout(() => {
      setLeaving([])
    }, LEAVE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [leaving])

  // What had focus when each level opened, to give it back when the person returns from that level.
  const openers = useRef(new Map<string, HTMLElement | null>())
  const backs = useRef(new Map<string, HTMLButtonElement | null>())
  const topKey = levels.at(-1)?.key
  const previousTop = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const before = previousTop.current
    previousTop.current = topKey
    if (topKey === before) return
    const deeper = topKey !== undefined && !openers.current.has(topKey)
    if (deeper) {
      openers.current.set(topKey, document.activeElement instanceof HTMLElement ? document.activeElement : null)
      backs.current.get(topKey)?.focus({ preventScroll: true })
      return
    }
    // Back: focus returns to what opened the level that was left.
    if (before !== undefined) {
      const opener = openers.current.get(before)
      openers.current.delete(before)
      if (opener?.isConnected) opener.focus({ preventScroll: true })
      else if (topKey !== undefined) backs.current.get(topKey)?.focus({ preventScroll: true })
    }
  }, [topKey])

  const entries = levels.map((level, index) => ({ level, index, gone: false }))
  for (const entry of leaving.toSorted((a, b) => a.index - b.index))
    entries.splice(Math.min(entry.index, entries.length), 0, { ...entry, gone: true })
  return entries.map(({ level, index, gone }) => {
    const state = gone ? 'leaving' : index === levels.length - 1 ? 'top' : 'under'
    const previous = index === 0 ? section : (levels[index - 1]?.title ?? section)
    return (
      <section key={level.key} className="settings-level" data-state={state} aria-label={level.title} inert={state !== 'top' || undefined}>
        <header className="settings-bar">
          <IconButton
            ref={element => {
              backs.current.set(level.key, element)
            }}
            label={`返回${previous}`}
            icon={ChevronLeftGlyph}
            onClick={level.onBack}
          />
          <h2>{level.title}</h2>
        </header>
        <div className="settings-scroll">
          <div className="settings-content">{level.content}</div>
        </div>
      </section>
    )
  })
}
