import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
const require = createRequire(import.meta.url)
const { createNotifications, validPreferences } = require('../src/notifications.cjs')
describe('Host-authorized notifications', () => {
  it('ignores the initial snapshot, honors foreground and preferences, throttles a session, and opens only Host session IDs', async () => {
    let focused = false,
      time = 10_000
    let snapshot = { tasks: [{ id: 'a', title: 'private', status: 'running' }], approvals: [] as Array<{ id: string; sessionId: string }> }
    const show = vi.fn(),
      open = vi.fn(),
      badge = vi.fn()
    const controller = createNotifications({
      snapshot: async () => snapshot,
      focused: () => focused,
      supported: () => true,
      show,
      open,
      badge,
      now: () => time,
    })
    controller.configure({ completion: true, approval: true, title: false })
    await controller.poll()
    expect(show).not.toHaveBeenCalled()
    snapshot.tasks[0]!.status = 'idle'
    await controller.poll()
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Latch', body: '一个会话已完成。' }))
    show.mock.calls[0]![0].onClick()
    expect(open).toHaveBeenCalledWith('a')
    snapshot.approvals = [{ id: 'one', sessionId: 'a' }]
    await controller.poll()
    expect(show).toHaveBeenCalledTimes(1)
    time += 10_000
    focused = true
    snapshot.approvals.push({ id: 'two', sessionId: 'a' })
    await controller.poll()
    expect(show).toHaveBeenCalledTimes(1)
    focused = false
    snapshot.approvals.push({ id: 'three', sessionId: 'a' })
    await controller.poll()
    expect(show).toHaveBeenCalledTimes(2)
    expect(badge).toHaveBeenLastCalledWith(3)
  })
  it('fails closed on preferences and host errors and asks for consent without notifying by default', async () => {
    let snapshot = { tasks: [{ id: 'a', status: 'running' }], approvals: [] }
    const show = vi.fn(),
      controller = createNotifications({
        snapshot: async () => snapshot,
        focused: () => false,
        supported: () => true,
        show,
        open: vi.fn(),
        badge: vi.fn(),
      })
    expect(validPreferences({ completion: true, approval: false, title: false, text: 'untrusted' })).toBe(false)
    await controller.poll()
    snapshot.tasks[0]!.status = 'idle'
    await controller.poll()
    expect(show).not.toHaveBeenCalled()
    expect(controller.view().needsConsent).toBe(true)
  })
})
