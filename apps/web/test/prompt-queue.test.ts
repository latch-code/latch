import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PromptQueueItem } from '@latch/protocol'
import { Composer } from '../src/composer/Composer.tsx'
import { QueueDrawer } from '../src/composer/QueueDrawer.tsx'
import { MessageRow } from '../src/components/MessageRow.tsx'
import { submissionRequest } from '../src/core/api.ts'
const noop = () => {}
const run = { approvals: 0, cancel: 'idle' as const, onRevealApprovals: noop, onCancel: noop }
const renderComposer = (queueable: boolean) =>
  renderToStaticMarkup(
    createElement(Composer, {
      queueable,
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
const tray = (items: PromptQueueItem[], canSend: boolean) =>
  renderToStaticMarkup(createElement(QueueDrawer, { sessionId: 'task', items, canSend, canRemove: true, onChanged: async () => {} }))
describe('queued follow-up presentation', () => {
  it('offers queue and stop together only when the Host supports it', () => {
    const capable = renderComposer(true)
    expect(capable).toContain('aria-label="排队发送"')
    // Esc stops on a keyboard; touch keeps the button beside 排队.
    expect(capable).not.toContain('aria-label="停止"')
    expect(renderComposer(false)).not.toContain('aria-label="排队发送"')
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
    expect(html).not.toContain('>编辑<')
    expect(html).not.toContain('>发送<')
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
