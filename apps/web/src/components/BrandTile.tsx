import type { HarnessInfo, ProviderSummary } from '@latch/protocol'
import { Tile, type TileSize, type TileState } from '@latch/ui'
import { harnessArt, providerArt, type BrandArt } from '../brands.ts'
import { BrandMark } from './ui.tsx'

/**
 * The tile of a harness or a model service: its brand's icon on the shared plate, Latch's own app icon (unaltered) for
 * the built-in harness, or a neutral glyph where there is no icon (alone, without the plate, at 16). Decorative next to
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
  // At 16 a glyph on the plate would be 10px and unreadable: it stands alone at full size, as other 16px icons do.
  return <Tile size={size} icon={art.icon} plain={size === 16} state={state} label={label} className={className} />
}

/** A harness's tile; an unavailable harness is drawn faint, and its reason is said in words beside it. */
export function HarnessTile({
  harness,
  size,
  label,
  className,
}: {
  harness: Pick<HarnessInfo, 'id' | 'source'> & Partial<Pick<HarnessInfo, 'status'>> & { presetId?: string }
  size?: TileSize
  label?: string
  className?: string
}) {
  return (
    <BrandTile
      art={harnessArt(harness)}
      size={size}
      state={harness.status === 'unavailable' ? 'cold' : undefined}
      label={label}
      className={className}
    />
  )
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
