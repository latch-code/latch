import type * as React from 'react'
import type { Button } from './button.tsx'
import type { Checkbox } from './choice.tsx'
import type { TextAreaField, TextField } from './field.tsx'
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
