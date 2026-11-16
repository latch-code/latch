import { expect, it } from 'vitest'
import { conversationInFront } from '../src/shell/conversationShown.ts'

const shown = { entry: 'sessions', selectedId: 's1', start: false, board: false, settings: false, panelPage: false, phoneReview: false }

it('shows the open conversation only in 对话 with nothing over it, never while 看板 is in front', () => {
  expect(conversationInFront(shown)).toBe(true)
  // 看板 keeps the session mounted underneath, unseen: nothing that marks it as read may follow it then.
  expect(conversationInFront({ ...shown, board: true })).toBe(false)
  expect(conversationInFront({ ...shown, start: true })).toBe(false)
  expect(conversationInFront({ ...shown, settings: true })).toBe(false)
  expect(conversationInFront({ ...shown, panelPage: true })).toBe(false)
  expect(conversationInFront({ ...shown, phoneReview: true })).toBe(false)
  expect(conversationInFront({ ...shown, entry: 'agents' })).toBe(false)
  expect(conversationInFront({ ...shown, selectedId: null })).toBe(false)
})
