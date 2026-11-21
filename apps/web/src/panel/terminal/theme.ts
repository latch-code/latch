import type { ITheme } from '@xterm/xterm'

/** A token as the page now resolves it (custom properties compute with their var() references substituted). */
const token = (style: CSSStyleDeclaration, name: string) => style.getPropertyValue(name).trim()

/**
 * A colour token as `#rrggbb`. The computed value of a custom property keeps functions such as light-dark() (the
 * palettes' canvas), which xterm cannot parse, so the colour is read back from a probe that paints with it.
 */
function color(element: Element, name: string): string {
  const probe = document.createElement('span')
  probe.hidden = true
  probe.style.color = `var(${name})`
  element.append(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()
  const channels = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(resolved)
  if (!channels) return token(getComputedStyle(element), name)
  return `#${channels
    .slice(1)
    .map(channel => Number(channel).toString(16).padStart(2, '0'))
    .join('')}`
}

/** Whether a resolved `#rrggbb` is dark: the canvas of the dark theme. */
function dark(hex: string): boolean {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex)
  if (!match) return false
  const [r, g, b] = match.slice(1).map(part => Number.parseInt(part, 16))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 128
}

/**
 * The terminal's colours from the design tokens, read again whenever the theme changes. The ink is the page's ink on its
 * canvas; selection is the page's text-selection tint; the sixteen colours come from the status and syntax hues, with
 * black and white swapped in the dark theme so neither vanishes into the background.
 */
export function terminalTheme(element: Element): ITheme & { fontFamily: string; fontSize: number } {
  const style = getComputedStyle(element)
  const canvas = color(element, '--canvas')
  const ink = token(style, '--ink')
  const night = dark(canvas)
  const black = night ? token(style, '--faint') : ink
  const white = night ? ink : token(style, '--faint')
  return {
    fontFamily: token(style, '--mono'),
    fontSize: Number.parseFloat(token(style, '--fs-term')) || 12.5,
    background: canvas,
    foreground: ink,
    cursor: ink,
    cursorAccent: canvas,
    selectionBackground: token(style, '--accent-soft'),
    selectionInactiveBackground: token(style, '--press'),
    scrollbarSliderBackground: token(style, '--scroll-thumb'),
    scrollbarSliderHoverBackground: token(style, '--scroll-thumb-hover'),
    scrollbarSliderActiveBackground: token(style, '--scroll-thumb-active'),
    black,
    red: token(style, '--red'),
    green: token(style, '--green'),
    yellow: token(style, '--amber'),
    blue: token(style, '--accent-ink'),
    magenta: token(style, '--syn-keyword'),
    cyan: token(style, '--syn-function'),
    white,
    brightBlack: token(style, '--muted'),
    brightRed: token(style, '--red'),
    brightGreen: token(style, '--green'),
    brightYellow: token(style, '--syn-string'),
    brightBlue: token(style, '--accent-ink'),
    brightMagenta: token(style, '--syn-keyword'),
    brightCyan: token(style, '--syn-function'),
    brightWhite: night ? ink : token(style, '--muted'),
  }
}
