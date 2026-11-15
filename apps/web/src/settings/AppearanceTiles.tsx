import { Backdrop, RunningEdge, SegmentedControl, Spinner, TileChoice, type BackdropLevel } from '@latch/ui'
import type { DensityPreference, MotionPreference } from '../preferences.ts'

/* The density tiles are mounted when product rows use the density preference. */

/**
 * 背景效果 as a small window: the real layer (粒子场) at this strength behind two opaque cards, drawn at two and a half
 * times the tile's size and scaled down, so the tile shows the density a window gets. 关 is the same window without it.
 */
function BackdropPreview({ level }: { level: BackdropLevel }) {
  return (
    <span className="appearance-preview" aria-hidden="true">
      <span className="appearance-preview-stage ui-backdrop-host">
        <Backdrop kind="field" level={level} />
        <span className="appearance-preview-card" />
        <span className="appearance-preview-card" />
      </span>
    </span>
  )
}

export function BackdropTiles({ value, onValueChange }: { value: BackdropLevel; onValueChange: (value: BackdropLevel) => void }) {
  return (
    <TileChoice
      className="appearance-tiles"
      label="背景效果"
      value={value}
      onValueChange={onValueChange}
      options={[
        { value: 'off', label: '关', tile: <BackdropPreview level="off" /> },
        { value: 'light', label: '轻', tile: <BackdropPreview level="light" /> },
        { value: 'standard', label: '标准', tile: <BackdropPreview level="standard" /> },
      ]}
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
      label="密度"
      value={value}
      onValueChange={onValueChange}
      options={[
        { value: 'standard', label: '标准', tile: <DensityPreview density="standard" /> },
        { value: 'compact', label: '紧凑', tile: <DensityPreview density="compact" /> },
      ]}
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
      <SegmentedControl<MotionPreference>
        label="动效"
        value={value}
        options={[
          { value: 'system', label: '跟随系统' },
          { value: 'reduce', label: '减弱' },
        ]}
        onValueChange={onValueChange}
      />
      <span className="appearance-motion-sample" aria-hidden="true">
        <Spinner size={12} />
        <i />
        <RunningEdge />
      </span>
    </div>
  )
}
