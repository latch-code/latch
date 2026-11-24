import { currentLocale } from '../core/i18n.ts'

/**
 * Latch's own tools, by name: the title the Host records with each call (its source language) and its English words.
 * The Host keeps writing the first, so sessions recorded before and after read the same.
 */
const TITLES: Readonly<Record<string, readonly [recorded: string, en: string]>> = {
  list_folders: ['列出文件夹', 'List folders'],
  list_files: ['列出文件', 'List files'],
  read_file: ['读取文件', 'Read file'],
  write_file: ['写入文件', 'Write file'],
  ask_user: ['向你提问', 'Ask you'],
  write_report: ['写入报告', 'Write report'],
  long_task: ['运行长任务', 'Run long task'],
  read_conversation_reference: ['读取引用的会话', 'Read referenced conversation'],
  propose_todo: ['提议待办', 'Propose to-do'],
  propose_todos: ['提议一组待办', 'Propose to-dos'],
  propose_card: ['提议卡片修改', 'Propose card change'],
  list_members: ['查看团队成员', 'View team members'],
  send_to_members: ['给团队成员派活', 'Assign work to team members'],
  recall_memory: ['查记忆', 'Recall memory'],
  propose_memory: ['提议记忆', 'Propose memory'],
  propose_schedule: ['提议定时任务', 'Propose scheduled task'],
  browser_tabs: ['列出浏览器标签', 'List browser tabs'],
  browser_open: ['打开浏览器标签', 'Open browser tab'],
  browser_navigate: ['浏览器导航', 'Navigate browser'],
  browser_read: ['读取页面', 'Read page'],
  browser_find: ['查找元素', 'Find element'],
  browser_screenshot: ['浏览器截图', 'Browser screenshot'],
  browser_scroll: ['滚动页面', 'Scroll page'],
  browser_viewport: ['设置视口', 'Set viewport'],
  browser_console: ['读取控制台', 'Read console'],
  browser_network: ['读取网络请求', 'Read network requests'],
  browser_wait: ['等待页面', 'Wait for page'],
  browser_click: ['点击', 'Click'],
  browser_key: ['按键', 'Press key'],
  browser_select: ['选择下拉项', 'Select option'],
  browser_type: ['输入文字', 'Type text'],
  browser_close: ['关闭浏览器标签', 'Close browser tab'],
  device_list: ['列出模拟器', 'List simulators'],
  device_screenshot: ['模拟器截图', 'Simulator screenshot'],
  device_open_url: ['在模拟器上打开地址', 'Open address in simulator'],
  device_set_appearance: ['设置模拟器外观', 'Set simulator appearance'],
  device_rotate: ['旋转模拟器', 'Rotate simulator'],
  device_apps: ['列出模拟器上的 App', 'List simulator apps'],
  device_launch: ['在模拟器上启动 App', 'Launch app in simulator'],
  device_tap: ['点按模拟器', 'Tap simulator'],
  device_swipe: ['在模拟器上滑动', 'Swipe in simulator'],
  device_type_text: ['在模拟器上输入文字', 'Type text in simulator'],
  device_press_key: ['在模拟器上按键', 'Press key in simulator'],
  device_press_button: ['按模拟器的硬件按钮', 'Press simulator hardware button'],
}

const BY_RECORDED: ReadonlyMap<string, string> = new Map(Object.values(TITLES).map(([recorded, en]) => [recorded, en]))

/**
 * A recorded tool title in the interface language. Only the exact title Latch's own tool records is translated: a
 * plugin's tool of the same name with its own title, and every other title, is shown as recorded. Without a tool name
 * (a run's end and its live line carry the title alone) the title itself is looked up.
 */
export function shownToolTitle(title: string, toolName?: string): string {
  if (currentLocale() !== 'en') return title
  if (toolName === undefined) return BY_RECORDED.get(title) ?? title
  const known = Object.hasOwn(TITLES, toolName) ? TITLES[toolName] : undefined
  return known && known[0] === title ? known[1] : title
}
