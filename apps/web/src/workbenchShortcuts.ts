export type WorkbenchAction =
  | 'new'
  | 'sidebar'
  | 'previous'
  | 'next'
  | 'help'
  | 'files'
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
export const workbenchBindings = [
  { action: 'new', label: '新建会话', desktop: '⌘N', browser: 'Alt N' },
  { action: 'sidebar', label: '展开或收起侧栏', desktop: '⌘B', browser: 'Alt B' },
  { action: 'side-panel', label: '展开或收起侧边面板', desktop: '⌥⌘B', browser: 'Alt Shift B' },
  { action: 'entry', label: '切换到会话、Agent、自动化、插件', desktop: '⌘1 – ⌘4', browser: 'Alt 1 – Alt 4' },
  { action: 'settings', label: '打开设置', desktop: '⌘,', browser: 'Alt ,' },
  { action: 'previous', label: '上一个会话', desktop: '⌘[', browser: 'Alt [' },
  { action: 'next', label: '下一个会话', desktop: '⌘]', browser: 'Alt ]' },
  { action: 'help', label: '键盘快捷键', desktop: '⌘/', browser: 'Alt /' },
  { action: 'compose', label: '聚焦输入框', desktop: '⌘L', browser: 'Alt L' },
  { action: 'file-search', label: '查找项目文件', desktop: '⌘P', browser: 'Alt P' },
  { action: 'close-file', label: '关闭当前文件', desktop: '⌘W', browser: 'Alt W' },
  { action: 'files', label: '浏览文件 / 切换文件标签', desktop: '⇧⌘E', browser: 'Alt Shift E' },
] as const
const RAIL_DIGITS: Partial<Record<string, 'sessions' | 'agents' | 'automations' | 'plugins'>> = {
  Digit1: 'sessions',
  Digit2: 'agents',
  Digit3: 'automations',
  Digit4: 'plugins',
}
/** What still shows over a page entry, which hides the session's columns: moving between entries, and what opens above it. */
export function shortcutWorksOnPage(action: WorkbenchAction): boolean {
  return typeof action === 'object' || action === 'new' || action === 'sidebar' || action === 'help' || action === 'settings'
}
/** Browser bindings avoid its new-window, close-tab, history and address-bar shortcuts. */
export function workbenchShortcut(event: KeyStroke, desktop: boolean): WorkbenchAction | null {
  if (event.isComposing) return null
  if (desktop && event.code === 'KeyB' && (event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey) return 'side-panel'
  const modifier = desktop ? (event.metaKey || event.ctrlKey) && !event.altKey : event.altKey && !event.metaKey && !event.ctrlKey
  if (!modifier) return null
  if (!desktop && event.code === 'KeyB' && event.shiftKey) return 'side-panel'
  const entry = RAIL_DIGITS[event.code]
  if (entry && !event.shiftKey) return { entry }
  if (event.code === 'KeyE' && event.shiftKey) return 'files'
  if (event.shiftKey) return null
  const actions: Partial<Record<string, WorkbenchAction>> = {
    KeyN: 'new',
    KeyB: 'sidebar',
    BracketLeft: 'previous',
    BracketRight: 'next',
    Slash: 'help',
    KeyP: 'file-search',
    KeyW: 'close-file',
    KeyL: 'compose',
    Comma: 'settings',
  }
  return actions[event.code] ?? null
}
