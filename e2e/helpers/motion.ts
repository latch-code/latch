import type { Page } from '@playwright/test'

/** One transition or animation that started on the page, as the browser reports it. */
export interface Motion {
  kind: 'transition' | 'animation'
  /** The element's classes. */
  target: string
  /** The transitioned property, or the animation's name. */
  name: string
  duration: string
  easing: string
}

/** The duration and easing tokens of @latch/ui, as the page resolves them. */
export interface Tokens {
  fast: string
  base: string
  slow: string
  ease: string
  exit: string
}

/** The duration and easing tokens, resolved through a probe element so they read exactly as computed styles report them. */
export const tokens = (page: Page): Promise<Tokens> =>
  page.evaluate(() => {
    const probe = document.createElement('div')
    document.body.append(probe)
    const read = (duration: string, easing: string) => {
      probe.style.transition = `opacity var(${duration}) var(${easing})`
      const style = getComputedStyle(probe)
      return { duration: style.transitionDuration, easing: style.transitionTimingFunction }
    }
    const fast = read('--d-fast', '--ease')
    const base = read('--d-base', '--ease')
    const slow = read('--d-slow', '--ease-exit')
    probe.remove()
    return { fast: fast.duration, base: base.duration, slow: slow.duration, ease: fast.easing, exit: slow.easing }
  })

/** Every transition and animation that starts while `act` runs and for 400ms after it. */
export async function motions(page: Page, act: () => Promise<void>): Promise<Motion[]> {
  await page.evaluate(() => {
    const record: Motion[] = []
    Reflect.set(window, 'latchMotions', record)
    document.addEventListener(
      'transitionrun',
      event => {
        if (!(event.target instanceof Element)) return
        const style = getComputedStyle(event.target)
        const index = style.transitionProperty.split(', ').indexOf(event.propertyName)
        const pick = (list: string) => list.split(/,\s*(?![^(]*\))/u)[Math.max(0, index)] ?? list
        record.push({
          kind: 'transition',
          target: event.target.getAttribute('class') ?? event.target.tagName,
          name: event.propertyName,
          duration: pick(style.transitionDuration),
          easing: pick(style.transitionTimingFunction),
        })
      },
      true,
    )
    document.addEventListener(
      'animationstart',
      event => {
        if (!(event.target instanceof Element)) return
        const style = getComputedStyle(event.target)
        record.push({
          kind: 'animation',
          target: event.target.getAttribute('class') ?? event.target.tagName,
          name: event.animationName,
          duration: style.animationDuration,
          easing: style.animationTimingFunction,
        })
      },
      true,
    )
  })
  await act()
  await page.waitForTimeout(400)
  return page.evaluate(() => {
    const record: Motion[] = Reflect.get(window, 'latchMotions')
    return record
  })
}
