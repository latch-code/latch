import type { HarnessInfo, ProviderSummary } from '@latch/protocol'
import { Tile, type IconComponent, type TileSize, type TileState } from '@latch/ui'
import { harnessArt, providerArt, type BrandArt } from '../brands.ts'
import { BrandMark } from './ui.tsx'

/**
 * The tile of a harness or a model service: its brand's icon on the shared plate, Latch's own app icon (unaltered) for
 * the built-in harness, or a neutral glyph where there is no icon (alone, without the plate, at 16 and below). Decorative next to
 * the name unless `label` names it.
 */
function BrandTile({
  art,
  size = 20,
  state,
  label,
  className,
}: {
  art: BrandArt
  size?: TileSize
  state?: TileState
  label?: string
  className?: string
}) {
  if (art.kind === 'app')
    return (
      <span className={className ? `brand-tile ${className}` : 'brand-tile'} {...(label ? { role: 'img', 'aria-label': label } : {})}>
        <BrandMark size={size} />
      </span>
    )
  if (art.kind === 'mark') return <Tile size={size} mark={art.mark} state={state} label={label} className={className} />
  // On the plate a glyph is 60% of the tile, unreadable from 16 down: it stands alone at full size, as other small icons do.
  return <Tile size={size} icon={art.icon} plain={size <= 16} state={state} label={label} className={className} />
}

interface HarnessTileProps {
  size?: TileSize
  label?: string
  className?: string
}

/** The tile of a harness key: a preset that is no Harness yet, or a session whose Harness is no longer listed. */
export function MarkTile({ mark, cold, size, label, className }: HarnessTileProps & { mark: string | undefined; cold?: boolean }) {
  return <BrandTile art={harnessArt(mark)} size={size} state={cold ? 'cold' : undefined} label={label} className={className} />
}

/** A harness's tile; an unavailable harness is drawn faint, and its reason is said in words beside it. */
export function HarnessTile({
  harness,
  ...tile
}: HarnessTileProps & { harness: Pick<HarnessInfo, 'capabilities'> & Partial<Pick<HarnessInfo, 'status'>> }) {
  return <MarkTile mark={harness.capabilities.display.mark} cold={harness.status === 'unavailable'} {...tile} />
}

export function ProviderTile({
  provider,
  size,
  label,
  className,
}: {
  provider: Pick<ProviderSummary, 'id'> & { kind?: ProviderSummary['kind']; presetId?: string }
  size?: TileSize
  label?: string
  className?: string
}) {
  return <BrandTile art={providerArt(provider)} size={size} label={label} className={className} />
}

/** The tile of 我的 Agent, which has no brand: a neutral glyph, on the plate wherever that stays readable. */
export function GlyphTile({
  icon,
  size = 20,
  label,
  className,
}: {
  icon: IconComponent
  size?: TileSize
  label?: string
  className?: string
}) {
  return <Tile size={size} icon={icon} plain={size <= 16} label={label} className={className} />
}
