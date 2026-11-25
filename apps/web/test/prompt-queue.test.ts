// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PromptQueueItem } from '@latch/protocol'
import { Composer } from '../src/composer/Composer.tsx'
import { QueueDrawer } from '../src/composer/QueueDrawer.tsx'
import { MessageRow } from '../src/components/MessageRow.tsx'
import { submissionRequest } from '../src/core/api.ts'
import { shortcutBindings } from '../src/core/shortcutBindings.ts'
import { followUpKeyLabels } from '../src/workbenchShortcuts.ts'
// happy-dom has no popover layout. The composer still opens suggestions and handles all of the editor's keys.
vi.mock('@latch/ui', async importOriginal => ({ ...(await importOriginal<typeof import('@latch/ui')>()), Suggest: () => null }))
const noop = () => {}
const run = { approvals: 0, cancel: 'idle' as const, onRevealApprovals: noop, onCancel: noop }
const composer = (props: Partial<ComponentProps<typeof Composer>>) =>
  createElement(Composer, {
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
    ...props,
  })
const renderComposer = (queueable: boolean, steerable = false, followUpDefault: 'steer' | 'queue' = 'steer') =>
  renderToStaticMarkup(composer({ queueable, steerable, followUpDefault }))
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
  it('labels one submit button with the available default and offers both actions in its menu', () => {
    const html = renderComposer(true, true)
    expect(html).toContain('aria-label="立即发送"')
    expect(html).not.toContain('aria-label="排队发送"')
    expect(html).toContain('role="menu" aria-label="选择发送方式"')
    expect(html).toContain('data-label="排队发送"')
    expect(html).toContain('data-label="立即发送"')
    expect(html.match(/role="menuitem"/g)).toHaveLength(2)
    expect(html).toContain(`>${followUpKeyLabels(null, 'Mod+Shift+Enter', false)[0]}</kbd>`)
    expect(html).toContain('>Enter</kbd>')
    expect(renderComposer(true, true, 'queue')).toContain('aria-label="排队发送"')
    expect(renderComposer(false, true, 'queue')).toContain('aria-label="立即发送"')
    expect(renderComposer(false, true)).not.toContain('选择发送方式')
    expect(renderComposer(true)).not.toContain('选择发送方式')
    expect(renderComposer(true)).not.toContain('aria-label="立即发送"')
  })
  it('sends each named shortcut to its available action and keeps the primary send key', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const bindings = vi.spyOn(shortcutBindings, 'bindings').mockReturnValue({ 'send-now': 'Mod+Shift+KeyI' })
    const onSubmit = vi.fn(),
      onQueue = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const render = (props: Partial<ComponentProps<typeof Composer>> = {}) =>
      act(() => root.render(composer({ queueable: true, steerable: true, onSubmit, onQueue, ...props })))
    const key = (key: string, code: string, modifiers: KeyboardEventInit = {}) =>
      act(() => {
        host
          .querySelector<HTMLElement>('.cm-content')!
          .dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...modifiers }))
      })
    const alternate = { ctrlKey: true, shiftKey: true }
    try {
      render()
      expect(host.querySelector('[data-label="立即发送"] kbd')?.textContent).toBe(
        followUpKeyLabels('Enter', 'Mod+Shift+KeyI', false).join(' / '),
      )
      key('Enter', 'Enter', alternate)
      expect(onQueue).toHaveBeenCalledTimes(1)
      key('I', 'KeyI', alternate)
      key('Enter', 'Enter')
      expect(onSubmit).toHaveBeenCalledTimes(2)
      render({ followUpDefault: 'queue' })
      key('I', 'KeyI', alternate)
      expect(onSubmit).toHaveBeenCalledTimes(3)
      key('Enter', 'Enter')
      expect(onQueue).toHaveBeenCalledTimes(2)
      key('Enter', 'Enter', alternate)
      key('Enter', 'Enter', { altKey: true, ctrlKey: true })
      key('I', 'KeyI', { ...alternate, isComposing: true })
      render({ steerable: false })
      key('I', 'KeyI', alternate)
      render({ sending: true })
      key('I', 'KeyI', alternate)
      render({ pending: { sessionId: 'task', requestId: 'held', prompt: 'Earlier' } })
      key('I', 'KeyI', alternate)
      const answer = vi.fn()
      render({ answer: { kind: 'question', onSubmit: answer } })
      key('Enter', 'Enter', alternate)
      expect(answer).not.toHaveBeenCalled()
      render({ draft: '/x', commands: [{ name: 'xyz', description: 'Example' }] })
      expect(host.querySelector('.cm-content')?.getAttribute('aria-autocomplete')).toBe('list')
      key('I', 'KeyI', alternate)
      render({ draft: '/clear' })
      key('I', 'KeyI', alternate)
      render({ readOnly: '只读' })
      expect(host.querySelector('.cm-content')).toBeNull()
      expect(onSubmit).toHaveBeenCalledTimes(3)
      expect(onQueue).toHaveBeenCalledTimes(2)
      bindings.mockReturnValue({ 'queue-message': 'Mod+Shift+KeyQ', sidebar: 'Mod+Shift+Enter' })
      render()
      key('Enter', 'Enter', alternate)
      expect(onQueue).toHaveBeenCalledTimes(2)
      expect(onSubmit).toHaveBeenCalledTimes(3)
      key('Q', 'KeyQ', alternate)
      expect(onQueue).toHaveBeenCalledTimes(3)
    } finally {
      act(() => root.unmount())
      host.remove()
      bindings.mockRestore()
      vi.unstubAllGlobals()
    }
  })
  it('retains attachment IDs when retrying immediate delivery without text', () => {
    expect(submissionRequest({ sessionId: 'task', prompt: '', requestId: 'same', steer: true, attachmentIds: ['image'] })).toEqual({
      path: 'tasks/task/prompt',
      body: { prompt: '', requestId: 'same', steer: true, attachmentIds: ['image'] },
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
    const items = [
      item,
      { ...item, id: 'other', canSteer: true as const },
      { ...item, id: 'with-image', canSteer: true as const, attachmentCount: 1 },
    ]
    const live = { running: true, steerRunId: 'run' }
    expect(tray(items, true, live).match(/>立即发送</g)).toHaveLength(1)
    expect(tray(items, true, { ...live, steerAttachments: true }).match(/>立即发送</g)).toHaveLength(2)
    expect(tray(items, true, live)).toContain('aria-label="调整顺序"')
    expect(tray(items, true, { ...live, queueControl: false })).not.toMatch(/立即发送|调整顺序/)
    expect(tray(items, true, { running: true })).not.toContain('立即发送')
    expect(tray(items, false, live)).not.toMatch(/立即发送|调整顺序/)
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
