import type { LucideIcon } from 'lucide-react'
import { cx } from './internal.ts'

export type TileSize = 16 | 20 | 24 | 32 | 40 | 56
/**
 * How ready a harness or model is, drawn on the tile itself; ready (the default) adds nothing. cold: not usable (its
 * command is missing, for example), at 40% and in greyscale. arriving: starting or being checked, at 70% in greyscale inside a 2px
 * progress ring 2px out (determinate with `progress`, otherwise turning once every 1.4s). failed: an 8px red dot on
 * the top-right corner, cut out of the surface.
 */
export type TileState = 'ready' | 'cold' | 'arriving' | 'failed'

/**
 * A brand's mark, from a file the page ships with, never inlined as markup. A coloured mark is placed as it is, and
 * `dark` names the brand's own file for the dark theme where it has one. A one-colour mark (`mono`) is the brand's
 * one-colour reproduction, drawn in text-1 through a CSS mask, so it reads near-black on the light plate and soft white
 * on the dark one. `tile` marks the brand's own app icon, which brings its background and its shape: it shows as it is,
 * without the plate, the ring or the tile's corners. `margin` marks a file that already holds a wide margin around the
 * mark: it spans the plate instead of sitting at 62.5%.
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

/** The plate holds a glyph at 62.5% of the tile; a plain tile is the glyph alone. */
const glyphSize = (size: TileSize, plain: boolean) => (plain ? size : size * 0.625)

/**
 * A glyph's line, in px, whatever size it is drawn at: 1.25 below 20 and 1.5 from 20, the weight of the icon scale, so
 * a small glyph does not fill in and a large one does not turn hairline.
 */
const glyphStroke = (size: number) => (size < 20 ? 1.25 : 1.5)

function Glyph({ icon: Drawn, size }: { icon: LucideIcon; size: number }) {
  return <Drawn size={size} strokeWidth={glyphStroke(size)} absoluteStrokeWidth aria-hidden="true" />
}

/**
 * The square tile of a harness or a model: the shared tile plate with a 1px ring and corners of round(size × 0.225).
 * It shows the brand's `mark`, or, for something without an icon of its own, the caller's `icon` (a Lucide glyph,
 * drawn in text-1 on the plate with a line that keeps its weight at every size). `plain` (14 or 16) is the glyph
 * alone, without the tile. The tile is decorative next to the
 * name unless `label` names it, and its state must also be said in words wherever it matters.
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
  // The ring's 2px stroke is centred 3px outside the tile, which leaves a 2px gap; the box reaches 4px out to hold it.
  const ring = size + 8
  return (
    <span
      className={cx('ui-tile', className)}
      data-size={size}
      data-state={state}
      data-plain={plain ? '' : undefined}
      data-app-icon={mark?.tile ? '' : undefined}
      data-margin={mark?.margin ? '' : undefined}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
      <span className="ui-tile-face">{mark ? <Mark mark={mark} /> : <Glyph icon={icon} size={glyphSize(size, plain)} />}</span>
      {state === 'arriving' && !plain && (
        <svg
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
      )}
      {state === 'failed' && <span className="ui-tile-dot" />}
    </span>
  )
}
