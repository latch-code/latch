import { forwardRef, useId, type ForwardRefExoticComponent, type ReactNode, type RefAttributes } from 'react'
import type { LucideProps } from 'lucide-react'

/**
 * The width of an icon's line on the screen, in CSS pixels, at each of the five sizes: it grows with the icon, so a
 * 12px glyph stays open (1.2) and a 20px one in a phone's tab bar does not go thin (1.75, as at 24). Latch's glyphs always draw
 * at these widths; a Lucide glyph is told to (`nonScalingStroke`), since it would otherwise scale its 24-grid line
 * with the icon.
 */
export const ICON_STROKE = { 12: 1.2, 14: 1.35, 16: 1.5, 20: 1.75, 24: 1.75 } as const

/** At this size and below a glyph that has a small drawing uses it. */
const SMALL = 12
export type IconSize = keyof typeof ICON_STROKE

/** What every icon takes: Lucide's props, so both sets fit the same places. */
export type GlyphProps = Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>

/**
 * An icon from either set: one of Latch's own glyphs or a Lucide one. A Latch glyph also carries its `solid` variant,
 * for the selected or current item; a Lucide glyph has none.
 */
export type IconComponent = ForwardRefExoticComponent<GlyphProps> & { readonly solid?: ForwardRefExoticComponent<GlyphProps> }

/** A glyph drawn solid: `plane` is filled in currentColor, and `cut` is taken out of it (lines and holes in black). */
export interface SolidDrawing {
  plane: ReactNode
  cut?: ReactNode
}

/** The grid every Latch glyph is drawn on. */
const GRID = 16
/** A glyph with no plane to fill (a chevron, a cross) is solid as the same drawing at a heavier line. */
const HEAVIER = 4 / 3

const lineWidth = (size: number, strokeWidth: LucideProps['strokeWidth']) => {
  const own = strokeWidth === undefined ? undefined : Number(strokeWidth)
  const onScreen = own !== undefined && Number.isFinite(own) ? own : (ICON_STROKE[size as IconSize] ?? ICON_STROKE[16])
  // The line is drawn in grid units: on a 12px icon one unit is three quarters of a pixel.
  return (onScreen * GRID) / size
}

const accessible = (props: object) => Object.keys(props).some(key => key.startsWith('aria-') || key === 'role' || key === 'title')

function draw(name: string, variant: 'outline' | 'solid', heavier: boolean, content: (mask: string, size: number) => ReactNode) {
  const Glyph = forwardRef<SVGSVGElement, GlyphProps>(function Glyph(
    {
      size = 16,
      color = 'currentColor',
      strokeWidth,
      absoluteStrokeWidth: _absolute,
      nonScalingStroke: _nonScaling,
      className,
      children,
      ...rest
    },
    ref,
  ) {
    const mask = `latch-glyph-${useId().replace(/[^\w-]/gu, '')}`
    const px = Number(size)
    const unit = lineWidth(px, strokeWidth) * (heavier ? HEAVIER : 1)
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke={color}
        strokeWidth={unit}
        strokeLinecap="butt"
        strokeLinejoin="miter"
        strokeMiterlimit={4}
        className={['latch-glyph', `latch-glyph-${name}`, variant === 'solid' && 'latch-glyph-solid', className].filter(Boolean).join(' ')}
        {...(accessible(rest) || children ? {} : { 'aria-hidden': true })}
        {...rest}>
        {content(mask, px)}
        {children}
      </svg>
    )
  })
  Glyph.displayName = `${name}${variant === 'solid' ? 'Solid' : ''}Glyph`
  return Glyph
}

/**
 * Makes a Latch glyph from its drawing on the 16 grid: square line ends, mitred joints, at most one solid part placed
 * where the meaning is. Lines inherit the size's width; a solid part is drawn with `fill="currentColor" stroke="none"`.
 * `solid` is the variant for the selected or current item; without one, the solid variant is the same drawing at a
 * heavier line. `small` is the drawing for 12px, where nodes become solid squares and small parts are dropped so
 * nothing closes up; the solid variant is not drawn that small and keeps its one drawing.
 */
export function defineGlyph(name: string, outline: ReactNode, solid?: SolidDrawing, small?: ReactNode): IconComponent {
  const Outline = draw(name, 'outline', false, (_mask, size) => (small !== undefined && size <= SMALL ? small : outline))
  const Solid = draw(name, 'solid', !solid, mask =>
    !solid ? (
      outline
    ) : !solid.cut ? (
      solid.plane
    ) : (
      <>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
          <rect width="16" height="16" fill="white" stroke="none" />
          <g fill="black" stroke="black">
            {solid.cut}
          </g>
        </mask>
        <g mask={`url(#${mask})`}>{solid.plane}</g>
      </>
    ),
  )
  return Object.assign(Outline, { solid: Solid })
}

/** A solid part of a glyph: a rectangle in currentColor. */
export const Dot = ({ x, y, w, h }: { x: number; y: number; w: number; h: number }) => (
  <rect x={x} y={y} width={w} height={h} fill="currentColor" stroke="none" />
)

/** A rectangle taken out of a solid plane. */
export const Hole = ({ x, y, w, h }: { x: number; y: number; w: number; h: number }) => (
  <rect x={x} y={y} width={w} height={h} stroke="none" />
)

/** A line taken out of a solid plane, at the glyph's line width. */
export const Slit = ({ d }: { d: string }) => <path d={d} fill="none" />

/** A closed outline drawn filled: the plane reaches the outer edge of its line. */
export const Plane = ({ d }: { d: string }) => <path d={d} fill="currentColor" />
