import { describe, expect, it } from 'vitest'
import { shortcutWorksOnPage, workbenchShortcut } from '../src/workbenchShortcuts.ts'
const key = (code: string, extra = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra })
describe('workbench key routing', () => {
  it('reserves browser shortcuts and handles the documented alternate bindings', () => {
    for (const [code, action] of [
      ['KeyN', 'new'],
      ['KeyB', 'sidebar'],
      ['BracketLeft', 'previous'],
      ['BracketRight', 'next'],
      ['Slash', 'help'],
      ['KeyL', 'compose'],
      ['KeyP', 'file-search'],
      ['KeyW', 'close-file'],
    ]) {
      expect(workbenchShortcut(key(code!, { metaKey: true }), true)).toBe(action)
      expect(workbenchShortcut(key(code!, { metaKey: true }), false)).toBe(null)
      expect(workbenchShortcut(key(code!, { altKey: true }), false)).toBe(action)
    }
    expect(workbenchShortcut(key('Digit2', { altKey: true }), false)).toEqual({ entry: 'agents' })
    expect(workbenchShortcut(key('Digit5', { altKey: true }), false)).toBeNull()
    expect(workbenchShortcut(key('Comma', { altKey: true }), false)).toBe('settings')
    expect(workbenchShortcut(key('KeyB', { altKey: true, shiftKey: true }), false)).toBe('side-panel')
    expect(workbenchShortcut(key('KeyB', { metaKey: true, altKey: true }), true)).toBe('side-panel')
    expect(workbenchShortcut(key('KeyB', { metaKey: true }), true)).toBe('sidebar')
    expect(workbenchShortcut(key('KeyN', { altKey: true, isComposing: true }), false)).toBeNull()
    expect(workbenchShortcut(key('KeyE', { metaKey: true, shiftKey: true }), true)).toBe('files')
    expect(workbenchShortcut(key('KeyE', { altKey: true, shiftKey: true }), false)).toBe('files')
  })
  it('keeps only what still shows over a page entry, whose session columns are hidden', () => {
    for (const action of ['new', 'sidebar', 'help', 'settings', { entry: 'agents' }] as const)
      expect(shortcutWorksOnPage(action)).toBe(true)
    for (const action of ['previous', 'next', 'files', 'file-search', 'close-file', 'compose', 'side-panel'] as const)
      expect(shortcutWorksOnPage(action)).toBe(false)
  })
})
