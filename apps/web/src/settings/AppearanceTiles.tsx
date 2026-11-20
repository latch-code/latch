import { resolveAppearance } from '@latch/protocol'
import {
  Backdrop,
  CheckGlyph,
  Icon,
  RunningEdge,
  SegmentedControl,
  Spinner,
  TileChoice,
  type BackdropKind,
  type BackdropLevel,
} from '@latch/ui'
import type { CSSProperties } from 'react'
import { useCustomizationStatus } from '../core/customization.ts'
import { defineCopy } from '../core/i18n.ts'
import {
  BACKDROP_CHOICES,
  ACCENT_CHOICES,
  BACKDROP_STYLE_CHOICES,
  DENSITY_CHOICES,
  FLOATING_MATERIAL_CHOICES,
  MOTION_CHOICES,
  PALETTE_CHOICES,
  type BackdropStyle,
  type AccentPreference,
  type DensityPreference,
  type FloatingMaterialPreference,
  type MotionPreference,
  type PalettePreference,
} from '../preferences.ts'

const COPY = defineCopy(
  {
    palette: '工作台配色',
    accent: '设备主色',
    floatingMaterial: '浮层材质',
    send: '发送',
    onlyHere: '仅此设备',
    backdrop: '背景效果',
    backdropStyle: '背景样式',
    density: '密度',
    motion: '动效',
  },
  {
    palette: 'Workbench palette',
    accent: 'Device accent',
    floatingMaterial: 'Floating panel material',
    send: 'Send',
    onlyHere: 'This device only',
    backdrop: 'Background effects',
    backdropStyle: 'Background style',
    density: 'Density',
    motion: 'Motion',
  },
)

export function FloatingMaterialChoice({
  value,
  onValueChange,
}: {
  value: FloatingMaterialPreference
  onValueChange: (value: FloatingMaterialPreference) => void
}) {
  return (
    <div className="appearance-material">
      <div className="layout-choice-head">
        <span>{COPY.floatingMaterial}</span>
        <span>{COPY.onlyHere}</span>
      </div>
      <SegmentedControl<FloatingMaterialPreference>
        label={COPY.floatingMaterial}
        value={value}
        options={FLOATING_MATERIAL_CHOICES}
        onValueChange={onValueChange}
      />
    </div>
  )
}

export function AccentTiles({ value, onValueChange }: { value: AccentPreference; onValueChange: (value: AccentPreference) => void }) {
  const { host, preview, safe } = useCustomizationStatus()
  const hue = safe === null ? (preview ?? host?.doc)?.appearance.accentHue : undefined
  const shared = hue === undefined ? null : resolveAppearance({ accentHue: hue })
  const sample = shared
    ? ({
        '--preset-accent': `light-dark(${shared.light['--accent']}, ${shared.dark['--accent']})`,
        '--preset-accent-ink': `light-dark(${shared.light['--accent-ink']}, ${shared.dark['--accent-ink']})`,
      } as CSSProperties)
    : undefined
  return (
    <>
      <div className="layout-choice-head">
        <span>{COPY.accent}</span>
        <span>{COPY.onlyHere}</span>
      </div>
      <TileChoice
        className="appearance-tiles appearance-tiles-four"
        label={COPY.accent}
        value={value}
        onValueChange={onValueChange}
        options={ACCENT_CHOICES.map(option => ({
          ...option,
          tile: (
            <span
              className="appearance-preview appearance-accent"
              data-accent-sample={option.value}
              data-host-accent={option.value === 'workbench' && shared ? '' : undefined}
              style={option.value === 'workbench' ? sample : undefined}
              aria-hidden="true">
              <span className="appearance-accent-selected">
                <Icon icon={CheckGlyph} size={12} />
                <i />
              </span>
              <span className="ui-button" data-variant="primary" data-size="xs">
                {COPY.send}
              </span>
            </span>
          ),
        }))}
      />
    </>
  )
}

export function PaletteTiles({ value, onValueChange }: { value: PalettePreference; onValueChange: (value: PalettePreference) => void }) {
  return (
    <>
      <div className="layout-choice-head">
        <span>{COPY.palette}</span>
        <span>{COPY.onlyHere}</span>
      </div>
      <TileChoice
        className="appearance-tiles appearance-tiles-four"
        label={COPY.palette}
        value={value}
        onValueChange={onValueChange}
        options={PALETTE_CHOICES.map(option => ({
          ...option,
          tile: (
            <span className="appearance-preview appearance-palette" data-palette={option.value} aria-hidden="true">
              <span className="appearance-palette-rail">
                <i />
                <i />
              </span>
              <span className="appearance-palette-composer">
                <i />
              </span>
              <span className="appearance-palette-menu">
                <i />
                <i />
              </span>
            </span>
          ),
        }))}
      />
    </>
  )
}

/**
 * 背景效果 as a small window: the real layer (粒子场) at this strength behind two opaque cards, drawn at two and a half
 * times the tile's size and scaled down, so the tile shows the density a window gets. 关 is the same window without it.
 */
function BackdropPreview({ level, kind }: { level: BackdropLevel; kind: BackdropKind }) {
  return (
    <span className="appearance-preview" aria-hidden="true">
      <span className="appearance-preview-stage ui-backdrop-host">
        <Backdrop kind={kind} level={level} ambient />
        <span className="appearance-preview-card" />
        <span className="appearance-preview-card" />
      </span>
    </span>
  )
}

/** 粒子 or 01: each tile runs the real layer in that look. */
export function BackdropStyleTiles({ value, onValueChange }: { value: BackdropStyle; onValueChange: (value: BackdropStyle) => void }) {
  return (
    <TileChoice
      className="appearance-tiles appearance-tiles-two"
      label={COPY.backdropStyle}
      value={value}
      onValueChange={onValueChange}
      options={BACKDROP_STYLE_CHOICES.map(option => ({ ...option, tile: <BackdropPreview level="standard" kind={option.value} /> }))}
    />
  )
}

export function BackdropTiles({
  value,
  kind,
  onValueChange,
}: {
  value: BackdropLevel
  kind: BackdropStyle
  onValueChange: (value: BackdropLevel) => void
}) {
  return (
    <TileChoice
      className="appearance-tiles"
      label={COPY.backdrop}
      value={value}
      onValueChange={onValueChange}
      options={BACKDROP_CHOICES.map(option => ({ ...option, tile: <BackdropPreview level={option.value} kind={kind} /> }))}
    />
  )
}

/** 密度 as rows at their real padding: the tile carries the density, so both are drawn whichever the page uses. */
function DensityPreview({ density }: { density: DensityPreference }) {
  return (
    <span className="appearance-preview appearance-density" data-density={density} aria-hidden="true">
      {[0, 1, 2, 3].map(row => (
        <span key={row} className="appearance-density-row">
          <i />
          <i />
        </span>
      ))}
    </span>
  )
}

export function DensityTiles({ value, onValueChange }: { value: DensityPreference; onValueChange: (value: DensityPreference) => void }) {
  return (
    <TileChoice
      className="appearance-tiles appearance-tiles-two"
      label={COPY.density}
      value={value}
      onValueChange={onValueChange}
      options={DENSITY_CHOICES.map(option => ({ ...option, tile: <DensityPreview density={option.value} /> }))}
    />
  )
}

/**
 * 动效: 跟随系统 or 减弱. Motion is one state of the whole page, so there is one live sample instead of a tile each: a running row with its
 * spinner and its edge in neutral ink (a sample is not a state), which move, or stand still, as the choice just made
 * has them.
 */
export function MotionChoice({ value, onValueChange }: { value: MotionPreference; onValueChange: (value: MotionPreference) => void }) {
  return (
    <div className="appearance-motion">
      <SegmentedControl<MotionPreference> label={COPY.motion} value={value} options={MOTION_CHOICES} onValueChange={onValueChange} />
      <span className="appearance-motion-sample" aria-hidden="true">
        <Spinner size={12} />
        <i />
        <RunningEdge />
      </span>
    </div>
  )
}
