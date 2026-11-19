import type { ReactNode } from 'react'
import type { HarnessInfo, ProviderSummary } from '@latch/protocol'
import { Tile, type IconComponent, type TileSize, type TileState } from '@latch/ui'
import { harnessArt, modelArt, providerArt, type BrandArt } from '../brands.ts'
import { BrandMark } from './ui.tsx'

/**
 * Harness and provider marks are bare at inline sizes. Larger tiles use the shared plate. Latch's own app icon
 * stands whole at every size. Labels are optional when the name is already drawn beside the tile.
 */
function BrandTile({
  art,
  size = 20,
  bare = size <= 20,
  state,
  label,
  className,
}: {
  art: BrandArt
  size?: TileSize
  bare?: boolean
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
  if (art.kind === 'mark') return <Tile size={size} mark={art.mark} bare={bare} state={state} label={label} className={className} />
  return <Tile size={size} icon={art.icon} bare={bare} state={state} label={label} className={className} />
}

interface BrandTileProps {
  size?: TileSize
  bare?: boolean
  label?: string
  className?: string
}

/** The tile of a harness key: a preset that is no Harness yet, or a session whose Harness is no longer listed. */
export function MarkTile({ mark, cold, ...tile }: BrandTileProps & { mark: string | undefined; cold?: boolean }) {
  return <BrandTile art={harnessArt(mark)} state={cold ? 'cold' : undefined} {...tile} />
}

/** A harness's tile; an unavailable harness is drawn faint, and its reason is said in words beside it. */
export function HarnessTile({
  harness,
  ...tile
}: BrandTileProps & { harness: Pick<HarnessInfo, 'capabilities'> & Partial<Pick<HarnessInfo, 'status'>> }) {
  return <MarkTile mark={harness.capabilities.display.mark} cold={harness.status === 'unavailable'} {...tile} />
}

export function ProviderTile({
  provider,
  ...tile
}: BrandTileProps & { provider: Pick<ProviderSummary, 'id'> & { kind?: ProviderSummary['kind']; presetId?: string } }) {
  return <BrandTile art={providerArt(provider)} {...tile} />
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
  return <Tile size={size} icon={icon} bare={size <= 16} label={label} className={className} />
}

/** The mark of a model's maker beside its name; an ID that names none Latch draws shows `fallback` (its service's tile), else keeps the place empty. */
export function ModelTile({ model, fallback, ...tile }: BrandTileProps & { model: string; fallback?: ReactNode }) {
  const art = modelArt(model)
  return art ? <BrandTile art={art} {...tile} /> : (fallback ?? <span className="model-tile-blank" aria-hidden="true" />)
}
