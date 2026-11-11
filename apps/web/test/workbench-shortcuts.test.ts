import { describe, expect, it } from 'vitest'
import {
  shortcutButtonKeys,
  shortcutCaps,
  shortcutKeys,
  shortcutRows,
  shortcutWorksOnPage,
  workbenchShortcut,
} from '../src/workbenchShortcuts.ts'
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
    expect(workbenchShortcut(key('Comma', { altKey: true }), false)).toBe('settings')
    expect(workbenchShortcut(key('KeyB', { altKey: true, shiftKey: true }), false)).toBe('side-panel')
    expect(workbenchShortcut(key('KeyB', { metaKey: true, altKey: true }), true)).toBe('side-panel')
    expect(workbenchShortcut(key('KeyB', { metaKey: true }), true)).toBe('sidebar')
    expect(workbenchShortcut(key('KeyN', { altKey: true, isComposing: true }), false)).toBeNull()
    expect(workbenchShortcut(key('KeyE', { metaKey: true, shiftKey: true }), true)).toBe('files')
    expect(workbenchShortcut(key('KeyE', { altKey: true, shiftKey: true }), false)).toBe('files')
  })
  it('jumps to the Nth session with a digit and opens a composer control with ⌥ (desktop) or Shift (browser)', () => {
    for (let index = 1; index <= 9; index++) {
      const code = `Digit${String(index)}`
      const session = { kind: 'session', index }
      expect(workbenchShortcut(key(code, { metaKey: true }), true)).toEqual(session)
      expect(workbenchShortcut(key(code, { altKey: true }), false)).toEqual(session)
      // Each client has only its own keys.
      expect(workbenchShortcut(key(code, { metaKey: true }), false)).toBeNull()
      expect(workbenchShortcut(key(code, { altKey: true }), true)).toBeNull()
      // ⇧ with ⌘ is nothing in the desktop app; the browser has no ⌘ digits at all.
      expect(workbenchShortcut(key(code, { metaKey: true, shiftKey: true }), true)).toBeNull()
      expect(workbenchShortcut(key(code, { metaKey: true, altKey: true, shiftKey: true }), true)).toBeNull()
      expect(workbenchShortcut(key(code, { altKey: true, ctrlKey: true }), false)).toBeNull()
      expect(workbenchShortcut(key(code), false)).toBeNull()
      expect(workbenchShortcut(key(code, { metaKey: true, isComposing: true }), true)).toBeNull()
      expect(workbenchShortcut(key(code, { altKey: true, isComposing: true }), false)).toBeNull()
    }
    for (const [index, control] of ['harness', 'model', 'thinking', 'permission'].entries()) {
      const code = `Digit${String(index + 1)}`
      expect(workbenchShortcut(key(code, { metaKey: true, altKey: true }), true)).toEqual({ kind: 'control', control })
      expect(workbenchShortcut(key(code, { altKey: true, shiftKey: true }), false)).toEqual({ kind: 'control', control })
      expect(workbenchShortcut(key(code, { metaKey: true, altKey: true }), false)).toBeNull()
      expect(workbenchShortcut(key(code, { altKey: true, shiftKey: true, isComposing: true }), false)).toBeNull()
    }
    for (const code of ['Digit5', 'Digit9']) {
      expect(workbenchShortcut(key(code, { metaKey: true, altKey: true }), true)).toBeNull()
      expect(workbenchShortcut(key(code, { altKey: true, shiftKey: true }), false)).toBeNull()
    }
    expect(workbenchShortcut(key('Digit0', { metaKey: true }), true)).toBeNull()
    expect(workbenchShortcut(key('Digit0', { altKey: true }), false)).toBeNull()
  })
  it('keeps only what still shows over a page, whose session columns are hidden', () => {
    for (const action of ['new', 'sidebar', 'shortcuts', 'settings'] as const) expect(shortcutWorksOnPage(action)).toBe(true)
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
    expect(shortcutKeys('session', true)).toBe('⌘1 … ⌘9')
    expect(shortcutKeys('session', false, true)).toBe('Alt 1 … Alt 9')
    expect(shortcutKeys('controls', true)).toBe('⌥⌘1 … ⌥⌘4')
    expect(shortcutKeys('controls', false, false)).toBe('Alt Shift 1 … Alt Shift 4')
  })
  it('keeps the 21 keys there were, and adds the session and control keys', () => {
    const before = {
      settings: ['⌘,', 'Alt ,'],
      new: ['⌘N', 'Alt N'],
      palette: ['⌘K', 'Ctrl K'],
      sidebar: ['⌘B', 'Alt B'],
      'side-panel': ['⌥⌘B', 'Alt Shift B'],
      changes: ['⌘D', 'Alt D'],
      find: ['⌘F', 'Ctrl F'],
      'find-step': ['⏎ · ⇧⏎', 'Enter · Shift Enter'],
      'file-search': ['⌘P', 'Alt P'],
      files: ['⇧⌘E', 'Alt Shift E'],
      'close-file': ['⌘W', 'Alt W'],
      'quick-look': ['Space', null],
      previous: ['⇧⌘[', 'Alt ['],
      next: ['⇧⌘]', 'Alt ]'],
      'next-approval': ['⌥⌘A', 'Alt Shift A'],
      decide: ['⌘⏎ · esc', 'Ctrl Enter · Esc'],
      compose: ['⌘L', 'Alt L'],
      recall: ['↑', '↑'],
      stop: ['esc esc', 'Esc Esc'],
      'undo-archive': ['⌘Z', 'Ctrl Z'],
      shortcuts: ['⌘/', 'Alt /'],
    } as const
    expect(Object.keys(before)).toHaveLength(21)
    for (const [id, [desktop, browser]] of Object.entries(before)) {
      expect(shortcutKeys(id as keyof typeof before, true), id).toBe(desktop)
      expect(shortcutKeys(id as keyof typeof before, false, false), id).toBe(browser)
    }
    expect(shortcutRows(true, true).map(row => row.id)).toHaveLength(23)
  })
  it('gives a button the keys that press it, in the names its caps take', () => {
    expect(shortcutButtonKeys('new', true)).toEqual(['mod', 'N'])
    expect(shortcutButtonKeys('new', false)).toEqual(['alt', 'N'])
    expect(shortcutButtonKeys('palette', false, true)).toEqual(['mod', 'K'])
    expect(shortcutButtonKeys('palette', false, false)).toEqual(['ctrl', 'K'])
    expect(shortcutButtonKeys('changes', true)).toEqual(['mod', 'D'])
    expect(shortcutButtonKeys('side-panel', true)).toEqual(['alt', 'mod', 'B'])
    // A range or alternatives is not one key to draw on a button.
    expect(shortcutButtonKeys('session', true)).toBeNull()
    expect(shortcutButtonKeys('decide', true)).toBeNull()
    expect(shortcutButtonKeys('quick-look', false)).toBeNull()
  })
  it('draws each key of a shortcut, each alternative apart and the ends of a range', () => {
    const caps = (keys: string) => shortcutCaps(keys).map(part => part.caps)
    expect(caps('⌘K')).toEqual([['⌘', 'K']])
    expect(caps('⇧⌘[')).toEqual([['⇧', '⌘', '[']])
    expect(caps('⌘,')).toEqual([['⌘', ',']])
    expect(caps('Alt Shift B')).toEqual([['Alt', 'Shift', 'B']])
    expect(caps('⏎ · ⇧⏎')).toEqual([['⏎'], ['⇧', '⏎']])
    expect(caps('Ctrl Enter · Esc')).toEqual([['Ctrl', 'Enter'], ['Esc']])
    expect(caps('esc esc')).toEqual([['esc', 'esc']])
    expect(shortcutCaps('⏎ · ⇧⏎').map(part => part.join)).toEqual([null, '或'])
    expect(shortcutCaps('⌥⌘1 … ⌥⌘4')).toEqual([
      { join: null, caps: ['⌥', '⌘', '1'] },
      { join: '…', caps: ['⌥', '⌘', '4'] },
    ])
    expect(shortcutCaps('Alt Shift 1 … Alt Shift 4').map(part => part.caps)).toEqual([
      ['Alt', 'Shift', '1'],
      ['Alt', 'Shift', '4'],
    ])
  })
  it('lists a row for every action a key can trigger', () => {
    const ids = new Set<string>(shortcutRows(true, true).map(row => row.id))
    for (const code of ['KeyN', 'KeyB', 'KeyD', 'Slash', 'KeyP', 'KeyW', 'KeyL', 'Comma']) {
      const action = workbenchShortcut(key(code, { metaKey: true }), true)!
      expect(typeof action === 'string' && ids.has(action), code).toBe(true)
    }
    expect(ids.has('session') && ids.has('controls')).toBe(true)
    expect(ids.has('files') && ids.has('side-panel') && ids.has('previous') && ids.has('next')).toBe(true)
  })
})
