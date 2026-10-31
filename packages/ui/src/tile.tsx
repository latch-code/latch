import { useRef } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ICON_STROKE } from './icon.tsx'
import { cx } from './internal.ts'
import { usePausedOffscreen } from './motion.tsx'

export type TileSize = 16 | 20 | 24 | 32 | 40 | 56
/**
 * How ready an agent or model is, drawn on the tile itself; ready (the default) adds nothing. cold: not usable (its
 * command is missing, for example), at 40% and in greyscale. arriving: starting or being checked, at 70% in greyscale
 * inside a 2px progress ring 2px out (determinate with `progress`, otherwise turning once every 1.4s; it pauses out of
 * view and stands still under reduced motion). failed: an 8px red dot on the top-right corner, cut out of the surface.
 */
export type TileState = 'ready' | 'cold' | 'arriving' | 'failed'

/**
 * A brand's mark, from a file the page ships with, never inlined as markup. A coloured mark is placed as it is, and
 * `dark` names the brand's own file for the dark theme where it has one. A one-colour mark (`mono`) is the brand's
 * one-colour reproduction, drawn in ink through a CSS mask, so it reads near-black in the light theme and soft white in
 * the dark one. `tile` marks the brand's own app icon, which brings its background and its shape: it shows as it is,
 * without the surface, the ring or the tile's corners. `margin` marks a file that already holds a wide margin around
 * the mark: it spans the tile instead of sitting at 72%.
 */
export interface TileMark {
  src: string
  mono?: boolean
  dark?: string
  tile?: boolean
  margin?: boolean
}

/** A URL as a CSS string, for the mask of a one-colour mark. */
const cssUrl = (src: string) => `url("${src.replace(/[\n\r\f]/gu, '').replace(/["\\]/gu, character => `\\${character}`)}")`

/** The squircle radius of every tile: round(size × 0.225). */
const radius = (size: number) => Math.round(size * 0.225)

/**
 * The progress ring's path, clockwise from 12 o'clock, so a share of it reads from the top as on a clock face: a
 * rounded square of side `side` and corners `r`, drawn from (1, 1) so the 2px stroke stays inside the box.
 */
function ringPath(side: number, r: number): string {
  const [start, end, middle] = [1, 1 + side, 1 + side / 2]
  return [
    `M ${middle} ${start}`,
    `H ${end - r}`,
    `A ${r} ${r} 0 0 1 ${end} ${start + r}`,
    `V ${end - r}`,
    `A ${r} ${r} 0 0 1 ${end - r} ${end}`,
    `H ${start + r}`,
    `A ${r} ${r} 0 0 1 ${start} ${end - r}`,
    `V ${start + r}`,
    `A ${r} ${r} 0 0 1 ${start + r} ${start}`,
    `H ${middle}`,
  ].join(' ')
}

function Mark({ mark }: { mark: TileMark }) {
  if (mark.mono) return <span className="ui-tile-mark" style={{ maskImage: cssUrl(mark.src) }} />
  if (!mark.dark) return <img src={mark.src} alt="" draggable={false} />
  // The brand's light and dark files; the stylesheet shows the one for the page's theme.
  return (
    <>
      <img src={mark.src} alt="" draggable={false} data-theme-art="light" />
      <img src={mark.dark} alt="" draggable={false} data-theme-art="dark" />
    </>
  )
}

/** What the tile shows: a brand's mark, or a glyph where the thing has no icon of its own. Never a letter. */
export type TileArt = { mark: TileMark; icon?: undefined } | { icon: LucideIcon; mark?: undefined }

/** The tile holds a glyph at 60% of its size; a plain tile is the glyph alone. */
const glyphSize = (size: TileSize, plain: boolean) => (plain ? size : size * 0.6)

/** A glyph's stroke follows the icon scale; in the smallest tiles it is 2.2, so a 10px glyph still reads. */
const glyphStroke = (size: TileSize, plain: boolean) => (size <= 16 && !plain ? 2.2 : ICON_STROKE[16])

function Glyph({ icon: Drawn, size, strokeWidth }: { icon: LucideIcon; size: number; strokeWidth: number }) {
  return <Drawn size={size} strokeWidth={strokeWidth} aria-hidden="true" />
}

/** The progress ring around an arriving tile; its arc pauses out of view. */
function ProgressRing({ size, progress }: { size: TileSize; progress: number | undefined }) {
  const own = useRef<SVGSVGElement>(null)
  usePausedOffscreen(own)
  // The ring's 2px stroke is centred 3px outside the tile, which leaves a 2px gap; the box reaches 4px out to hold it.
  const ring = size + 8
  return (
    <svg
      ref={own}
      className="ui-tile-progress"
      width={ring}
      height={ring}
      viewBox={`0 0 ${ring} ${ring}`}
      data-determinate={progress === undefined ? undefined : ''}>
      <rect className="ui-tile-progress-track" x="1" y="1" width={size + 6} height={size + 6} rx={radius(size) + 3} />
      <path
        className="ui-tile-progress-arc"
        d={ringPath(size + 6, radius(size) + 3)}
        pathLength="100"
        strokeDasharray={progress === undefined ? '25 100' : `${Math.round(Math.min(1, Math.max(0, progress)) * 100)} 100`}
      />
    </svg>
  )
}

/**
 * The square tile of an agent or a model: a 1px line ring laid over it and corners of round(size × 0.225). It shows
 * the brand's `mark` on the raised surface, or, for something without an icon of its own, the caller's `icon` (a
 * Lucide glyph at 60%, in ink on the hover fill). `plain` (14 or 16)
 * is the glyph alone, without the tile. The tile is decorative next to the name unless `label` names it, and its
 * state must also be said in words wherever it matters.
 */
export function Tile({
  size = 32,
  icon,
  mark,
  state = 'ready',
  progress,
  plain = false,
  label,
  className,
}: TileArt & {
  size?: TileSize
  state?: TileState
  /** 0 to 1 while arriving; absent means indeterminate. */
  progress?: number
  plain?: boolean
  label?: string
  className?: string
}) {
  return (
    <span
      className={cx('ui-tile', className)}
      data-size={size}
      data-state={state}
      data-plain={plain ? '' : undefined}
      data-glyph={mark ? undefined : ''}
      data-app-icon={mark?.tile ? '' : undefined}
      data-margin={mark?.margin ? '' : undefined}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
      <span className="ui-tile-face">
        {mark ? <Mark mark={mark} /> : <Glyph icon={icon} size={glyphSize(size, plain)} strokeWidth={glyphStroke(size, plain)} />}
      </span>
      {state === 'arriving' && !plain && <ProgressRing size={size} progress={progress} />}
      {state === 'failed' && <span className="ui-tile-dot" />}
    </span>
  )
}
