import { Backdrop, RunningEdge, SegmentedControl, Spinner, TileChoice, type BackdropKind, type BackdropLevel } from '@latch/ui'
import { defineCopy } from '../core/i18n.ts'
import {
  BACKDROP_CHOICES,
  BACKDROP_STYLE_CHOICES,
  DENSITY_CHOICES,
  MOTION_CHOICES,
  type BackdropStyle,
  type DensityPreference,
  type MotionPreference,
} from '../preferences.ts'

const COPY = defineCopy(
  { backdrop: '背景效果', backdropStyle: '背景样式', density: '密度', motion: '动效' },
  { backdrop: 'Background effects', backdropStyle: 'Background style', density: 'Density', motion: 'Motion' },
)

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
