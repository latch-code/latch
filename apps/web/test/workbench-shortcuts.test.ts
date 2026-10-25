import { describe, expect, it } from 'vitest'
import { workbenchShortcut } from '../src/workbenchShortcuts.ts'
const key = (code: string, extra = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra })
describe('workbench key routing', () => {
  it('reserves browser shortcuts and handles the documented alternate bindings', () => {
    for (const [code, action] of [
      ['KeyN', 'new'],
      ['KeyB', 'sidebar'],
      ['BracketLeft', 'previous'],
      ['BracketRight', 'next'],
      ['Slash', 'help'],
    ]) {
      expect(workbenchShortcut(key(code!, { metaKey: true }), true)).toBe(action)
      expect(workbenchShortcut(key(code!, { metaKey: true }), false)).toBe(null)
      expect(workbenchShortcut(key(code!, { altKey: true }), false)).toBe(action)
    }
    expect(workbenchShortcut(key('Digit9', { altKey: true }), false)).toEqual({ nth: 8 })
    expect(workbenchShortcut(key('KeyN', { altKey: true, isComposing: true }), false)).toBeNull()
    expect(workbenchShortcut(key('KeyE', { metaKey: true, shiftKey: true }), true)).toBe('files')
  })
})
