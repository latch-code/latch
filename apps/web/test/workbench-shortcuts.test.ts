import { describe, expect, it } from 'vitest'
import { shortcutCaps, shortcutKeys, shortcutRows, shortcutWorksOnPage, workbenchShortcut } from '../src/workbenchShortcuts.ts'
const key = (code: string, extra = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra })
describe('workbench key routing', () => {
  it('reserves browser shortcuts and handles the documented alternate bindings', () => {
    for (const [code, action] of [
      ['KeyN', 'new'],
      ['KeyB', 'sidebar'],
      ['Slash', 'shortcuts'],
      ['KeyL', 'compose'],
      ['KeyP', 'file-search'],
      ['KeyW', 'close-file'],
    ]) {
      expect(workbenchShortcut(key(code!, { metaKey: true }), true)).toBe(action)
      expect(workbenchShortcut(key(code!, { metaKey: true }), false)).toBe(null)
      expect(workbenchShortcut(key(code!, { altKey: true }), false)).toBe(action)
    }
    // A Mac keeps ⌘[ and ⌘] for going back and forward, so the desktop app shifts them; a browser's Alt does not need to.
    for (const [code, action] of [
      ['BracketLeft', 'previous'],
      ['BracketRight', 'next'],
    ]) {
      expect(workbenchShortcut(key(code!, { metaKey: true, shiftKey: true }), true)).toBe(action)
      expect(workbenchShortcut(key(code!, { metaKey: true }), true)).toBeNull()
      expect(workbenchShortcut(key(code!, { altKey: true }), false)).toBe(action)
      expect(workbenchShortcut(key(code!, { altKey: true, shiftKey: true }), false)).toBeNull()
      expect(workbenchShortcut(key(code!, { metaKey: true }), false)).toBeNull()
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
    for (const action of ['new', 'sidebar', 'shortcuts', 'settings', { entry: 'agents' }] as const)
      expect(shortcutWorksOnPage(action)).toBe(true)
    for (const action of ['previous', 'next', 'files', 'file-search', 'close-file', 'compose', 'side-panel'] as const)
      expect(shortcutWorksOnPage(action)).toBe(false)
  })
  it('shows one kind of client its own keys and never the other kind', () => {
    const desktop = shortcutRows(true, true)
    const browser = shortcutRows(false, true)
    expect(desktop.find(row => row.id === 'new')?.keys).toBe('⌘N')
    expect(browser.find(row => row.id === 'new')?.keys).toBe('Alt N')
    expect(browser.some(row => row.id === 'quick-look')).toBe(false)
    expect(desktop.every(row => !row.keys.includes('Alt') && !row.keys.includes('Ctrl'))).toBe(true)
    expect(shortcutKeys('palette', false, true)).toBe('⌘K')
    expect(shortcutKeys('palette', false, false)).toBe('Ctrl K')
    expect(shortcutKeys('decide', false, false)).toBe('Ctrl Enter · Esc')
  })
  it('draws each key of a shortcut, and each alternative apart', () => {
    expect(shortcutCaps('⌘K')).toEqual([['⌘', 'K']])
    expect(shortcutCaps('⇧⌘[')).toEqual([['⇧', '⌘', '[']])
    expect(shortcutCaps('⌘,')).toEqual([['⌘', ',']])
    expect(shortcutCaps('Alt Shift B')).toEqual([['Alt', 'Shift', 'B']])
    expect(shortcutCaps('⏎ · ⇧⏎')).toEqual([['⏎'], ['⇧', '⏎']])
    expect(shortcutCaps('Ctrl Enter · Esc')).toEqual([['Ctrl', 'Enter'], ['Esc']])
    expect(shortcutCaps('esc esc')).toEqual([['esc', 'esc']])
  })
  it('lists a row for every action a key can trigger', () => {
    const ids = new Set<string>(shortcutRows(true, true).map(row => row.id))
    for (const code of ['KeyN', 'KeyB', 'KeyD', 'Slash', 'KeyP', 'KeyW', 'KeyL', 'Comma', 'Digit1', 'Digit4']) {
      const action = workbenchShortcut(key(code, { metaKey: true }), true)!
      expect(ids.has(typeof action === 'object' ? action.entry : action), code).toBe(true)
    }
    expect(ids.has('files') && ids.has('side-panel') && ids.has('previous') && ids.has('next')).toBe(true)
  })
})
