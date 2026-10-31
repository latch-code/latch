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

/** The motion tokens of @latch/ui, as the page resolves them: each duration, its exit (70%) and each easing. */
export interface Tokens {
  micro: string
  enter: string
  panel: string
  sheet: string
  push: string
  microExit: string
  enterExit: string
  panelExit: string
  sheetExit: string
  pushExit: string
  eMicro: string
  eEnter: string
  ePanel: string
  eSheet: string
  ePush: string
  exit: string
}

/** The motion tokens, resolved through a probe element so they read exactly as computed styles report them. */
export const tokens = (page: Page): Promise<Tokens> =>
  page.evaluate(() => {
    const probe = document.createElement('div')
    document.body.append(probe)
    const duration = (value: string) => {
      probe.style.transitionDuration = value
      return getComputedStyle(probe).transitionDuration
    }
    const easing = (token: string) => {
      probe.style.transitionTimingFunction = `var(${token})`
      return getComputedStyle(probe).transitionTimingFunction
    }
    const result = {
      micro: duration('var(--m-micro)'),
      enter: duration('var(--m-enter)'),
      panel: duration('var(--m-panel)'),
      sheet: duration('var(--m-sheet)'),
      push: duration('var(--m-push)'),
      microExit: duration('calc(var(--m-micro) * 0.7)'),
      enterExit: duration('calc(var(--m-enter) * 0.7)'),
      panelExit: duration('calc(var(--m-panel) * 0.7)'),
      sheetExit: duration('calc(var(--m-sheet) * 0.7)'),
      pushExit: duration('calc(var(--m-push) * 0.7)'),
      eMicro: easing('--e-micro'),
      eEnter: easing('--e-enter'),
      ePanel: easing('--e-panel'),
      eSheet: easing('--e-sheet'),
      ePush: easing('--e-push'),
      exit: easing('--e-exit'),
    }
    probe.remove()
    return result
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
