import { TileChoice } from '@latch/ui'
import type { WorkbenchLayout } from '../preferences.ts'

function LayoutPreview({ layout }: { layout: WorkbenchLayout }) {
  return (
    <span className="layout-preview" data-layout={layout} aria-hidden="true">
      <span className="layout-preview-rail">
        <span />
        <span />
        <span />
      </span>
      <span className="layout-preview-content">
        <span className="layout-preview-title" />
        <span className="layout-preview-lines">
          <span />
          <span />
          <span />
        </span>
      </span>
    </span>
  )
}

export function LayoutTiles({ value, onValueChange }: { value: WorkbenchLayout; onValueChange: (value: WorkbenchLayout) => void }) {
  return (
    <TileChoice
      className="layout-tiles"
      label="工作台布局"
      value={value}
      onValueChange={onValueChange}
      options={[
        { value: 'overview', label: '总览', tile: <LayoutPreview layout="overview" /> },
        { value: 'triage', label: '分拣台', tile: <LayoutPreview layout="triage" /> },
      ]}
    />
  )
}
