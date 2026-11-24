import { Icon, type IconSize } from '@latch/ui'
import {
  Asterisk,
  Blocks,
  ChartColumn,
  ClipboardCheck,
  Command,
  Compass,
  FileText,
  Layers,
  LayoutList,
  Network,
  Orbit,
  Shapes,
} from 'lucide-react'
import { pluginArtwork } from '../../../../examples/marketplace/artwork.ts'

const glyphs = {
  asterisk: Asterisk,
  blocks: Blocks,
  command: Command,
  compass: Compass,
  layers: Layers,
  network: Network,
  orbit: Orbit,
  shapes: Shapes,
}

function bundledIcon(id: string) {
  switch (id) {
    case 'shift-handoff':
      return FileText
    case 'release-review':
      return ClipboardCheck
    case 'release-check':
      return LayoutList
    case 'context-insights':
      return ChartColumn
  }
}

export function PluginMarketIcon({ id, size, bundled, framed }: { id: string; size: IconSize; bundled?: boolean; framed?: boolean }) {
  const dedicated = bundled ? bundledIcon(id) : undefined
  if (dedicated && !framed) return <Icon icon={dedicated} size={size} />
  const { tone, glyph } = pluginArtwork(id)
  return (
    <span
      className={framed ? 'plugin-market-icon' : 'plugin-market-inline-icon'}
      data-plugin-tone={dedicated ? undefined : tone}
      data-plugin-glyph={dedicated ? undefined : glyph}
      aria-hidden="true">
      <Icon icon={dedicated ?? glyphs[glyph]} size={size} />
    </span>
  )
}

export function PluginFallbackCover({ id }: { id: string }) {
  const { pattern, tone, glyph } = pluginArtwork(id)
  return (
    <div className="plugin-market-preview" data-preview="fallback" data-plugin-tone={tone} aria-hidden="true">
      <span className="plugin-market-texture" data-plugin-pattern={pattern} />
      <span className="plugin-market-mark" data-plugin-glyph={glyph}>
        <Icon icon={glyphs[glyph]} size={24} />
      </span>
    </div>
  )
}
