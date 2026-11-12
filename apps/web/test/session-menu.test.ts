import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TaskStatus, TaskSummary } from '@latch/protocol'
import { sessionMenuSections, type SessionActions } from '../src/sessionMenu.ts'
import { SessionHeader } from '../src/shell/ConversationHeader.tsx'

const noop = () => {}
const task = (status: TaskStatus = 'idle'): TaskSummary => ({ harnessId: 'standard', id: 's', title: '会话', status, updatedAt: '' })
// What useSessionController hands every row; only the open session also gets clear.
const row: SessionActions = { rename: noop, pin: noop, archive: noop, export: noop, remove: noop, unread: noop, copy: noop }
const open: SessionActions = { ...row, clear: noop, clearing: false }
const items = (status: TaskStatus, actions: SessionActions) =>
  sessionMenuSections(task(status), actions, true).flatMap(section => section.items)
const ids = (status: TaskStatus, actions: SessionActions) => items(status, actions).map(item => item.id)

describe('the one session menu', () => {
  it('gives the open session eight items and any other row seven, without 清空上下文', () => {
    expect(ids('idle', open)).toEqual(['rename', 'pin', 'unread', 'copy', 'export', 'clear', 'archive', 'delete'])
    expect(ids('idle', row)).toEqual(['rename', 'pin', 'unread', 'copy', 'export', 'archive', 'delete'])
    expect(items('idle', open).map(item => item.label)).toEqual([
      '重命名',
      '置顶',
      '标为未读',
      '复制为 Markdown',
      '导出 Markdown',
      '清空上下文',
      '归档',
      '删除',
    ])
  })

  it('has no way to fork and no 同步最新状态: the composer forks, the connection’s notice retries', () => {
    for (const actions of [open, row]) {
      const labels = items('idle', actions).map(item => item.label)
      expect(labels).not.toContain('从这里分叉')
      expect(labels).not.toContain('同步最新状态')
    }
  })

  it('keeps 存为项目… where the caller can do it, beside 清空上下文', () => {
    expect(ids('idle', { ...open, saveProject: noop })).toEqual([
      'rename',
      'pin',
      'unread',
      'copy',
      'export',
      'clear',
      'save-project',
      'archive',
      'delete',
    ])
    expect(ids('idle', { ...row, saveProject: noop })).toContain('save-project')
  })

  it('greys 清空上下文 and 删除 while a turn runs or waits, each with today’s reason, and leaves the rest', () => {
    for (const status of ['running', 'waiting-approval'] as const) {
      const off = items(status, open).filter(item => item.disabled)
      expect(off.map(item => [item.id, item.disabledReason])).toEqual([
        ['clear', '这一轮结束后才能清空上下文'],
        ['delete', '运行中的会话需要先停止'],
      ])
      expect(
        items(status, row)
          .filter(item => item.disabled)
          .map(item => item.id),
      ).toEqual(['delete'])
    }
    for (const status of ['idle', 'failed', 'cancelled'] as const) expect(items(status, open).some(item => item.disabled)).toBe(false)
    // Asked to clear, the open session may take it back even while it runs.
    expect(items('running', { ...open, clearing: true }).find(item => item.id === 'clear')).toMatchObject({
      label: '保留上下文',
      disabled: false,
    })
  })

  it('keeps only export for a Host without a catalog', () => {
    expect(sessionMenuSections(task(), open, false).flatMap(section => section.items.map(item => item.id))).toEqual(['export'])
  })

  it('opens the same sections from the title and from ⋯ in the title row, and from the title on a phone', () => {
    const sections = sessionMenuSections(task(), open, true)
    const header = (phone: boolean) =>
      renderToStaticMarkup(
        createElement(SessionHeader, {
          summary: task(),
          cancelling: false,
          demo: false,
          phone,
          onBack: noop,
          panelOpen: false,
          onPanel: noop,
          sessionMenu: sections,
          menu: sections,
          connection: 'connected' as const,
        }),
      )
    const desktop = header(false)
    expect(desktop).toMatch(/<h1[^>]*><button[^>]*aria-haspopup="menu"[^>]*class="topbar-title-button">/u)
    expect(desktop).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*aria-label="会话操作"/u)
    expect(header(true)).toMatch(/<h1[^>]*><button[^>]*aria-haspopup="(?:menu|dialog)"[^>]*class="topbar-title-button">/u)
  })
})
