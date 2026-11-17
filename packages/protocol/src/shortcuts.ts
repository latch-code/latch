/*
 * 快捷键 (docs/CUSTOMIZATION.md#快捷键): the keys a device may rebind, the chords they may take, and the rules that refuse
 * one. A device keeps its own bindings on the Host as a document; the Host and the page check it with the same rules and
 * refuse, never correct.
 */

export const SHORTCUTS_SCHEMA = 1

/** Each kind of client has its own keys: the desktop app and a browser. */
export const SHORTCUT_CLIENTS = ['desktop', 'browser'] as const
export type ShortcutClient = (typeof SHORTCUT_CLIENTS)[number]

/** The actions a device may rebind, each one key chord. */
export const SHORTCUT_ACTIONS = [
  'settings',
  'new',
  'space-code',
  'space-agents',
  'palette',
  'sidebar',
  'side-panel',
  'panel-add',
  'view',
  'changes',
  'terminal',
  'browser',
  'pick',
  'find',
  'file-search',
  'files',
  'close-file',
  'previous',
  'next',
  'next-approval',
  'compose',
  'usage',
  'shortcuts',
] as const
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number]

/**
 * A chord: optional `Mod` (⌘ on a Mac, Ctrl elsewhere; either key matches), `Alt` and `Shift`, in that order, then one
 * `KeyboardEvent.code`. It needs `Mod` or `Alt`: a bare key or a Shift chord is typing.
 */
export type ShortcutChord = string

/** Every key code a chord may end in; the desktop menu keeps the same list (`menu.cjs`). */
export const KEY_CODES = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `Key${letter}`),
  ...'0123456789'.split('').map(digit => `Digit${digit}`),
  'Comma',
  'Period',
  'Slash',
  'Backslash',
  'BracketLeft',
  'BracketRight',
  'Semicolon',
  'Quote',
  'Minus',
  'Equal',
  'Backquote',
  'Enter',
  'Space',
  'Tab',
  'Escape',
  'Backspace',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
] as const
const KEY_CODE_SET: ReadonlySet<string> = new Set(KEY_CODES)
const CHORD = /^(Mod\+)?(Alt\+)?(Shift\+)?([A-Za-z0-9]+)$/u
const MAX_CHORD = 32

export interface ParsedChord {
  mod: boolean
  alt: boolean
  shift: boolean
  code: string
}

/** A chord's parts, or null for anything outside the grammar (a bare key and a Shift-only chord included). */
export function parseChord(chord: unknown): ParsedChord | null {
  if (typeof chord !== 'string' || chord.length > MAX_CHORD) return null
  const match = CHORD.exec(chord)
  if (!match || !KEY_CODE_SET.has(match[4]!)) return null
  const parsed = { mod: !!match[1], alt: !!match[2], shift: !!match[3], code: match[4]! }
  return parsed.mod || parsed.alt ? parsed : null
}

export function formatChord({ mod, alt, shift, code }: ParsedChord): ShortcutChord {
  return `${mod ? 'Mod+' : ''}${alt ? 'Alt+' : ''}${shift ? 'Shift+' : ''}${code}`
}

/** Today's keys of each action, by kind of client; null where that client has no such action. */
export const DEFAULT_SHORTCUTS: Readonly<Record<ShortcutAction, Readonly<Record<ShortcutClient, ShortcutChord | null>>>> = {
  settings: { desktop: 'Mod+Comma', browser: 'Alt+Comma' },
  new: { desktop: 'Mod+KeyN', browser: 'Alt+KeyN' },
  'space-code': { desktop: 'Mod+Shift+Digit1', browser: 'Mod+Shift+Digit1' },
  'space-agents': { desktop: 'Mod+Shift+Digit2', browser: 'Mod+Shift+Digit2' },
  palette: { desktop: 'Mod+KeyK', browser: 'Mod+KeyK' },
  sidebar: { desktop: 'Mod+KeyB', browser: 'Alt+KeyB' },
  'side-panel': { desktop: 'Mod+Alt+KeyB', browser: 'Alt+Shift+KeyB' },
  'panel-add': { desktop: 'Mod+Alt+KeyT', browser: 'Alt+Shift+KeyT' },
  view: { desktop: 'Mod+Alt+KeyL', browser: 'Alt+Shift+KeyL' },
  changes: { desktop: 'Mod+KeyD', browser: 'Alt+KeyD' },
  terminal: { desktop: 'Mod+KeyJ', browser: 'Alt+KeyJ' },
  browser: { desktop: 'Mod+Shift+KeyB', browser: null },
  pick: { desktop: 'Mod+Shift+KeyS', browser: null },
  find: { desktop: 'Mod+KeyF', browser: 'Mod+KeyF' },
  'file-search': { desktop: 'Mod+KeyP', browser: 'Alt+KeyP' },
  files: { desktop: 'Mod+Shift+KeyE', browser: 'Alt+Shift+KeyE' },
  'close-file': { desktop: 'Mod+KeyW', browser: 'Alt+KeyW' },
  previous: { desktop: 'Mod+Shift+BracketLeft', browser: 'Alt+BracketLeft' },
  next: { desktop: 'Mod+Shift+BracketRight', browser: 'Alt+BracketRight' },
  'next-approval': { desktop: 'Mod+Alt+KeyA', browser: 'Alt+Shift+KeyA' },
  compose: { desktop: 'Mod+KeyL', browser: 'Alt+KeyL' },
  usage: { desktop: 'Mod+Shift+KeyU', browser: 'Alt+Shift+KeyU' },
  shortcuts: { desktop: 'Mod+Slash', browser: 'Alt+Slash' },
}

/** The human name of each action, as 设置 › 快捷键 and a refusal say it. */
export const SHORTCUT_ACTION_LABELS: Readonly<Record<ShortcutAction, string>> = {
  settings: '设置',
  new: '新会话',
  'space-code': 'Code',
  'space-agents': '我的 Agent',
  palette: '搜索',
  sidebar: '收起或展开侧栏',
  'side-panel': '侧边面板',
  'panel-add': '在侧边面板打开…',
  view: '切换对话、看板',
  changes: '改动',
  terminal: '终端',
  browser: '浏览器',
  pick: '在浏览器里选取元素',
  find: '在会话中查找',
  'file-search': '搜索文件',
  files: '浏览文件、切换文件标签',
  'close-file': '关闭当前文件',
  previous: '上一个会话',
  next: '下一个会话',
  'next-approval': '下一个等你处理的请求',
  compose: '聚焦输入框',
  usage: '额度与用量',
  shortcuts: '快捷键',
}

const digits = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `${prefix}Digit${from + index}`)

/**
 * Keys that stay as they are, by kind of client, with what they do: ranges (the Nth session, the composer's controls),
 * the terminal's panes, approving or refusing a request (a rebind must never make approving easier to hit), undoing an
 * archive and the safe-mode keys. Bare keys (Esc Esc, ↑, Space, Enter) are outside the grammar.
 */
export const FIXED_SHORTCUTS: Readonly<Record<ShortcutClient, ReadonlyArray<{ chord: ShortcutChord; label: string }>>> = {
  desktop: [
    ...digits('Mod+', 1, 9).map(chord => ({ chord, label: '跳到第 N 个会话' })),
    ...digits('Mod+Alt+', 1, 4).map(chord => ({ chord, label: 'Harness · 模型 · 思考 · 权限' })),
    { chord: 'Mod+Backslash', label: '终端左右分屏' },
    { chord: 'Mod+Shift+Backslash', label: '终端上下分屏' },
    { chord: 'Mod+Alt+BracketRight', label: '终端的下一个窗格' },
    { chord: 'Mod+Alt+BracketLeft', label: '终端的上一个窗格' },
    { chord: 'Mod+Enter', label: '允许选中的请求' },
    { chord: 'Mod+KeyZ', label: '撤销归档' },
    { chord: 'Mod+Alt+Shift+Digit0', label: '默认外观' },
  ],
  browser: [
    ...digits('Alt+', 1, 9).map(chord => ({ chord, label: '跳到第 N 个会话' })),
    ...digits('Alt+Shift+', 1, 4).map(chord => ({ chord, label: 'Harness · 模型 · 思考 · 权限' })),
    { chord: 'Mod+Enter', label: '允许选中的请求' },
    { chord: 'Mod+KeyZ', label: '撤销归档' },
    { chord: 'Mod+Alt+Shift+Digit0', label: '默认外观' },
  ],
}

/** The system's own keys on a Mac, in every client. */
export const SYSTEM_RESERVED: readonly ShortcutChord[] = [
  'Mod+Space',
  'Mod+Alt+Space',
  'Mod+Tab',
  'Mod+Shift+Tab',
  'Mod+Backquote',
  'Mod+KeyQ',
  'Mod+KeyH',
  'Mod+Alt+KeyH',
  'Mod+KeyM',
  'Mod+Alt+KeyD',
  'Mod+Alt+Escape',
  'Mod+Shift+Digit3',
  'Mod+Shift+Digit4',
  'Mod+Shift+Digit5',
]

/** A browser's own: tabs, windows, history, address bar, editing, zoom, developer tools, print and save. */
export const BROWSER_RESERVED: readonly ShortcutChord[] = [
  'Mod+KeyT',
  'Mod+Shift+KeyT',
  'Mod+KeyW',
  'Mod+Shift+KeyW',
  'Mod+KeyN',
  'Mod+Shift+KeyN',
  'Mod+KeyL',
  'Mod+KeyR',
  'Mod+Shift+KeyR',
  'Mod+KeyD',
  'Mod+Shift+KeyD',
  'Mod+KeyY',
  'Mod+KeyJ',
  'Mod+KeyP',
  'Mod+KeyS',
  'Mod+KeyO',
  'Mod+KeyU',
  'Mod+KeyG',
  'Mod+Shift+KeyG',
  'Mod+KeyE',
  'Mod+KeyC',
  'Mod+KeyV',
  'Mod+KeyX',
  'Mod+KeyA',
  'Mod+Shift+KeyA',
  'Mod+Shift+KeyZ',
  'Mod+Shift+KeyB',
  'Mod+Shift+KeyO',
  'Mod+Equal',
  'Mod+Shift+Equal',
  'Mod+Minus',
  'Mod+Digit0',
  ...digits('Mod+', 1, 9),
  'Mod+Shift+KeyI',
  'Mod+Shift+KeyJ',
  'Mod+Shift+KeyC',
  'Mod+Alt+KeyI',
  'Mod+Alt+KeyJ',
  'Mod+Alt+KeyC',
  'Mod+Alt+KeyU',
  'Mod+BracketLeft',
  'Mod+BracketRight',
  'Mod+ArrowLeft',
  'Mod+ArrowRight',
  'Alt+ArrowLeft',
  'Alt+ArrowRight',
  'Mod+Alt+ArrowLeft',
  'Mod+Alt+ArrowRight',
]

/** The desktop app's menu bar (`apps/desktop/src/menu.cjs`): its roles' keys. Code and 我的 Agent are menu items too, and follow their bindings. */
export const MENU_RESERVED: readonly ShortcutChord[] = [
  'Mod+KeyQ',
  'Mod+KeyH',
  'Mod+Alt+KeyH',
  'Mod+KeyZ',
  'Mod+Shift+KeyZ',
  'Mod+KeyX',
  'Mod+KeyC',
  'Mod+KeyV',
  'Mod+KeyA',
  'Mod+KeyR',
  'Mod+Alt+KeyI',
  'Mod+Digit0',
  'Mod+Equal',
  'Mod+Shift+Equal',
  'Mod+Minus',
  'Mod+KeyM',
  'Mod+KeyW',
]

export type ShortcutsDocument = {
  schema: typeof SHORTCUTS_SCHEMA
  client: ShortcutClient
  /** Only the actions bound to other keys than their default; absent, the default. */
  bindings: Partial<Record<ShortcutAction, ShortcutChord>>
}

export type ShortcutRefusal =
  | { kind: 'invalid' }
  | { kind: 'unavailable' }
  | { kind: 'system' }
  | { kind: 'browser' }
  | { kind: 'menu' }
  | { kind: 'fixed'; label: string }
  | { kind: 'conflict'; action: ShortcutAction }

/** What a refusal says, naming the action that already has the keys. */
export function refusalText(refusal: ShortcutRefusal): string {
  switch (refusal.kind) {
    case 'invalid':
      return '要同时按 ⌘ 或 ⌥（Ctrl 或 Alt）'
    case 'unavailable':
      return '这里没有这个操作'
    case 'system':
      return '系统保留'
    case 'browser':
      return '浏览器保留'
    case 'menu':
      return '菜单占用'
    case 'fixed':
      return `已用于「${refusal.label}」`
    case 'conflict':
      return `已用于「${SHORTCUT_ACTION_LABELS[refusal.action]}」`
  }
}

/** The keys each action has on this client, its own binding or else its default. */
export function effectiveShortcuts(
  client: ShortcutClient,
  bindings: Partial<Record<ShortcutAction, ShortcutChord>>,
): Map<ShortcutAction, ShortcutChord> {
  const result = new Map<ShortcutAction, ShortcutChord>()
  for (const action of SHORTCUT_ACTIONS) {
    const own = DEFAULT_SHORTCUTS[action][client]
    if (own === null) continue
    result.set(action, bindings[action] ?? own)
  }
  return result
}

/**
 * Why `action` may not take `chord` on this client, given the other bindings; null when it may. An action's own default
 * is always accepted: some defaults predate the reserved lists (⌘W closes a file tab in the desktop app, where the menu's
 * 关闭窗口 has the same keys), and taking a default back is a reset.
 */
export function shortcutRefusal(
  client: ShortcutClient,
  bindings: Partial<Record<ShortcutAction, ShortcutChord>>,
  action: ShortcutAction,
  chord: ShortcutChord,
): ShortcutRefusal | null {
  const parsed = parseChord(chord)
  if (!parsed || formatChord(parsed) !== chord) return { kind: 'invalid' }
  const own = DEFAULT_SHORTCUTS[action][client]
  if (own === null) return { kind: 'unavailable' }
  for (const [other, keys] of effectiveShortcuts(client, bindings))
    if (other !== action && keys === chord) return { kind: 'conflict', action: other }
  const fixed = FIXED_SHORTCUTS[client].find(entry => entry.chord === chord)
  if (fixed) return { kind: 'fixed', label: fixed.label }
  if (chord === own) return null
  if (SYSTEM_RESERVED.includes(chord)) return { kind: 'system' }
  if (client === 'browser' && BROWSER_RESERVED.includes(chord)) return { kind: 'browser' }
  if (client === 'desktop' && MENU_RESERVED.includes(chord)) return { kind: 'menu' }
  return null
}

/** How many unknown names one refusal repeats. */
const ISSUE_NAMES = 4

export interface ShortcutsIssue {
  field: string
  message: string
}

/** Every reason the document is refused: an unknown field or action, a chord outside the grammar, a reserved chord or two actions on one chord. */
export function shortcutsIssues(value: unknown): ShortcutsIssue[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [{ field: '', message: '快捷键文档必须是一个对象。' }]
  const doc = value as Record<string, unknown>
  const issues: ShortcutsIssue[] = []
  // A refusal names at most a few unknown fields, each cut short: a document is not echoed back.
  const unknown = Object.keys(doc).filter(key => key !== 'schema' && key !== 'client' && key !== 'bindings')
  for (const key of unknown.slice(0, ISSUE_NAMES)) issues.push({ field: key.slice(0, 40), message: `未知字段「${key.slice(0, 40)}」。` })
  if (doc.schema !== SHORTCUTS_SCHEMA) issues.push({ field: 'schema', message: '不支持这个快捷键文档版本。' })
  if (!SHORTCUT_CLIENTS.includes(doc.client as ShortcutClient))
    issues.push({ field: 'client', message: '客户端只能是 desktop 或 browser。' })
  const bindings = doc.bindings
  if (typeof bindings !== 'object' || bindings === null || Array.isArray(bindings)) {
    issues.push({ field: 'bindings', message: 'bindings 必须是一个对象。' })
    return issues
  }
  if (issues.length) return issues
  const client = doc.client as ShortcutClient
  const entries = Object.entries(bindings)
  let unnamed = 0
  for (const [action, chord] of entries) {
    const field = `bindings.${action.slice(0, 40)}`
    if (!SHORTCUT_ACTIONS.includes(action as ShortcutAction)) {
      if (unnamed++ < ISSUE_NAMES) issues.push({ field, message: `未知的操作「${action.slice(0, 40)}」。` })
      continue
    }
    if (typeof chord !== 'string') {
      issues.push({ field, message: '按键必须是文字。' })
      continue
    }
    const refusal = shortcutRefusal(client, bindings as Partial<Record<ShortcutAction, string>>, action as ShortcutAction, chord)
    if (refusal) issues.push({ field, message: `${SHORTCUT_ACTION_LABELS[action as ShortcutAction]}：${refusalText(refusal)}` })
    else if (chord === DEFAULT_SHORTCUTS[action as ShortcutAction][client])
      issues.push({ field, message: `${SHORTCUT_ACTION_LABELS[action as ShortcutAction]}：和默认相同，不用写入。` })
  }
  return issues
}

/** What the Host holds for one device: revision 0 and no document until it first saves one. */
export interface ShortcutsState {
  revision: number
  doc: ShortcutsDocument | null
}

export interface ShortcutsReceipt extends ShortcutsState {
  requestId: string
  applied: number
  replayed: boolean
}
