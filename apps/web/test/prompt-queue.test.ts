import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PromptQueueItem } from '@latch/protocol'
import { Composer } from '../src/composer/Composer.tsx'
import { QueueDrawer } from '../src/composer/QueueDrawer.tsx'
import { MessageRow } from '../src/components/MessageRow.tsx'
import { submissionRequest } from '../src/core/api.ts'
const noop = () => {}
const run = { approvals: 0, cancel: 'idle' as const, onRevealApprovals: noop, onCancel: noop }
const renderComposer = (queueable: boolean, steerable = false) =>
  renderToStaticMarkup(
    createElement(Composer, {
      queueable,
      steerable,
      textareaRef: { current: null },
      variant: 'session',
      label: 'Continue',
      placeholder: 'Continue',
      draft: 'Next',
      onDraft: noop,
      pending: null,
      sending: false,
      error: '',
      onRetry: noop,
      canSend: true,
      onSubmit: noop,
      onQueue: noop,
      sendKey: 'enter',
      coarse: false,
      controls: null,
      run,
    }),
  )
const item: PromptQueueItem = {
  id: 'item',
  text: 'Follow-up <script>bad()</script>',
  queuedAt: '2026-10-25T06:00:00.000Z',
  state: 'waiting',
}
const tray = (items: PromptQueueItem[], canSend: boolean, options: Partial<ComponentProps<typeof QueueDrawer>> = {}) =>
  renderToStaticMarkup(
    createElement(QueueDrawer, {
      sessionId: 'task',
      items,
      canSend,
      canRemove: true,
      running: false,
      queueControl: true,
      onRemovedUnknown: noop,
      onChanged: async () => {},
      ...options,
    }),
  )
describe('queued follow-up presentation', () => {
  it('offers queue and stop together only when the Host supports it', () => {
    const capable = renderComposer(true)
    expect(capable).toContain('aria-label="排队发送"')
    // Esc stops on a keyboard; touch keeps the button beside 排队.
    expect(capable).not.toContain('aria-label="停止"')
    expect(renderComposer(false)).not.toContain('aria-label="排队发送"')
  })
  it('offers 追加 instead of 排队 while the running turn takes more text, and keeps that intent in a retry', () => {
    const html = renderComposer(true, true)
    expect(html).toContain('aria-label="追加到本轮"')
    expect(html).not.toContain('aria-label="排队发送"')
    expect(html).toContain('aria-label="排到下一轮"')
    expect(renderComposer(false, true)).not.toContain('排到下一轮')
    expect(renderComposer(false, true)).toContain('aria-label="追加到本轮"')
    expect(submissionRequest({ sessionId: 'task', prompt: 'Next', requestId: 'same', steer: true })).toEqual({
      path: 'tasks/task/prompt',
      body: { prompt: 'Next', requestId: 'same', steer: true },
    })
  })
  it('keeps the queue intent in an exact retry body', () => {
    expect(submissionRequest({ sessionId: 'task', prompt: 'Next', requestId: 'same', queue: true })).toEqual({
      path: 'tasks/task/prompt',
      body: { prompt: 'Next', requestId: 'same', queue: true },
    })
  })
  it('lets a remote full-access viewer with run remove items while hiding edit and send', () => {
    const html = tray([{ ...item, state: 'parked', reason: 'Host 已重启' }], false)
    expect(html).toContain('已暂停')
    expect(html).toContain('移除')
    expect(html).not.toContain('aria-label="编辑"')
    expect(html).not.toContain('>发送<')
  })
  it('only offers per-item steering for the current run and eligible queue items', () => {
    const items = [item, { ...item, id: 'other', canSteer: true as const }]
    const live = { running: true, steerRunId: 'run' }
    expect(tray(items, true, live).match(/aria-label="追加到本轮"/g)).toHaveLength(1)
    expect(tray(items, true, live)).toContain('aria-label="调整顺序"')
    expect(tray(items, true, { ...live, queueControl: false })).not.toMatch(/追加到本轮|调整顺序/)
    expect(tray(items, true, { running: true })).not.toContain('追加到本轮')
    expect(tray(items, false, live)).not.toMatch(/追加到本轮|调整顺序/)
    const unknown = tray([{ ...item, state: 'parked', delivery: 'steer-unknown' }, items[1]!], true)
    expect(unknown).not.toMatch(/>发送<|调整顺序/)
    expect(unknown.match(/aria-label="编辑"/g)).toHaveLength(1)
  })
  it('renders a dropped intent honestly and escapes queued text', () => {
    const html = tray([{ ...item, state: 'dropped', reason: '设备权限已变化' }], true)
    expect(html).toContain('未发送 · 请检查排队内容')
    expect(html).not.toContain('本轮完成后依次发送')
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })
  it('does not crash a historical message with an invalid optional queue timestamp', () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(MessageRow, { message: { id: 'u', role: 'user', text: 'Old', createdAt: item.queuedAt, queuedAt: 'invalid' } }),
      ),
    ).not.toThrow()
  })
})
