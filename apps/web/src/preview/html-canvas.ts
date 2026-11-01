/** Part of the opaque HTML frame: reads the installed document and never leaves that frame. */
import { DESKTOP_CANVAS, type FrameCanvas } from './types.ts'

export interface PageShape {
  canvas?: FrameCanvas
  stage?: HTMLElement
  slides: Element[]
}

const SLIDE_NAME = /(?:^|[-_])slides?(?:$|[-_])/iu
const MAX_RULES = 5000
const MAX_STAGE_DEPTH = 5
/** A title or footer beside the slides; a page with more words than this outside them is a document that holds slides. */
const MAX_TEXT_BESIDE = 120

const named = (element: Element) => [...element.classList, element.id].some(name => SLIDE_NAME.test(name))
// Only the block axis: `overflow-x: hidden` is how long pages stop sideways scrolling, and they still scroll.
const clipped = (element: Element) => /hidden|clip/u.test(getComputedStyle(element).overflowY)
const rootClipped = () => clipped(document.documentElement) || (document.body !== null && clipped(document.body))

const textLength = (element: HTMLElement) => element.innerText.replace(/\s+/gu, '').length
/** Whether these elements are the page. Text the page hides counts on neither side, so hidden slides do not tip it. */
function holdsThePage(elements: Element[]): boolean {
  const inside = elements.reduce((total, element) => total + (element instanceof HTMLElement ? textLength(element) : 0), 0)
  return textLength(document.body) - inside <= MAX_TEXT_BESIDE
}

function styleRules(rules: CSSRuleList, found: CSSStyleRule[]): void {
  for (const rule of rules) {
    if (found.length >= MAX_RULES) return
    if (rule instanceof CSSStyleRule) found.push(rule)
    // A print sheet declares paper, not the page on screen.
    else if (rule instanceof CSSMediaRule && matchMedia(rule.media.mediaText).matches) styleRules(rule.cssRules, found)
    else if (rule instanceof CSSSupportsRule) styleRules(rule.cssRules, found)
  }
}

/** The authored size, whatever the frame is now: a stage in a wide panel is as fixed as one overflowing a narrow panel. */
function declaredSize(style: CSSStyleDeclaration, element: Element): FrameCanvas | undefined {
  const read = (value: string, used: string) => {
    if (/^\d+(?:\.\d+)?px$/u.test(value)) return Number.parseFloat(value)
    return value.includes('var(') ? Number.parseFloat(used) || 0 : 0
  }
  const computed = getComputedStyle(element)
  const width = Math.round(read(style.width, computed.width)),
    height = Math.round(read(style.height, computed.height))
  const ratio = width / height
  return width >= 800 && width <= 7680 && height >= 400 && height <= 4320 && ratio >= 1.2 && ratio <= 2.4 ? { width, height } : undefined
}

function shallow(element: Element): boolean {
  let depth = 0
  for (let at: Element | null = element; at && at !== document.body; at = at.parentElement) if (++depth > MAX_STAGE_DEPTH) return false
  return element !== document.documentElement
}

function findStage(): { canvas: FrameCanvas; stage: HTMLElement } | undefined {
  const rules: CSSStyleRule[] = []
  for (const sheet of document.styleSheets) styleRules(sheet.cssRules, rules)
  const sources: Array<[HTMLElement[], CSSStyleDeclaration]> = []
  for (const rule of rules) {
    if (!rule.style.width || !rule.style.height) continue
    try {
      sources.push([[...document.querySelectorAll<HTMLElement>(rule.selectorText)], rule.style])
    } catch {
      /* A selector this browser does not read matches nothing. */
    }
  }
  for (const element of document.querySelectorAll<HTMLElement>('[style]')) sources.push([[element], element.style])
  let best: { canvas: FrameCanvas; stage: HTMLElement } | undefined
  for (const [elements, style] of sources) {
    const placed = elements.filter(shallow)
    const shown = placed.filter(element => {
      const computed = getComputedStyle(element)
      return computed.display !== 'none' && computed.visibility !== 'hidden'
    })
    // Slides may all start hidden for a script to reveal; any other hidden element, such as a closed dialog, is not the page.
    const slideRule = placed.filter(named).length >= 2
    const element = shown[0] ?? (slideRule ? placed[0] : undefined)
    if (!element) continue
    const canvas = declaredSize(style, element)
    if (!canvas || (best && best.canvas.width * best.canvas.height >= canvas.width * canvas.height)) continue
    const position = getComputedStyle(element).position
    const holdsSlides =
      slideRule || [...element.children].filter(named).length >= 2 || element.querySelectorAll('[class*="slide" i]').length >= 2
    const outOfFlow = position === 'absolute' || position === 'fixed'
    // Repeated charts are as large as slides, so unnamed blocks need more than a pair to read as pages.
    if (
      rootClipped()
      || ((holdsSlides || outOfFlow || shown.length >= 3) && holdsThePage(slideRule || shown.length >= 3 ? shown : [element]))
    )
      best = { canvas, stage: element }
  }
  return best
}

function slideGroup(): Element[] {
  for (const container of [document.documentElement, document.body, ...document.body.children]) {
    if (getComputedStyle(container).scrollSnapType === 'none') continue
    const children = [...(container === document.documentElement ? document.body : container).children].filter(
      child => !['script', 'style'].includes(child.localName),
    )
    if (children.length >= 2) return children
  }
  const parents = new Set<Element>()
  for (const element of document.querySelectorAll('[class*="slide" i], [id*="slide" i]')) {
    if (named(element) && element.parentElement) parents.add(element.parentElement)
    if (named(element) && element.children.length >= 2) parents.add(element)
  }
  for (const parent of parents) {
    const slides = named(parent) ? [...parent.children] : [...parent.children].filter(named)
    if (slides.length >= 2) return slides
  }
  return []
}

/** Reads what kind of page this is. A page that is not a presentation keeps the panel's width, where it reflows as written. */
export function readPageShape(): PageShape {
  const stage = findStage()
  const slides = slideGroup()
  if (stage) return { ...stage, slides }
  if (slides.length === 0) return { slides }
  const shown = slides.find(slide => slide instanceof HTMLElement && slide.offsetWidth > 0 && slide.offsetHeight > 0) as
    | HTMLElement
    | undefined
  const fills = shown !== undefined && shown.offsetWidth >= innerWidth * 0.9 && shown.offsetHeight >= innerHeight * 0.9
  // Nothing shown yet means a script reveals the slides, which only a deck that is the whole page leaves to it.
  return (fills || rootClipped() || !shown) && holdsThePage(slides) ? { canvas: DESKTOP_CANVAS, slides } : { slides }
}

const REVEALING = ['active', 'current', 'is-active', 'visible', 'show', 'present', 'selected']

/** Whether a person can see this slide now: decks hide slides by display, visibility, opacity or by moving them away. */
function inView(slide: Element): boolean {
  if (!(slide instanceof HTMLElement) || slide.offsetWidth === 0 || slide.offsetHeight === 0) return false
  const style = getComputedStyle(slide)
  if (style.visibility === 'hidden' || (Number(style.opacity) < 0.05 && slide.getAnimations().length === 0)) return false
  const box = slide.getBoundingClientRect()
  return box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight
}

function reveal(slide: Element): void {
  if (!(slide instanceof HTMLElement)) return
  slide.style.removeProperty('display')
  if (inView(slide)) return
  // A running transition reports the old value right after the class changes, and would show this slide half faded.
  const transition = slide.style.getPropertyValue('transition')
  slide.style.setProperty('transition', 'none')
  const name = REVEALING.find(candidate => {
    slide.classList.add(candidate)
    if (inView(slide)) return true
    slide.classList.remove(candidate)
    return false
  })
  if (!name) {
    // The deck's own switch is in a script that is not running, under a name no one can guess.
    if (getComputedStyle(slide).display === 'none') slide.style.setProperty('display', 'block', 'important')
    for (const [property, value] of [
      ['visibility', 'visible'],
      ['opacity', '1'],
      ['transform', 'none'],
      ['translate', 'none'],
    ] as const)
      slide.style.setProperty(property, value, 'important')
  }
  // Styles apply before the transition returns, so nothing animates from the hidden state.
  slide.getBoundingClientRect()
  slide.style.setProperty('transition', transition)
}

function conceal(slide: Element): void {
  if (!(slide instanceof HTMLElement)) return
  slide.classList.remove(...REVEALING)
  slide.style.setProperty('display', 'none', 'important')
}

/** Shows one slide of a static deck, the way the deck's script would have. */
export function showSlide(slides: Element[], index: number): void {
  slides.forEach((slide, at) => {
    if (at !== index) conceal(slide)
  })
  reveal(slides[index]!)
}

/** Slides a person can already reach by scrolling need no paging from us. */
function scrolledThrough(slides: Element[]): boolean {
  const container = slides[0]?.parentElement
  if (!container || !document.scrollingElement) return false
  const snaps = [document.documentElement, document.body, container].some(element => getComputedStyle(element).scrollSnapType !== 'none')
  const style = getComputedStyle(container)
  const inner =
    (/auto|scroll/u.test(style.overflowY) && container.scrollHeight > container.clientHeight + 1)
    || (/auto|scroll/u.test(style.overflowX) && container.scrollWidth > container.clientWidth + 1)
  return snaps || inner || (!rootClipped() && document.scrollingElement.scrollHeight > innerHeight + 1)
}

/**
 * A static page never runs the script that would place and reveal its slides. Bring a stage positioned only by that
 * script's translate back into view and show a slide, without touching the document's own rules. Returns the slide in
 * view when the deck shows one at a time: those slides can only be reached if the frame pages through them.
 */
export function settleStaticPage({ canvas, stage, slides }: PageShape, wanted: number): number | undefined {
  if (!canvas) return undefined
  if (stage && ['absolute', 'fixed'].includes(getComputedStyle(stage).position)) {
    const box = stage.getBoundingClientRect()
    if (box.width <= innerWidth + 1 && box.height <= innerHeight + 1 && (box.right > innerWidth + 1 || box.bottom > innerHeight + 1))
      stage.style.translate = `${-box.left}px ${-box.top}px`
  }
  if (slides.length === 0) return undefined
  if (!slides.some(inView)) reveal(slides[0]!)
  if (slides.length < 2 || slides.filter(inView).length > 1 || scrolledThrough(slides)) return undefined
  const index = wanted > 0 ? Math.min(wanted, slides.length - 1) : Math.max(0, slides.findIndex(inView))
  showSlide(slides, index)
  return index
}
