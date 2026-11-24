import type * as React from 'react'
import type { Button, IconButton } from './button.tsx'
import type { BarChart, LineChart, ShareBar } from './chart.tsx'
import type { Checkbox } from './choice.tsx'
import type { TextAreaField, TextField } from './field.tsx'
import type { Meter } from './meter.tsx'
import type { InlineNotice } from './notice.tsx'
import type { StatusPill } from './pill.tsx'
import type { Loading } from './state.tsx'

/** Author a component, bundle it as ESM, and use the React instance supplied by the workbench. */
export interface PluginPanelProps<Session = unknown> {
  session: Session
  react: typeof React
  ui: {
    Button: typeof Button
    Checkbox: typeof Checkbox
    TextField: typeof TextField
    TextAreaField: typeof TextAreaField
    InlineNotice: typeof InlineNotice
    StatusPill: typeof StatusPill
    Loading: typeof Loading
  }
  canCompose: boolean
  /** Adds a draft to the current conversation. The person reviews and sends it with the normal composer. */
  compose(text: string): void
  /** Read a data panel from this package, for this session, with the same view authorization. */
  readData(id: string, signal?: AbortSignal): Promise<unknown>
}

/** Props for a React panel that explicitly opts in to the workbench's context projection. */
export interface ContextPluginPanelProps<Context = unknown> {
  react: typeof React
  ui: PluginPanelProps['ui'] & {
    IconButton: typeof IconButton
    BarChart: typeof BarChart
    LineChart: typeof LineChart
    ShareBar: typeof ShareBar
    Meter: typeof Meter
  }
  locale: 'zh-CN' | 'en'
  context: Context
  /** Scroll to a turn referenced in the current projection. Invalid or stale references are ignored. */
  revealTurn(ref: string): void
  /** Scroll to the tool row referenced in the current projection. Invalid or stale references are ignored. */
  revealTool?(ref: string): void
}
