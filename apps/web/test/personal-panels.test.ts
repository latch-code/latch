import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { TaskSummary, UiPanelInfo } from '@latch/protocol'
import { SessionPanels } from '../src/components/SessionPanels.tsx'

const panels: UiPanelInfo[] = [
  { id: 'selected:panel', pluginId: 'selected', pluginName: 'Selected', title: 'Chosen panel' },
  { id: 'other:panel', pluginId: 'other', pluginName: 'Other', title: 'Unselected panel', moduleHash: 'a'.repeat(64) },
]
const summary: TaskSummary = { id: 'task', title: 'Task', status: 'idle', updatedAt: '2026-10-26T00:00:00Z' }
const render = (task: TaskSummary) =>
  renderToStaticMarkup(createElement(SessionPanels, { summary: task, panels, children: 'Session information' }))
it('offers only the personal assistant selected plugin panels and keeps ordinary sessions compatible', () => {
  const personal = { assistantId: 'asst_00000000-0000-0000-0000-000000000001' }
  expect(render(summary)).toContain('Unselected panel')
  const selected = render({ ...summary, personal, pluginIds: ['selected'] })
  expect(selected).toContain('Chosen panel')
  expect(selected).not.toContain('Unselected panel')
  expect(render({ ...summary, personal })).toBe('Session information')
  expect(render({ ...summary, personal, pluginIds: [] })).toBe('Session information')
})
