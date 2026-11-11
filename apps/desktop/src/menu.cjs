'use strict'
// The macOS menu bar: the app menu with 「检查更新…」, then Edit, View and Window.

/**
 * The menu bar template for `Menu.buildFromTemplate`. The developer tools item exists only in a development run, as
 * the window's own `devTools` does.
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
function menuTemplate({ packaged, onCheckForUpdates }) {
  return [
    {
      label: 'Latch',
      submenu: [
        { role: 'about', label: '关于 Latch' },
        { label: '检查更新…', id: 'check-for-updates', click: () => onCheckForUpdates() },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 Latch' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 Latch' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '显示',
      submenu: [
        { role: 'reload', label: '重新载入' },
        ...(packaged ? [] : [/** @type {const} */ ({ role: 'toggleDevTools', label: '开发者工具' })]),
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏幕' },
      ],
    },
    {
      label: '窗口',
      role: 'windowMenu',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { role: 'close', label: '关闭窗口' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' },
      ],
    },
  ]
}

module.exports = { menuTemplate }
