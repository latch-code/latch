import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SHORTCUTS, FIXED_SHORTCUTS, KEY_CODES, MENU_RESERVED, SYSTEM_RESERVED } from '@latch/protocol'

const require = createRequire(import.meta.url)
type Accelerators = { code: string | null; agents: string | null; pastePlainTextConflict?: true }
const menus = require('../src/menu.cjs') as {
  spaceAccelerator(chord: unknown): string | null
  ACCELERATOR_KEYS: ReadonlyMap<string, string>
  RESERVED_CHORDS: ReadonlySet<string>
  DEFAULT_SPACE_ACCELERATORS: Accelerators
  menuTemplate(input: { packaged: boolean; onCheckForUpdates(): void; onPastePlainText?(): void; accelerators?: Accelerators }): Array<{
    submenu: Array<{ id?: string; accelerator?: string; click?(): void }>
  }>
  spaceMenu(input: {
    focused(): unknown
    item(id: string): { enabled: boolean } | undefined
    rebuild?(accelerators: Accelerators): void
  }): {
    ready(contents: unknown, ready: boolean): void
    keys(contents: unknown, keys: unknown): void
    sync(): void
  }
}

describe('the menu bar keys of Code and 我的 Agent', () => {
  it('takes only the protocol’s key codes, and no name that reaches a prototype', () => {
    expect([...menus.ACCELERATOR_KEYS.keys()].sort()).toEqual([...KEY_CODES].sort())
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'prototype'])
      for (const prefix of ['Mod+', 'Alt+', 'Mod+Alt+Shift+']) expect(menus.spaceAccelerator(`${prefix}${name}`), name).toBeNull()
    // A refused chord leaves the item without keys, never with text the page sent.
    let built: Accelerators | undefined
    const contents = {}
    const menu = menus.spaceMenu({ focused: () => contents, item: () => undefined, rebuild: value => (built = value) })
    menu.keys(contents, { code: 'Mod+constructor', agents: 'Mod+__proto__' })
    expect(built).toEqual({ code: null, agents: null })
  })

  it('refuses every chord the page refuses for them, by the same lists', () => {
    for (const chord of [...SYSTEM_RESERVED, ...MENU_RESERVED, ...FIXED_SHORTCUTS.desktop.map(entry => entry.chord)])
      expect(menus.RESERVED_CHORDS.has(chord), chord).toBe(true)
    expect(menus.spaceAccelerator(DEFAULT_SHORTCUTS['space-code'].desktop)).toBe(menus.DEFAULT_SPACE_ACCELERATORS.code)
    expect(menus.spaceAccelerator(DEFAULT_SHORTCUTS['space-agents'].desktop)).toBe(menus.DEFAULT_SPACE_ACCELERATORS.agents)
    expect(menus.spaceAccelerator('Mod+Alt+KeyY')).toBe('Alt+CmdOrCtrl+Y')
    expect(menus.spaceAccelerator('Mod+Shift+BracketLeft')).toBe('Shift+CmdOrCtrl+[')
    for (const bad of [
      'Mod+KeyQ',
      'Mod+Digit3',
      'KeyY',
      'Shift+KeyY',
      'Mod+KeyY+Alt',
      'CmdOrCtrl+Y',
      'Mod+Nope',
      1,
      null,
      'Mod+'.repeat(10),
    ])
      expect(menus.spaceAccelerator(bad), String(bad)).toBeNull()
  })

  it("builds the menu again with the focused window's keys, and with none for a refused one", () => {
    const built: Accelerators[] = []
    const entries = { 'space-code': { enabled: false }, 'space-agents': { enabled: false } }
    const listeners = new Map<string, () => void>()
    const page = { on: (name: string, listener: () => void) => listeners.set(name, listener) }
    let focused: unknown = page
    const spaces = menus.spaceMenu({
      focused: () => focused,
      item: id => entries[id as keyof typeof entries],
      rebuild: keys => built.push(keys),
    })
    spaces.ready(page, true)
    expect(built).toEqual([])
    spaces.keys(page, { code: 'Mod+Alt+KeyY', agents: 'Mod+KeyQ' })
    expect(built).toEqual([{ code: 'Alt+CmdOrCtrl+Y', agents: null }])
    expect(entries['space-code'].enabled).toBe(true)
    const template = menus.menuTemplate({ packaged: true, onCheckForUpdates: () => {}, accelerators: built[0]! })
    const items = template.flatMap(menu => menu.submenu)
    expect(items.find(item => item.id === 'space-code')?.accelerator).toBe('Alt+CmdOrCtrl+Y')
    expect(items.find(item => item.id === 'space-agents')).not.toHaveProperty('accelerator')
    // Another window with no keys of its own: the defaults again. A new document forgets the page's keys.
    focused = {}
    spaces.sync()
    expect(built.at(-1)).toEqual(menus.DEFAULT_SPACE_ACCELERATORS)
    focused = page
    spaces.sync()
    expect(built.at(-1)).toEqual({ code: 'Alt+CmdOrCtrl+Y', agents: null })
    listeners.get('did-navigate')?.()
    expect(built.at(-1)).toEqual(menus.DEFAULT_SPACE_ACCELERATORS)
  })

  it('keeps a custom shortcut for the focused window and still offers the plain-text paste menu action', () => {
    let focused = {}
    let shown = menus.DEFAULT_SPACE_ACCELERATORS
    let pastes = 0
    const spaces = menus.spaceMenu({ focused: () => focused, item: () => undefined, rebuild: keys => (shown = keys) })
    const paste = () =>
      menus
        .menuTemplate({ packaged: true, onCheckForUpdates() {}, onPastePlainText: () => pastes++, accelerators: shown })
        .flatMap(menu => menu.submenu)
        .find(item => item.id === 'paste-plain-text')!

    spaces.keys(focused, { code: 'Mod+Shift+KeyV', agents: 'Mod+Shift+Digit2' })
    expect(shown.code).toBe('Shift+CmdOrCtrl+V')
    expect(paste()).not.toHaveProperty('accelerator')
    paste().click!()
    expect(pastes).toBe(1)
    spaces.keys(focused, { code: 'Mod+Shift+Digit1', agents: 'Mod+Shift+Digit2', pastePlainTextConflict: true })
    expect(paste()).not.toHaveProperty('accelerator')
    focused = {}
    spaces.sync()
    expect(paste().accelerator).toBe('Command+Shift+V')
  })
})
