import { motionAllowed } from './changes.ts'
import { EASING, MOTION } from './motion.tsx'
import { onStreamingLayer } from './stream.ts'

/*
 * The named moves of the interface, for a change the Host reported: a row arriving or leaving, a resolved card wiped
 * away while what is under it rises, a row changing lane, a layout cross-fading, a menu's items arriving in turn, a
 * sent message lifting out of the input, the light across a finished action. Rules they all keep:
 *
 * - Only transform and opacity move, through the Web Animations API, so the compositor runs them and no layout or
 *   paint is caused; a position change is a FLIP with one measurement before and one after.
 * - Interruptible: a move that starts while another runs on the same element starts from where that one is, and the
 *   old one is cancelled. Nothing waits for an animation to finish before the next can start.
 * - Reduced motion (the system's, or 减弱 on this device): the change shows at once or with a fade of 120ms at most;
 *   nothing travels.
 * - Never on a layer where text is streaming (stream.ts): there the change just shows.
 * - Never on or inside a security surface (`[data-secure]`): what an approval, a confirmation or a pairing shows does
 *   not move, fade or flash once it is there; such a change just shows too.
 * - Nothing here is optimistic: a caller plays a move when the Host's event or receipt has arrived.
 */

/** The id every move's animation carries, so an interruption cancels moves only. */
const MOVE = 'ui-move'

/** --rise of tokens.css, and twice that for what comes up from below; a test keeps them equal to the token. */
export const RISE = 4
const PILL_RISE = RISE * 2

type Pose = Keyframe & { opacity: string; transform: string }

/** Every move on `element`, those that ended and still hold it (an exit keeps what left hidden) included. */
const ours = (element: Element) => element.getAnimations().filter(item => item.id === MOVE)
const running = (element: Element) => ours(element).filter(item => item.playState !== 'finished')

/** Stops the moves on `element` and returns where they had brought it, for the next one to start from. */
function interrupt(element: Element): Pose | null {
  const active = ours(element)
  if (active.length === 0) return null
  const style = getComputedStyle(element)
  const pose = { opacity: style.opacity, transform: style.transform }
  for (const item of active) item.cancel()
  return pose
}

const canAnimate = (element: Element) =>
  element.isConnected
  && typeof element.animate === 'function'
  && !onStreamingLayer(element)
  && element.closest('[data-secure]') === null
  && element.querySelector('[data-secure]') === null

function play(element: Element, frames: Keyframe[], timing: KeyframeAnimationOptions): Animation {
  return element.animate(frames, { ...timing, id: MOVE })
}

/** Resolves true when `animation` ran to its end, false when a later move interrupted it. */
const ended = (animation: Animation): Promise<boolean> =>
  animation.finished.then(
    () => true,
    () => false,
  )

/** Whether a move is running on `element` (a test and a caller that defers work until it is still can ask). */
export const moving = (element: Element): boolean => running(element).length > 0

/**
 * row-enter. A row, a message or a tool line arrives: it fades in over 160ms while it rises 4px. `pill` is the
 * entrance of what comes up from below (回到最新, a new item in the waiting strip): 8px, on the spring over 420ms.
 * Reduced motion keeps the fade alone.
 */
export function enter(element: HTMLElement, { pill = false }: { pill?: boolean } = {}): Animation | null {
  if (!canAnimate(element)) return null
  const from = interrupt(element)
  if (!motionAllowed())
    return play(element, [{ opacity: from?.opacity ?? '0' }, { opacity: '1' }], { duration: MOTION.micro, easing: 'linear' })
  return play(
    element,
    [from ?? { opacity: '0', transform: `translateY(${pill ? PILL_RISE : RISE}px)` }, { opacity: '1', transform: 'none' }],
    pill ? { duration: MOTION.settle, easing: EASING.spring } : { duration: MOTION.enter, easing: EASING.enter },
  )
}

/**
 * row-exit. What leaves fades out over 112ms on the exit curve, sinking 4px, and stays hidden until the caller takes
 * it away. Resolves true when it has left, false when an `enter` brought it back meanwhile (then it must stay).
 */
export function exit(element: HTMLElement): Promise<boolean> {
  if (!canAnimate(element)) return Promise.resolve(true)
  const from = interrupt(element)
  const reduced = !motionAllowed()
  const animation = play(
    element,
    reduced
      ? [{ opacity: from?.opacity ?? '1' }, { opacity: '0' }]
      : [from ?? { opacity: '1', transform: 'none' }, { opacity: '0', transform: `translateY(${RISE}px)` }],
    { duration: reduced ? MOTION.microExit : MOTION.enterExit, easing: reduced ? 'linear' : EASING.exit, fill: 'forwards' },
  )
  return ended(animation)
}

/**
 * FLIP. `elements` are measured once, `change` changes the document (a row removed, a list re-sorted), they are
 * measured once more and each slides from where it was to where it is, 200ms on the spring. An element already moving
 * is measured where it is, so the new slide starts there. Above `limit` elements, with reduced motion or on a
 * streaming layer the change just shows.
 */
export function flip(
  elements: Iterable<HTMLElement>,
  change: () => void,
  { duration = MOTION.panel, easing = EASING.spring, limit = 12 }: { duration?: number; easing?: string; limit?: number } = {},
): Animation[] {
  const all = [...elements]
  const moved = all.length <= limit && motionAllowed() ? all.filter(canAnimate) : []
  const first = moved.map(element => element.getBoundingClientRect())
  for (const element of all) for (const item of running(element)) item.cancel()
  change()
  const animations: Animation[] = []
  moved.forEach((element, index) => {
    if (!canAnimate(element)) return
    const last = element.getBoundingClientRect()
    const dx = first[index]!.left - last.left
    const dy = first[index]!.top - last.top
    if (dx === 0 && dy === 0) return
    animations.push(play(element, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration, easing }))
  })
  return animations
}

/** The cards being wiped, so a second receipt for the same card does not start a second cover. */
const resolving = new WeakMap<Element, Promise<void>>()

/**
 * resolve. The Host's receipt for a decision has arrived: a cover in the surface colour crosses the card in 140ms,
 * `remove` takes the card away, and `followers` (the cards and sections under it) rise into its place on the spring.
 * The card's words never move or change; the cover is one block. With reduced motion, or for a card on a streaming
 * layer, the card is taken away at once. Resolves when the card is gone.
 */
export function resolveAndRise(card: HTMLElement, followers: Iterable<HTMLElement>, remove: () => void): Promise<void> {
  const pending = resolving.get(card)
  if (pending) return pending
  const rest = [...followers]
  if (!motionAllowed() || !canAnimate(card)) {
    flip(rest, remove)
    return Promise.resolve()
  }
  const cover = document.createElement('i')
  cover.className = 'ui-wipe'
  cover.setAttribute('aria-hidden', 'true')
  card.setAttribute('data-resolving', '')
  card.append(cover)
  const done = ended(
    play(cover, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: MOTION.wipe, easing: EASING.exit, fill: 'forwards' }),
  ).then(() => {
    resolving.delete(card)
    flip(rest, () => {
      cover.remove()
      card.removeAttribute('data-resolving')
      remove()
    })
  })
  resolving.set(card, done)
  return done
}

/**
 * move-lane. A row goes from one lane to another (进行中 → 可交付): it leaves where it was (112ms), `move` changes the
 * document and returns the row in its new lane, the rows of both lanes close and open the gap (200ms on the spring),
 * and the row arrives (160ms). Nothing flies across the screen. Reduced motion: the row is simply in its new lane.
 */
export async function moveLane(row: HTMLElement, others: Iterable<HTMLElement>, move: () => HTMLElement | null | void): Promise<void> {
  const rest = [...others]
  if (!motionAllowed() || !canAnimate(row)) {
    move()
    return
  }
  const left = await exit(row)
  // An `enter` brought the row back while it was leaving: the change was withdrawn, so nothing moves.
  if (!left) return
  let arrived: HTMLElement | null | void = null
  flip(rest, () => {
    arrived = move()
  })
  // The row's exit still holds it hidden: its arrival starts from there, and a row that stayed in place shows again.
  if (arrived !== row) for (const item of ours(row)) item.cancel()
  if (arrived) enter(arrived)
}

/** The view transition running for a cross-fade, so the next one can take over from it. */
let fading: ViewTransition | null = null

/**
 * layout-switch. `apply` changes the page (侧栏 ⇄ 顶栏) and the window cross-fades as a whole, 160ms; the page under
 * it, its focus, draft and scroll position are untouched. A second switch while one fades skips the rest of the first.
 * `mark` names a data attribute the root carries meanwhile besides `data-cross-fade`. Without view transitions, the
 * change shows at once. Reduced motion or a visible security surface skips the snapshot and follows any queued update.
 * `apply` must change the document synchronously (React: `flushSync`).
 */
export function crossFade(apply: () => void, mark?: string): Promise<void> {
  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function') {
    apply()
    return Promise.resolve()
  }
  const previous = fading
  previous?.skipTransition()
  if (
    !motionAllowed()
    || [...document.querySelectorAll('[data-secure]')].some(element =>
      element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
    )
  ) {
    // A skipped transition can still have its document update queued. Keep it from overwriting this change.
    if (previous) return previous.updateCallbackDone.then(apply, apply)
    apply()
    return Promise.resolve()
  }
  const root = document.documentElement
  root.dataset.crossFade = ''
  if (mark) root.dataset[mark] = ''
  const transition = document.startViewTransition(apply)
  fading = transition
  // A transition that is skipped rejects `ready`; the change itself has still been applied.
  transition.ready.catch(() => {})
  return transition.finished
    .catch(() => {})
    .then(() => {
      if (fading !== transition) return
      fading = null
      delete root.dataset.crossFade
      if (mark) delete root.dataset[mark]
    })
}

/**
 * menu. The items of a menu that has just opened arrive in turn, 18ms apart, each fading in over 160ms as it rises
 * 4px; only the first `limit` take part and the rest are simply there. Reduced motion: the items are there (the
 * menu's own fade is its stylesheet's).
 */
export function stagger(items: Iterable<HTMLElement>, { limit = 8 }: { limit?: number } = {}): Animation[] {
  if (!motionAllowed()) return []
  return [...items]
    .slice(0, limit)
    .filter(canAnimate)
    .map((item, index) => {
      const from = interrupt(item)
      return play(item, [from ?? { opacity: '0', transform: `translateY(${RISE}px)` }, { opacity: '1', transform: 'none' }], {
        duration: MOTION.enter,
        delay: MOTION.stagger * index,
        easing: EASING.enter,
        fill: 'backwards',
      })
    })
}

/**
 * send-lift. The sent message rises from the input (`from`, the rectangle its words had there, read before the input
 * was cleared) to its place in the conversation, 320ms on the settle curve, so the person sees where it went. The
 * input is already empty and can be typed in. Reduced motion: the message is simply in the conversation.
 */
export function sendLift(message: HTMLElement, from: { left: number; top: number }): Animation | null {
  if (!motionAllowed() || !canAnimate(message)) return null
  interrupt(message)
  const to = message.getBoundingClientRect()
  return play(
    message,
    [
      { opacity: '0.4', transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` },
      { opacity: '1', transform: 'none' },
    ],
    { duration: MOTION.push, easing: EASING.settle },
  )
}

/**
 * done-sheen. The action of `control` is really done (its receipt arrived): one light crosses it from the start to the
 * end, 480ms, once. A call while it crosses is ignored; it never plays for a failure (the caller does not call it),
 * with reduced motion or on a security surface, whose controls do not flash.
 */
export function sheenOnce(control: HTMLElement): Animation | null {
  if (!motionAllowed() || !canAnimate(control)) return null
  if (control.querySelector(':scope > .ui-sheen')) return null
  const light = document.createElement('i')
  light.className = 'ui-sheen'
  light.setAttribute('aria-hidden', 'true')
  const band = document.createElement('i')
  light.append(band)
  control.append(light)
  const animation = play(band, [{ transform: 'translateX(-120%)' }, { transform: 'translateX(300%)' }], {
    duration: MOTION.sheen,
    easing: EASING.micro,
  })
  void ended(animation).then(() => {
    light.remove()
  })
  return animation
}
