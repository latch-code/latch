'use strict'
// The macOS menu bar: the app menu with 「检查更新…」, then Edit, View (with Code, 我的 Agent and 用默认外观打开) and Window.

const { isAppUrl } = require('./proxy.cjs')

/**
 * The menu bar template for `Menu.buildFromTemplate`. The developer tools item exists only in a development run, as
 * the window's own `devTools` does. Code and 我的 Agent go to that place in the focused window, with the keys the page
 * itself answers to (⇧⌘1, ⇧⌘2). They start disabled: main enables them while the focused window's page has said it has
 * the two places (`SPACE_ITEMS`). 「用默认外观打开」 is always on: it is the way back when a customised page cannot be
 * used, so it asks nothing of the page.
 * @param {{ packaged: boolean, onCheckForUpdates: () => void, onSpace?: (space: 'code' | 'agents') => void, onSafeMode?: () => void }} input
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
function menuTemplate({ packaged, onCheckForUpdates, onSpace = () => {}, onSafeMode = () => {} }) {
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
        { label: 'Code', id: 'space-code', accelerator: 'Shift+CmdOrCtrl+1', enabled: false, click: () => onSpace('code') },
        { label: '我的 Agent', id: 'space-agents', accelerator: 'Shift+CmdOrCtrl+2', enabled: false, click: () => onSpace('agents') },
        { type: 'separator' },
        { label: '用默认外观打开', id: 'safe-mode', click: () => onSafeMode() },
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

/** The menu items main enables only for a page that has Code and 我的 Agent. */
const SPACE_ITEMS = ['space-code', 'space-agents']

/**
 * Which pages have said they have the two places, and the items' state for the focused one. A page's word holds until
 * its window loads another document: `did-navigate` fires for a top-level, cross-document navigation only, so a frame
 * (an 应用 page, a preview) or a same-document history entry (a phone layer's pushState) leaves it standing; the page
 * says it again once the new document subscribes.
 * @param {{ focused: () => import('electron').WebContents | null | undefined, item: (id: string) => { enabled: boolean } | null | undefined }} input
 */
function spaceMenu({ focused, item }) {
  const pages = new WeakSet()
  const watched = new WeakSet()
  const sync = () => {
    const contents = focused()
    const enabled = Boolean(contents && pages.has(contents))
    for (const id of SPACE_ITEMS) {
      const entry = item(id)
      if (entry) entry.enabled = enabled
    }
  }
  /** @param {import('electron').WebContents} contents @param {boolean} ready */
  const ready = (contents, ready) => {
    if (!watched.has(contents)) {
      watched.add(contents)
      contents.on('did-navigate', () => {
        pages.delete(contents)
        sync()
      })
    }
    if (ready) pages.add(contents)
    else pages.delete(contents)
    sync()
  }
  return { ready, sync }
}

/**
 * Where 「用默认外观打开」 sends a window: the page it shows, with `#safe` as its fragment. The page reads the fragment
 * before it renders, shows the default look and takes the fragment out of the address; a fragment is never sent to a
 * Host. The address stays the window's own: only a Latch page of this app (`latch://app/link/…`, or another computer's
 * `latch://h-<hostId>/link/…`) gets one, and anything else is left alone.
 * @param {string} current
 * @param {string} [home] the owning window's Host source
 * @returns {string | null}
 */
function safeModeUrl(current, home) {
  let url
  try {
    url = new URL(current)
  } catch {
    return null
  }
  if (!/^(?:app|h-[a-z2-7]{52})$/u.test(url.hostname) || !isAppUrl(current, home ?? url.hostname) || !url.pathname.startsWith('/link/'))
    return null
  url.hash = 'safe'
  return url.href
}

/**
 * 用默认外观打开, for one window: its page gets `#safe` and is loaded again, so it reads the fragment before it renders.
 * Nothing is asked of the page's own script, which may be what failed. A change of fragment alone is a move inside the
 * same document. Reload only if the main frame reaches that exact address on the same computer.
 * @param {Pick<import('electron').WebContents, 'getURL' | 'on' | 'removeListener' | 'loadURL' | 'reloadIgnoringCache' | 'isDestroyed'> | null | undefined} contents
 * @param {{ home?: string, wait?: (run: () => void, ms: number) => unknown }} [options]
 * @returns {boolean} whether the window was sent anywhere
 */
function openSafeMode(contents, { home, wait = setTimeout } = {}) {
  const target = contents && !contents.isDestroyed() ? safeModeUrl(contents.getURL(), home) : null
  if (!contents || !target) return false
  let done = false
  const reached = () => !contents.isDestroyed() && contents.getURL() === target
  /** @param {boolean} shouldReload */
  const finish = shouldReload => {
    if (done) return
    done = true
    contents.removeListener('did-navigate-in-page', landed)
    if (shouldReload && reached()) contents.reloadIgnoringCache()
  }
  /** @type {(event: import('electron').Event, url: string, isMainFrame: boolean) => void} */
  const landed = (_event, url, isMainFrame) => {
    if (isMainFrame && url === target && reached()) finish(true)
  }
  contents.on('did-navigate-in-page', landed)
  void contents.loadURL(target).then(
    () => {
      if (reached()) finish(true)
    },
    () => finish(false),
  )
  wait(() => finish(true), 1_000)
  return true
}

module.exports = { menuTemplate, SPACE_ITEMS, spaceMenu, safeModeUrl, openSafeMode }
