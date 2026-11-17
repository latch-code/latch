import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, parseChord, type ShortcutAction, type ShortcutChord } from '@latch/protocol'
import { clientKind, shortcutBindings } from './core/shortcutBindings.ts'

export type WorkbenchAction =
  | 'new'
  | 'sidebar'
  | 'previous'
  | 'next'
  | 'shortcuts'
  | 'files'
  | 'changes'
  | 'terminal'
  /** ⇧⌘B: the 浏览器 tab, only in the desktop app. */
  | 'browser'
  | 'file-search'
  | 'close-file'
  | 'compose'
  | 'side-panel'
  /** ⌥⌘T: the right panel's 「+」 menu. */
  | 'panel-add'
  | 'settings'
  /** ⇧⌘U: 额度与用量. */
  | 'usage'
  /** ⌥⌘L: 对话 or 看板. */
  | 'view'
  /** ⇧⌘1 and ⇧⌘2: Code and 我的 Agent. */
  | { kind: 'space'; space: 'code' | 'agents' }
  /** ⌘1 to ⌘9: the Nth session as the sidebar draws it. */
  | { kind: 'session'; index: number }
  /** ⌥⌘1 to ⌥⌘4: open one of the composer's four controls. */
  | { kind: 'control'; control: ComposerControl }
  | TerminalPaneAction

/** ⌘\ and ⇧⌘\ split the terminal's pane side by side or stacked; ⌥⌘] and ⌥⌘[ go to its next or previous pane. */
export type TerminalPaneAction = { kind: 'terminal-split'; direction: 'row' | 'column' } | { kind: 'terminal-pane'; step: 1 | -1 }

/** The composer's four controls in key order; each is the trigger inside `[data-composer-control="<name>"]`. */
export const COMPOSER_CONTROLS = ['harness', 'model', 'thinking', 'permission'] as const
export type ComposerControl = (typeof COMPOSER_CONTROLS)[number]

interface KeyStroke {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  /** The character the layout made of it (`KeyboardEvent.key`). */
  key?: string
  /** Focus is in a field that takes text. */
  typing?: boolean
}

const PLAIN_KEYS: Partial<Record<string, string>> = { BracketLeft: '[', BracketRight: ']', Slash: '/' }

/**
 * Whether a browser's Alt chord is typing: in a field, the layout made a character of it other than the key's own (a
 * German Mac's ⌥5 is [, a French one's ⌥( is {, a US one's ⌥1 is ¡), or a dead key that starts one (⌥E). Elsewhere the
 * same chord is the shortcut.
 */
function typesCharacter(event: KeyStroke): boolean {
  if (!event.typing || event.key === undefined) return false
  if (event.key === 'Dead') return true
  if ([...event.key].length !== 1) return false
  const own = /^Digit(\d)$/u.exec(event.code)?.[1] ?? /^Key([A-Z])$/u.exec(event.code)?.[1]?.toLowerCase() ?? PLAIN_KEYS[event.code]
  return own === undefined || event.key.toLowerCase() !== own
}

/**
 * Every shortcut that works, with the keys of each kind of client: 设置 › 快捷键 and the palette show this client's only.
 * `Mod` in a browser binding is ⌘ on a Mac and Ctrl elsewhere. The actions in `SHORTCUT_ACTIONS` take this device's own
 * binding (`shortcutBindings`), else their default (`DEFAULT_SHORTCUTS`); the rest are fixed and written out here.
 * Browser bindings avoid its new-window, close-tab, history and address-bar shortcuts.
 */
const SHORTCUTS = [
  { id: 'settings', label: '设置' },
  { id: 'new', label: '新会话' },
  { id: 'space-code', label: 'Code' },
  { id: 'space-agents', label: '我的 Agent' },
  { id: 'palette', label: '搜索' },
  { id: 'sidebar', label: '收起或展开侧栏' },
  { id: 'side-panel', label: '侧边面板' },
  { id: 'panel-add', label: '在侧边面板打开…' },
  { id: 'view', label: '切换对话、看板' },
  { id: 'changes', label: '改动' },
  { id: 'terminal', label: '终端' },
  { id: 'terminal-split', label: '终端左右分屏', desktop: '⌘\\', browser: null },
  { id: 'terminal-split-down', label: '终端上下分屏', desktop: '⇧⌘\\', browser: null },
  { id: 'terminal-pane', label: '终端的下一个、上一个窗格', desktop: '⌥⌘] · ⌥⌘[', browser: null },
  { id: 'browser', label: '浏览器' },
  { id: 'pick', label: '在浏览器里选取元素' },
  { id: 'find', label: '在会话中查找' },
  { id: 'find-step', label: '下一个、上一个匹配', desktop: '⏎ · ⇧⏎', browser: 'Enter · Shift Enter' },
  { id: 'file-search', label: '搜索文件' },
  { id: 'files', label: '浏览文件、切换文件标签' },
  { id: 'close-file', label: '关闭当前文件' },
  { id: 'quick-look', label: '快速查看预览中的文件', desktop: 'Space', browser: null },
  { id: 'previous', label: '上一个会话' },
  { id: 'next', label: '下一个会话' },
  // While the model panel is open it takes the same keys for its Nth model.
  { id: 'session', label: '跳到第 N 个会话 · 模型面板里选第 N 个模型', desktop: '⌘1 … ⌘9', browser: 'Alt 1 … Alt 9' },
  { id: 'next-approval', label: '下一个等你处理的请求' },
  { id: 'decide', label: '允许、拒绝选中的请求', desktop: '⌘⏎ · esc', browser: 'Mod Enter · Esc' },
  { id: 'compose', label: '聚焦输入框' },
  { id: 'controls', label: 'Harness · 模型 · 思考 · 权限', desktop: '⌥⌘1 … ⌥⌘4', browser: 'Alt Shift 1 … Alt Shift 4' },
  { id: 'recall', label: '空输入框取回上一条消息', desktop: '↑', browser: '↑' },
  { id: 'stop', label: '在输入框里停止运行', desktop: 'esc esc', browser: 'Esc Esc' },
  { id: 'undo-archive', label: '撤销归档', desktop: '⌘Z', browser: 'Mod Z' },
  { id: 'usage', label: '额度与用量' },
  { id: 'shortcuts', label: '快捷键' },
] as const

export type ShortcutId = (typeof SHORTCUTS)[number]['id']
type Row = { id: ShortcutId; label: string; desktop?: string | null; browser?: string | null }
const ROWS: readonly Row[] = SHORTCUTS

const onMac = () => /Mac/u.test(navigator.platform)

/** Whether an action takes this device's own binding (设置 › 快捷键); the others are fixed. */
export const isRebindable = (id: string): id is ShortcutAction => (SHORTCUT_ACTIONS as readonly string[]).includes(id)

const KEY_TEXT: Partial<Record<string, readonly [desktop: string, browser: string]>> = {
  Comma: [',', ','],
  Period: ['.', '.'],
  Slash: ['/', '/'],
  Backslash: ['\\', '\\'],
  BracketLeft: ['[', '['],
  BracketRight: [']', ']'],
  Semicolon: [';', ';'],
  Quote: ["'", "'"],
  Minus: ['-', '-'],
  Equal: ['=', '='],
  Backquote: ['`', '`'],
  Enter: ['⏎', 'Enter'],
  Space: ['Space', 'Space'],
  Tab: ['⇥', 'Tab'],
  Escape: ['esc', 'Esc'],
  Backspace: ['⌫', 'Backspace'],
  ArrowUp: ['↑', '↑'],
  ArrowDown: ['↓', '↓'],
  ArrowLeft: ['←', '←'],
  ArrowRight: ['→', '→'],
}

/**
 * A chord as this kind of client writes it: the desktop app's glyphs in the Mac's order (⌥⇧⌘N), a browser's words
 * (`Alt Shift N`, `Mod K`; `Mod` becomes ⌘ or Ctrl where it is shown).
 */
export function chordText(chord: ShortcutChord, desktop: boolean): string | null {
  const parsed = parseChord(chord)
  if (!parsed) return null
  const key =
    KEY_TEXT[parsed.code]?.[desktop ? 0 : 1]
    ?? /^Key([A-Z])$/u.exec(parsed.code)?.[1]
    ?? /^Digit(\d)$/u.exec(parsed.code)?.[1]
    ?? parsed.code
  if (desktop) return `${parsed.alt ? '⌥' : ''}${parsed.shift ? '⇧' : ''}${parsed.mod ? '⌘' : ''}${key}`
  return [parsed.mod && 'Mod', parsed.alt && 'Alt', parsed.shift && 'Shift', key].filter(Boolean).join(' ')
}

/** The keys an action has here now: this device's binding, else its default; null where this client lacks it. */
export function boundChord(id: ShortcutAction, desktop: boolean): ShortcutChord | null {
  if (DEFAULT_SHORTCUTS[id][desktop ? 'desktop' : 'browser'] === null) return null
  const own = shortcutBindings.bindings()
  // The store is this client's own kind; a test may ask about the other kind, which then shows its defaults.
  const bound = (desktop ? 'desktop' : 'browser') === clientKind() ? own[id] : undefined
  return bound ?? DEFAULT_SHORTCUTS[id][desktop ? 'desktop' : 'browser']
}

/** The keys on this kind of client; null for what it cannot do. */
export function shortcutKeys(id: ShortcutId, desktop: boolean, mac: boolean = onMac()): string | null {
  const row = ROWS.find(item => item.id === id)!
  const written = isRebindable(id) ? (boundChord(id, desktop) ?? null) : desktop ? row.desktop : row.browser
  const keys = written === undefined || written === null ? null : isRebindable(id) ? chordText(written, desktop) : written
  if (desktop || keys === null) return keys
  return keys.replace(/Mod /gu, mac ? '⌘' : 'Ctrl ')
}

/** The keys that go to a place only where there are two: without 我的 Agent they would do nothing. */
const SPACE_SHORTCUTS: ReadonlySet<ShortcutId> = new Set(['space-code', 'space-agents'])

export function shortcutRows(
  desktop: boolean,
  mac: boolean = onMac(),
  { spaces = true, delegate = true }: { spaces?: boolean; delegate?: boolean } = {},
): Array<{ id: ShortcutId; label: string; keys: string }> {
  return SHORTCUTS.flatMap(({ id, label: named }) => {
    if (!spaces && SPACE_SHORTCUTS.has(id)) return []
    // In 我的 Agent the same key is 新对话…, said only where this device can start one.
    const label = id === 'new' && spaces && delegate ? '新会话 · 新对话' : named
    const keys = shortcutKeys(id, desktop, mac)
    return keys === null ? [] : [{ id, label, keys }]
  })
}

/**
 * A shortcut as the keys to draw: each part split into its keys, with what joins it to the one before (「或」 between
 * alternatives, 「…」 between the ends of a range).
 */
export function shortcutCaps(keys: string): Array<{ join: '或' | '…' | null; caps: string[] }> {
  return keys.split(' · ').flatMap((alternative, index) =>
    alternative.split(' … ').map((part, end) => ({
      join: end > 0 ? ('…' as const) : index > 0 ? ('或' as const) : null,
      caps: part.match(/[⌘⇧⌥⌃]|[^\s⌘⇧⌥⌃]+/gu) ?? [],
    })),
  )
}

/** A part's keys as one run of text: 「⌘N」 where the modifiers are glyphs, 「Alt N」 where they are words. */
export const capsText = (caps: readonly string[]): string => caps.join(caps.some(cap => /^[⌘⇧⌥⌃]$/u.test(cap)) ? '' : ' ')

const BUTTON_KEYS: Record<string, string> = { '⌘': 'mod', '⇧': 'shift', '⌥': 'alt', '⌃': 'ctrl', Alt: 'alt', Shift: 'shift', Ctrl: 'ctrl' }

/** A one-part shortcut as a Button's `keys` (`['mod', 'N']`), for the button that key presses; null for what this client lacks. */
export function shortcutButtonKeys(id: ShortcutId, desktop: boolean, mac: boolean = onMac()): string[] | null {
  const keys = shortcutKeys(id, desktop, mac)
  const [part, ...more] = keys === null ? [] : shortcutCaps(keys)
  if (!part || more.length) return null
  return part.caps.map(cap => BUTTON_KEYS[cap] ?? cap)
}

/** What still shows over a page, which hides the session's columns: moving to another page, and what opens above it. */
export function shortcutWorksOnPage(action: WorkbenchAction): boolean {
  return (
    action === 'new'
    || action === 'sidebar'
    || action === 'shortcuts'
    || action === 'settings'
    || action === 'usage'
    || action === 'view'
    || (typeof action === 'object' && action.kind === 'space')
  )
}
/** The actions the workbench's own key handler answers; the others' keys are matched where they act (`shortcutMatches`). */
const WORKBENCH_ACTIONS = [
  'new',
  'sidebar',
  'side-panel',
  'panel-add',
  'view',
  'changes',
  'terminal',
  'browser',
  'file-search',
  'files',
  'close-file',
  'previous',
  'next',
  'compose',
  'usage',
  'shortcuts',
  'settings',
  'space-code',
  'space-agents',
] as const satisfies readonly ShortcutAction[]

/** Whether the keys pressed are exactly the chord: `Mod` is ⌘ or Ctrl, and Alt and Shift must match. */
export function chordMatches(event: KeyStroke, chord: ShortcutChord | null): boolean {
  const parsed = chord === null ? null : parseChord(chord)
  return (
    parsed !== null
    && event.code === parsed.code
    && (event.metaKey || event.ctrlKey) === parsed.mod
    && event.altKey === parsed.alt
    && event.shiftKey === parsed.shift
  )
}

/** Whether the event is the bound keys of an action matched outside the workbench handler (the palette, 查找, 选取, 下一个请求). */
export function shortcutMatches(event: KeyStroke, id: ShortcutAction, desktop: boolean): boolean {
  if (event.isComposing) return false
  if (!desktop && event.altKey && typesCharacter(event)) return false
  return chordMatches(event, boundChord(id, desktop))
}

export function workbenchShortcut(event: KeyStroke, desktop: boolean): WorkbenchAction | null {
  if (event.isComposing) return null
  if (!desktop && event.altKey && typesCharacter(event)) return null
  // This device's bindings first: none of them can take a fixed key below (`shortcutRefusal`).
  for (const id of WORKBENCH_ACTIONS) {
    if (!chordMatches(event, boundChord(id, desktop))) continue
    if (id === 'space-code' || id === 'space-agents') return { kind: 'space', space: id === 'space-code' ? 'code' : 'agents' }
    return id
  }
  // The fixed keys. Digits: their ⌥ (the desktop app's) or Shift (a browser's) picks a control instead of a session.
  const digit = /^Digit([1-9])$/u.exec(event.code)?.[1]
  if (digit !== undefined) {
    const index = Number(digit)
    const held = desktop ? (event.metaKey || event.ctrlKey) && !event.shiftKey : event.altKey && !event.metaKey && !event.ctrlKey
    if (!held) return null
    const control = desktop ? event.altKey : event.shiftKey
    if (!control) return { kind: 'session', index }
    return index <= COMPOSER_CONTROLS.length ? { kind: 'control', control: COMPOSER_CONTROLS[index - 1]! } : null
  }
  // The terminal's panes: the desktop app only, as the terminal itself. ⌘ chords are the only keys that leave it.
  if (desktop && (event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey) {
    if (event.code === 'BracketRight') return { kind: 'terminal-pane', step: 1 }
    if (event.code === 'BracketLeft') return { kind: 'terminal-pane', step: -1 }
  }
  if (desktop && event.code === 'Backslash' && (event.metaKey || event.ctrlKey) && !event.altKey)
    return { kind: 'terminal-split', direction: event.shiftKey ? 'column' : 'row' }
  return null
}

/** A terminal pane key: the screen leaves it to the workbench rather than encoding it for the shell. */
export function isTerminalPaneKey(event: KeyStroke): boolean {
  const action = workbenchShortcut(event, true)
  return typeof action === 'object' && action !== null && (action.kind === 'terminal-split' || action.kind === 'terminal-pane')
}
