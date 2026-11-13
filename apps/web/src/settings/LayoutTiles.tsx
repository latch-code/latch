import { TileChoice } from '@latch/ui'
import type { WorkbenchLayout } from '../preferences.ts'

function LayoutPreview({ layout }: { layout: WorkbenchLayout }) {
  return (
    <span className="layout-preview" data-layout={layout} aria-hidden="true">
      <span className="layout-preview-rail">
        <b>Latch</b>
        <span>Code</span>
        <span className="layout-preview-current">总览</span>
        <i />
        <i />
      </span>
      <span className="layout-preview-content">
        <span className="layout-preview-input">
          想让 Agent 做什么？
          <i />
          <i />
        </span>
        <span className="layout-preview-lines">
          <span className="layout-preview-attention">
            <b>等你处理</b>
            <span className="layout-preview-card">
              <i />
              <i />
              <span>
                <i />
                <i />
              </span>
            </span>
          </span>
          <span>
            <b>进行中</b>
            <i />
            <i />
          </span>
          <span>
            <b>可交付</b>
            <i />
          </span>
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
