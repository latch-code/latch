export type WorkbenchAction =
  | 'new'
  | 'sidebar'
  | 'previous'
  | 'next'
  | 'shortcuts'
  | 'files'
  | 'changes'
  | 'file-search'
  | 'close-file'
  | 'compose'
  | 'side-panel'
  | 'settings'
  | { entry: 'sessions' | 'agents' | 'automations' | 'plugins' }
interface KeyStroke {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}

/**
 * Every shortcut that works, with the keys of each kind of client: 设置 › 快捷键 and the palette show this client's only.
 * `Mod` in a browser binding is ⌘ on a Mac and Ctrl elsewhere. Browser bindings avoid its new-window, close-tab, history
 * and address-bar shortcuts.
 */
const SHORTCUTS = [
  { id: 'sessions', label: '会话', desktop: '⌘1', browser: 'Alt 1' },
  { id: 'agents', label: 'Agent', desktop: '⌘2', browser: 'Alt 2' },
  { id: 'automations', label: '自动化', desktop: '⌘3', browser: 'Alt 3' },
  { id: 'plugins', label: '插件', desktop: '⌘4', browser: 'Alt 4' },
  { id: 'settings', label: '设置', desktop: '⌘,', browser: 'Alt ,' },
  { id: 'new', label: '新会话', desktop: '⌘N', browser: 'Alt N' },
  { id: 'palette', label: '搜索', desktop: '⌘K', browser: 'Mod K' },
  { id: 'sidebar', label: '收起或展开侧栏', desktop: '⌘B', browser: 'Alt B' },
  { id: 'side-panel', label: '侧边面板', desktop: '⌥⌘B', browser: 'Alt Shift B' },
  { id: 'changes', label: '变更', desktop: '⌘D', browser: 'Alt D' },
  { id: 'find', label: '在会话中查找', desktop: '⌘F', browser: 'Mod F' },
  { id: 'find-step', label: '下一个、上一个匹配', desktop: '⏎ · ⇧⏎', browser: 'Enter · Shift Enter' },
  { id: 'file-search', label: '搜索文件', desktop: '⌘P', browser: 'Alt P' },
  { id: 'files', label: '浏览文件、切换文件标签', desktop: '⇧⌘E', browser: 'Alt Shift E' },
  { id: 'close-file', label: '关闭当前文件', desktop: '⌘W', browser: 'Alt W' },
  { id: 'quick-look', label: '快速查看预览中的文件', desktop: 'Space', browser: null },
  { id: 'previous', label: '上一个会话', desktop: '⇧⌘[', browser: 'Alt [' },
  { id: 'next', label: '下一个会话', desktop: '⇧⌘]', browser: 'Alt ]' },
  { id: 'next-approval', label: '下一个等你处理的请求', desktop: '⌥⌘A', browser: 'Alt Shift A' },
  { id: 'decide', label: '允许、拒绝选中的请求', desktop: '⌘⏎ · esc', browser: 'Mod Enter · Esc' },
  { id: 'compose', label: '聚焦输入框', desktop: '⌘L', browser: 'Alt L' },
  { id: 'recall', label: '空输入框取回上一条消息', desktop: '↑', browser: '↑' },
  { id: 'stop', label: '在输入框里停止运行', desktop: 'esc esc', browser: 'Esc Esc' },
  { id: 'undo-archive', label: '撤销归档', desktop: '⌘Z', browser: 'Mod Z' },
  { id: 'shortcuts', label: '快捷键', desktop: '⌘/', browser: 'Alt /' },
] as const

export type ShortcutId = (typeof SHORTCUTS)[number]['id']

const onMac = () => /Mac/u.test(navigator.platform)

/** The keys on this kind of client; null for what it cannot do. */
export function shortcutKeys(id: ShortcutId, desktop: boolean, mac: boolean = onMac()): string | null {
  const row = SHORTCUTS.find(item => item.id === id)!
  if (desktop) return row.desktop
  return row.browser?.replace(/Mod /gu, mac ? '⌘' : 'Ctrl ') ?? null
}

export function shortcutRows(desktop: boolean, mac: boolean = onMac()): Array<{ id: ShortcutId; label: string; keys: string }> {
  return SHORTCUTS.flatMap(({ id, label }) => {
    const keys = shortcutKeys(id, desktop, mac)
    return keys === null ? [] : [{ id, label, keys }]
  })
}

/** A shortcut as the keys to draw: each alternative, split into its keys. */
export function shortcutCaps(keys: string): string[][] {
  return keys.split(' · ').map(alternative => alternative.match(/[⌘⇧⌥⌃]|[^\s⌘⇧⌥⌃]+/gu) ?? [])
}

const RAIL_DIGITS: Partial<Record<string, 'sessions' | 'agents' | 'automations' | 'plugins'>> = {
  Digit1: 'sessions',
  Digit2: 'agents',
  Digit3: 'automations',
  Digit4: 'plugins',
}
/** What still shows over a page entry, which hides the session's columns: moving between entries, and what opens above it. */
export function shortcutWorksOnPage(action: WorkbenchAction): boolean {
  return typeof action === 'object' || action === 'new' || action === 'sidebar' || action === 'shortcuts' || action === 'settings'
}
export function workbenchShortcut(event: KeyStroke, desktop: boolean): WorkbenchAction | null {
  if (event.isComposing) return null
  if (desktop && event.code === 'KeyB' && (event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey) return 'side-panel'
  const modifier = desktop ? (event.metaKey || event.ctrlKey) && !event.altKey : event.altKey && !event.metaKey && !event.ctrlKey
  if (!modifier) return null
  if (!desktop && event.code === 'KeyB' && event.shiftKey) return 'side-panel'
  const entry = RAIL_DIGITS[event.code]
  if (entry && !event.shiftKey) return { entry }
  if (event.code === 'KeyE' && event.shiftKey) return 'files'
  // ⌘[ and ⌘] are a Mac's back and forward; moving between sessions is moving between tabs, which it shifts.
  if (event.code === 'BracketLeft' && event.shiftKey === desktop) return 'previous'
  if (event.code === 'BracketRight' && event.shiftKey === desktop) return 'next'
  if (event.shiftKey) return null
  const actions: Partial<Record<string, WorkbenchAction>> = {
    KeyN: 'new',
    KeyB: 'sidebar',
    KeyD: 'changes',
    Slash: 'shortcuts',
    KeyP: 'file-search',
    KeyW: 'close-file',
    KeyL: 'compose',
    Comma: 'settings',
  }
  return actions[event.code] ?? null
}
