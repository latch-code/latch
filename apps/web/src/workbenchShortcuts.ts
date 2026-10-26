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
  | { nth: number }
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
  { action: 'previous', label: '上一个会话', desktop: '⌘[', browser: 'Alt [' },
  { action: 'next', label: '下一个会话', desktop: '⌘]', browser: 'Alt ]' },
  { action: 'help', label: '键盘快捷键', desktop: '⌘/', browser: 'Alt /' },
  { action: 'compose', label: '聚焦输入框', desktop: '⌘L', browser: 'Alt L' },
  { action: 'file-search', label: '查找项目文件', desktop: '⌘P', browser: 'Alt P' },
  { action: 'close-file', label: '关闭当前文件', desktop: '⌘W', browser: 'Alt W' },
  { action: 'files', label: '浏览文件 / 切换文件标签', desktop: '⇧⌘E', browser: 'Alt Shift E' },
] as const
/** Browser bindings avoid its new-window, close-tab, history and address-bar shortcuts. */
export function workbenchShortcut(event: KeyStroke, desktop: boolean): WorkbenchAction | null {
  if (event.isComposing) return null
  const modifier = desktop ? (event.metaKey || event.ctrlKey) && !event.altKey : event.altKey && !event.metaKey && !event.ctrlKey
  if (!modifier) return null
  if (/^Digit[1-9]$/u.test(event.code) && !event.shiftKey) return { nth: Number(event.code.slice(-1)) - 1 }
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
  }
  return actions[event.code] ?? null
}
